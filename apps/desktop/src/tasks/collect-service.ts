/**
 * kind='collect' 采集管道（m1-insight-plan todo 7 = T-M1-04③④⑥⑦；FR-4.1~4.5、D-03 量额语义）。
 *
 * 串行四段（runWorkflow 检查点落 task_steps，恢复续跑跳过已完成步骤；无循环/并行/优先级）：
 *   ① collect-preflight  —— 适配器登录态特征探测（selfcheck 'login-entry-feature' 复用）：
 *      登录入口可见 = 未登录 → LoginGateError（不可重试控制流）→ 任务 suspended + 桌面通知
 *      引导重登（01:367）；验证码特征前置探测（命中 → 熔断介入）。
 *   ② collect-search     —— FR-4.1 三输入路由 + B-4 组合语义（DSL v1.1）：
 *      OR = planKeywordQueries 逐词分次查询，并集按 note_id 去重；AND = 单查询，
 *      详情读回后做「标题或正文必须全词出现」过滤（不过滤项计 no_result）。
 *   ③ collect-detail-batch —— 批读：日配额（DailyQuotaLedger，300 硬上限双轨）+ 节奏
 *      （PacingEngine，pacingScale 注入）+ 单条预算（Humanizer ≤8s 钩子）+ 熔断
 *      （canProceed / blockedFeatures 验证码探测 → reportCaptchaFeatureHit）+ note_id 全局去重
 *      （重复仅更新互动 + 追加 note_snapshots，FR-4.4）→ collect_run_stats 增量计数。
 *      配额触顶 → 任务 paused + remainder 落 kv_config（跨日续采；本地日 00:00 配额自动重置）。
 *   ④ collect-finalize   —— remainder/processed 清理 + first_collection_completed 遥测
 *      （kv_config 幂等位防重，经 complianceService.sendTelemetry 唯一出口）。
 *
 * 熔断联动（FR-9.5）：breaker onSuspend 由组合根注册（挂起全部 running + Notification）；
 * OPEN 态 runWorkflow 经 retryDecisionForCircuitState 切 abort-no-retry；本管道无任何
 * 代理配置触点（QA 组以 snapshotProxyConfig 深比较守卫）。
 */
import { planKeywordQueries, type AdapterDsl } from '@xinglian/protocol';
import { createItemBudget, sampleDetailRead, samplePageDwell, type Rng } from '@xinglian/humanize';
import type { CircuitBreaker, QuotaDecision } from '@xinglian/stealth-middleware';
import { runWorkflow, serialSteps, CircuitOpenAbortError } from '@xinglian/workflow';
import type { Logger } from '@xinglian/logger';
import type { StoreClient, NoteInput } from '../store';
import type { TaskRunner } from './runner';
import type { CollectAutomation } from '../browser/automation';

export const COLLECT_KIND = 'collect';

/** kv 键：跨日续采 remainder（任务暂停原因与剩余目标） */
export const collectRemainderKey = (taskId: string): string => `collect:remainder:${taskId}`;
/** kv 键：本 run 已处理笔记 id（恢复续跑去重基线，防跨进程双计数） */
export const collectProcessedKey = (taskId: string): string => `collect:processed:${taskId}`;
/** kv 键：first_collection_completed 幂等位（漏斗点只发一次） */
export const FIRST_COLLECTION_KV_KEY = 'telemetry:first_collection_completed';

/** 主题总量双轨（02:281：主题总量默认 200 可配 50–1000；日配额 300 由 DailyQuotaLedger 硬上限） */
export const COLLECT_TOTAL_DEFAULT = 200;
export const COLLECT_TOTAL_MIN = 50;
export const COLLECT_TOTAL_MAX = 1000;

export type CollectInputType = 'keyword' | 'user' | 'note_url';

export interface CollectTaskInput {
  inputType: CollectInputType;
  topicId: string;
  terms?: string[];
  operator?: 'and' | 'or';
  keyword?: string;
  userUrl?: string;
  noteUrl?: string;
  targetTotal?: number;
}

export interface CollectTaskPayload {
  inputType: CollectInputType;
  topicId: string;
  terms: string[];
  operator: 'and' | 'or';
  userUrl: string | null;
  noteUrl: string | null;
  targetTotal: number;
}

export interface CollectRemainder {
  topicId: string;
  remaining: number;
  dayKey: string;
  pausedAt: string;
  reason: string;
}

/* ------------------------------ B-4 组合语义纯函数 ------------------------------ */

/** 输入归一：keyword 便捷形态 → terms；operator 缺省 or（FR-4.1 + B-4） */
export function normalizeCollectInput(input: CollectTaskInput): CollectTaskPayload {
  const terms = input.terms ?? (input.keyword ? [input.keyword] : []);
  if (input.inputType === 'keyword' && terms.length === 0) {
    throw new Error('E-COLLECT-INPUT-INVALID: inputType=keyword 需要 keyword 或 terms');
  }
  if (input.inputType === 'user' && !input.userUrl) {
    throw new Error('E-COLLECT-INPUT-INVALID: inputType=user 需要 userUrl');
  }
  if (input.inputType === 'note_url' && !input.noteUrl) {
    throw new Error('E-COLLECT-INPUT-INVALID: inputType=note_url 需要 noteUrl');
  }
  const targetTotal = input.targetTotal ?? COLLECT_TOTAL_DEFAULT;
  if (!Number.isInteger(targetTotal) || targetTotal < COLLECT_TOTAL_MIN || targetTotal > COLLECT_TOTAL_MAX) {
    throw new Error(`E-COLLECT-INPUT-INVALID: targetTotal 须为 ${COLLECT_TOTAL_MIN}–${COLLECT_TOTAL_MAX} 整数（02:281 双轨量额）`);
  }
  return {
    inputType: input.inputType,
    topicId: input.topicId,
    terms,
    operator: input.operator ?? 'or',
    userUrl: input.userUrl ?? null,
    noteUrl: input.noteUrl ?? null,
    targetTotal,
  };
}

/** B-4 查询计划折叠（protocol.planKeywordQueries 采集侧薄壳） */
export function planCollectQueries(payload: Pick<CollectTaskPayload, 'terms' | 'operator'>): ReturnType<typeof planKeywordQueries> {
  return planKeywordQueries({ terms: payload.terms, operator: payload.operator });
}

/** 多批次并集按 note_id 去重（OR 语义；保序 = 首见序） */
export function mergeNoteIdBatches(batches: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const batch of batches) {
    for (const noteId of batch) {
      if (!seen.has(noteId)) {
        seen.add(noteId);
        merged.push(noteId);
      }
    }
  }
  return merged;
}

const ASCII_TERM = /^[a-zA-Z0-9][a-zA-Z0-9_'-]*$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termInText(term: string, text: string | null): boolean {
  if (!text) return false;
  if (ASCII_TERM.test(term)) {
    // 西文全词（词界、大小写不敏感）；中文等无词界文字按子串口径（B-4「必须全词出现」）
    return new RegExp(`(^|[^A-Za-z0-9_'-])${escapeRegExp(term)}([^A-Za-z0-9_'-]|$)`, 'i').test(text);
  }
  return text.includes(term);
}

/** AND 过滤：每个词项都出现在标题或正文（B-4：单查询 + 标题正文全词过滤） */
export function allTermsMatch(terms: readonly string[], title: string | null, content: string | null): boolean {
  return terms.every((term) => termInText(term, title) || termInText(term, content));
}

/** 笔记链接 → note id（xhs /explore/<id> 与 ?note=<id> 形态） */
export function extractNoteIdFromUrl(url: string): string | null {
  const match = /(?:\/explore\/|\/discovery\/item\/|[?&]note=)([0-9a-fA-F]{16,32})/.exec(url);
  return match ? (match[1] as string) : null;
}

/* ------------------------------ 控制流信号（不可重试） ------------------------------ */

/** preflight 登录态探测失败：任务 suspended + 通知引导重登（非步骤失败，禁重试） */
export class LoginGateError extends Error {
  readonly code = 'E-COLLECT-LOGIN-REQUIRED';
  constructor(message: string) {
    super(message);
    this.name = 'LoginGateError';
  }
}

/** 配额触顶跨日暂停：任务 paused + remainder 已落（非步骤失败，禁重试） */
export class QuotaPausedSignal extends Error {
  readonly code = 'E-COLLECT-QUOTA-PAUSED';
  constructor() {
    super('quota-exhausted：日配额触顶，任务已暂停（跨日续采）');
    this.name = 'QuotaPausedSignal';
  }
}

/**
 * 报告闸门控制流信号（m1-insight-plan todo 11 = T-M1-06②；02:274 E 步人工确认）：
 * 报告步骤的前置检查不通过（如 LLM Key 未配置）→ 任务转 awaiting_user（人工补齐后 resume
 * 重跑 collect-report 步骤）。非步骤失败（禁重试），gate 两值枚举见 report-service.GATE_TYPES。
 */
export class CollectReportGateSignal extends Error {
  readonly code = 'E-COLLECT-REPORT-GATE';
  constructor(readonly gate: 'llm_key_config', message: string) {
    super(message);
    this.name = 'CollectReportGateSignal';
  }
}

/** 报告步骤上下文（组合根 report-service 注入消费；S9 边界：步骤状态仍落 task_steps） */
export interface CollectReportStepContext {
  readonly taskId: string;
  readonly payload: CollectTaskPayload;
  readonly logger: Logger;
}

export interface CollectServiceDeps {
  readonly store: Pick<
    StoreClient,
    | 'whenReady'
    | 'getTask'
    | 'listSteps'
    | 'upsertStep'
    | 'listNotes'
    | 'upsertNote'
    | 'upsertCollectRunStats'
    | 'getCollectRunStats'
    | 'kvGet'
    | 'kvSet'
    | 'kvDel'
    | 'appendCircuitEvent'
  >;
  readonly runner: TaskRunner;
  readonly logger: Logger;
  /** 自动化工厂（组合根绑定：真实 CDP 或 fixture mock） */
  readonly createAutomation: () => CollectAutomation;
  /** 已激活适配包 DSL 提供者（组合根持有 holder；active 包后台加载完成后切换） */
  readonly adapter: () => Pick<AdapterDsl, 'selectors' | 'selfcheck' | 'blockedFeatures'>;
  readonly breaker: CircuitBreaker;
  /** 日配额账本（DailyQuotaLedger('collect')，kv_config 持久化） */
  readonly quota: { consume(n?: number): Promise<QuotaDecision>; remaining(): Promise<number> };
  /** 遥测唯一出口（complianceService.sendTelemetry；只调用不修改合规模块） */
  readonly sendTelemetry?: (event: { name: string; payload?: unknown }) => Promise<unknown>;
  /**
   * 报告步骤钩子（m1-insight-plan todo 11 = T-M1-06②组合接线；main/report-service 注入）：
   * 清洗落库完成后生成八章报告 → reports 落库 → 任务转 awaiting_user 关键词闸门。
   * 缺省 = 不追加 collect-report 步骤（todo 7 四步管道原样；e2e/dev seam XINGLIAN_REPORT_STEP=off）。
   */
  readonly reportStep?: (ctx: CollectReportStepContext) => Promise<unknown>;
  /**
   * 爆款清单步骤钩子（M2 产品卡② = FR-4.7；main/viral-service 注入）：
   * finalize 之后、report 之前重算主题内确定性热度 TopN 快照（全自动档附送单次 LLM 解读）。
   * 缺省 = 不追加 collect-viral 步骤（单测/fixture 场景）。
   */
  readonly viralStep?: (ctx: CollectReportStepContext) => Promise<unknown>;
  /** 桌面通知（Electron Notification；组合根注入） */
  readonly notify?: (title: string, body: string) => void;
  readonly now?: () => Date;
  readonly rng?: Rng;
  /** 节奏缩放（生产 1；测试/e2e 注入 0 消除真实等待） */
  readonly pacingScale?: number;
}

export class CollectService {
  private readonly deps: CollectServiceDeps;
  private readonly now: () => Date;
  private readonly rng: () => number;
  private readonly pacingScale: number;
  private automation: CollectAutomation | null = null;

  constructor(deps: CollectServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.rng = deps.rng ?? (() => Math.random());
    this.pacingScale = deps.pacingScale ?? 1;
    deps.runner.registerKind(COLLECT_KIND, (ctx) => this.runPipeline(ctx.taskId, ctx.logger, ctx.shouldStop));
  }

  /** 创建并启动 collect 任务（FR-4.1 三种输入；targetTotal 双轨校验在归一化内） */
  async start(input: CollectTaskInput): Promise<string> {
    await this.deps.store.whenReady();
    const payload = normalizeCollectInput(input);
    if (this.deps.breaker.state === 'OPEN') {
      throw new Error('E-COLLECT-CIRCUIT-OPEN: 熔断 OPEN 态禁止新采集任务（FR-9.5）');
    }
    return this.deps.runner.startWithKind(COLLECT_KIND, { collect: payload });
  }

  /** 跨日续采扫描（应用启动 + collect:remainders 通道；paused + 昨日及以前 remainder） */
  async scanRemainders(): Promise<Array<{ taskId: string } & CollectRemainder>> {
    await this.deps.store.whenReady();
    const todayKey = localDateKeyOf(this.now());
    const tasks = await this.deps.runner.listTaskViews();
    const out: Array<{ taskId: string } & CollectRemainder> = [];
    for (const task of tasks) {
      if (task.kind !== COLLECT_KIND || task.status !== 'paused') continue;
      const raw = await this.deps.store.kvGet(collectRemainderKey(task.id));
      if (!raw || typeof raw !== 'string') continue;
      try {
        const remainder = JSON.parse(raw) as CollectRemainder;
        // 换日才列入「继续采集」；同日暂停可直接 resume，无需续采提示
        if (remainder.dayKey < todayKey) out.push({ taskId: task.id, ...remainder });
      } catch {
        // remainder 损坏：视为无续采面（不阻塞扫描）
      }
    }
    return out;
  }

  /** 门禁①计数面（collect:stats 通道；e2e 断言 notes/快照/计数器） */
  async getStats(runId: string): Promise<{ stats: Awaited<ReturnType<StoreClient['getCollectRunStats']>>; taskStatus: string | null }> {
    const stats = await this.deps.store.getCollectRunStats(runId);
    const task = await this.deps.runner.getTaskView(runId);
    return { stats, taskStatus: task?.status ?? null };
  }

  /* ------------------------------ 管道主体 ------------------------------ */

  private automationFor(): CollectAutomation {
    if (!this.automation) this.automation = this.deps.createAutomation();
    return this.automation;
  }

  private delayMs(ms: number): Promise<void> {
    const scaled = Math.max(0, Math.round(ms * this.pacingScale));
    return scaled === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, scaled));
  }

  /** 02 §6.1 检查点真源 = task_steps 表（恢复续跑跳过 completed 步骤） */
  private checkpointsFor(taskId: string) {
    const store = this.deps.store;
    return {
      async listCompleted(): Promise<Map<string, unknown>> {
        const map = new Map<string, unknown>();
        for (const step of await store.listSteps(taskId)) {
          if (step.status === 'completed' && step.output !== null) map.set(step.stepId, step.output);
        }
        return map;
      },
      async startStep(step: { stepId: string; seq: number; at: string }): Promise<void> {
        await store.upsertStep({ taskId, stepId: step.stepId, seq: step.seq, status: 'running', checkpointAt: step.at });
      },
      async completeStep(step: { stepId: string; seq: number; output: unknown; at: string }): Promise<void> {
        await store.upsertStep({ taskId, stepId: step.stepId, seq: step.seq, status: 'completed', output: step.output, checkpointAt: step.at });
      },
      async failStep(step: { stepId: string; seq: number; error: string; at: string }): Promise<void> {
        await store.upsertStep({ taskId, stepId: step.stepId, seq: step.seq, status: 'failed', output: { error: step.error }, checkpointAt: step.at });
      },
    };
  }

  private async runPipeline(taskId: string, logger: Logger, shouldStop: () => boolean): Promise<void> {
    const taskRow = await this.deps.store.getTask(taskId);
    const payload = (taskRow?.payload as { collect?: CollectTaskPayload } | null)?.collect;
    if (!payload) throw new Error(`collect 任务 payload 缺失: ${taskId}`);

    try {
      await runWorkflow({
        steps: serialSteps([
          { id: 'collect-preflight', run: () => this.stepPreflight(taskId, logger) },
          { id: 'collect-search', run: () => this.stepSearch(payload, logger) },
          { id: 'collect-detail-batch', run: () => this.stepDetailBatch(taskId, payload, shouldStop, logger) },
          { id: 'collect-finalize', run: () => this.stepFinalize(taskId, logger) },
          ...(this.deps.viralStep
            ? [{ id: 'collect-viral', run: () => this.deps.viralStep!({ taskId, payload, logger }) }]
            : []),
          ...(this.deps.reportStep
            ? [{ id: 'collect-report', run: () => this.deps.reportStep!({ taskId, payload, logger }) }]
            : []),
        ]),
        control: {
          shouldStop,
          yieldGate: async () => {},
          circuitState: () => this.deps.breaker.state,
          isRetryable: (error) =>
            !(error instanceof LoginGateError) &&
            !(error instanceof QuotaPausedSignal) &&
            !(error instanceof CollectReportGateSignal),
        },
        checkpoints: this.checkpointsFor(taskId),
        retry: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 },
        delay: (ms) => this.delayMs(ms),
        now: this.now,
      });
    } catch (error) {
      if (error instanceof LoginGateError) {
        // 登录态探测失败 → suspended + 通知引导重登（01:367）；resume 由用户重登后触发
        this.deps.notify?.('采集已暂停：需要登录', error.message);
        await this.deps.runner.suspend(taskId, `login-required: ${error.message}`);
        return;
      }
      if (error instanceof QuotaPausedSignal) {
        // 配额触顶已在步骤内 pause + 落 remainder；此处只吞控制流信号
        return;
      }
      if (error instanceof CollectReportGateSignal) {
        // 报告闸门（todo 11）：任务转 awaiting_user（boot 恢复原样保留）；用户补齐前置
        // 条件（如配置 LLM Key）后 resume → collect-report 步骤重跑（检查点未完成）
        this.deps.notify?.('报告生成等待人工操作', error.message);
        await this.deps.runner.awaitUser(taskId, `report-gate:${error.gate}（${error.message}）`);
        logger.automationStep('collect:report-gate', { taskId, gate: error.gate });
        return;
      }
      if (error instanceof CircuitOpenAbortError) {
        // 熔断 OPEN：onSuspend 联动挂起全部 running；此处对本任务再补一次幂等 suspend，
        // 关闭「联动在途时 drive 先写 COMPLETE」的竞态窗口（FR-9.5 不自动重试）
        await this.deps.runner.suspend(taskId, `circuit-open: ${error.decision.action}`);
        logger.systemError('collect-circuit-open-abort', { taskId, decision: error.decision.action });
        return;
      }
      throw error;
    }
  }

  /** ① preflight：登录态特征探测（selfcheck login 用例复用）+ 验证码前置探测 */
  private async stepPreflight(taskId: string, logger: Logger): Promise<Record<string, unknown>> {
    const automation = this.automationFor();
    const adapter = this.deps.adapter();
    await automation.installPageHooks();

    // blockedFeatures 验证码特征：preflight 即探测（命中 → 熔断介入，FR-9.5）
    const captchaSelectors = this.blockedFeatureSelectors(adapter);
    if (captchaSelectors.length > 0) {
      const counts = await automation.probeFeatures(captchaSelectors);
      if (captchaSelectors.some((s) => (counts[s] ?? 0) > 0)) {
        await this.deps.store.upsertCollectRunStats({ runId: taskId, captchaConsumed: 1 });
        this.deps.breaker.reportCaptchaFeatureHit(this.now());
        throw new Error('E-COLLECT-CAPTCHA-PRESENT: preflight 探测到验证码特征（熔断器已介入）');
      }
    }

    // 登录态探测：selfcheck 名含 'login' 的用例 = 登录入口特征（未登录态可见，05:88）
    const loginCase = adapter.selfcheck.find((c) => /login/i.test(c.name));
    if (loginCase) {
      const selectors = loginCase.expect.map((e) => adapter.selectors[e.selector]).filter(Boolean) as string[];
      const counts = await automation.probeFeatures(selectors);
      if (selectors.some((s) => (counts[s] ?? 0) > 0)) {
        throw new LoginGateError('登录态特征探测失败：登录入口可见（未登录）——请在受控浏览器重新登录后恢复任务');
      }
    }
    logger.automationStep('collect:preflight-ok', { taskId });
    return { ok: true, at: this.now().toISOString() };
  }

  /** ② search：FR-4.1 输入路由 + B-4 组合语义（OR 并集去重 / AND 单查询待详情过滤） */
  private async stepSearch(payload: CollectTaskPayload, logger: Logger): Promise<Record<string, unknown>> {
    const automation = this.automationFor();
    let candidates: string[];
    let queries: string[];

    if (payload.inputType === 'keyword') {
      const plan = planCollectQueries(payload);
      queries = plan.queries;
      const batches: string[][] = [];
      for (const query of plan.queries) {
        // OR = 逐词分次提交（DSL v1.1 B-4：超平台能力的组合分次检索本地合并）
        batches.push(await automation.search(query));
        await this.delayMs(samplePageDwell(this.rng));
      }
      candidates = mergeNoteIdBatches(batches);
    } else if (payload.inputType === 'user') {
      await automation.navigate(payload.userUrl as string);
      await this.delayMs(samplePageDwell(this.rng));
      queries = [payload.userUrl as string];
      candidates = await automation.search('');
    } else {
      const noteId = extractNoteIdFromUrl(payload.noteUrl as string);
      if (!noteId) throw new Error(`E-COLLECT-INPUT-INVALID: 无法从笔记链接提取 note id: ${payload.noteUrl}`);
      await automation.navigate(payload.noteUrl as string);
      queries = [payload.noteUrl as string];
      candidates = [noteId];
    }
    logger.automationStep('collect:search-done', {
      inputType: payload.inputType,
      queries: queries.length,
      candidates: candidates.length,
      operator: payload.operator,
    });
    return { candidates, queries, operator: payload.operator, terms: payload.terms, at: this.now().toISOString() };
  }

  /**
   * ③ detail 批读：配额/节奏/熔断/去重/计数（D-03 量额双轨；FR-4.4 快照语义）。
   * 控制流：配额触顶 → paused + remainder（QuotaPausedSignal）；验证码 → 熔断 OPEN
   * （abort-no-retry）；shouldStop → 安全点早退（任务态由 runner 落定）。
   */
  private async stepDetailBatch(
    taskId: string,
    payload: CollectTaskPayload,
    shouldStop: () => boolean,
    logger: Logger,
  ): Promise<Record<string, unknown>> {
    const automation = this.automationFor();
    const searchOutput = await this.searchCheckpoint(taskId);
    let candidates: string[];
    if (searchOutput && Array.isArray(searchOutput.candidates)) {
      candidates = searchOutput.candidates as string[]; // 恢复续跑：search 检查点重放，不重搜
    } else {
      candidates = (await this.stepSearch(payload, logger)).candidates as string[];
    }

    // note_id 全局去重：库内已有行 → 重复面（读回更新互动 + 追加快照，duplicate 计数）
    const existing = await this.deps.store.listNotes({ limit: 500 });
    const knownIds = new Set(existing.map((n) => n.noteId));
    // 本 run 已处理（崩溃前生命周期）：跳过且不重复计数（stats 增量语义防双计）
    const processed = await this.loadProcessed(taskId);

    const prior = await this.deps.store.getCollectRunStats(taskId);
    let budget = Math.max(0, payload.targetTotal - (prior?.completedUnique ?? 0));
    const captchaSelectors = this.blockedFeatureSelectors(this.deps.adapter());

    let fresh = 0;
    let duplicate = 0;
    let noResult = 0;

    for (const noteId of candidates) {
      if (budget <= 0) break;
      if (shouldStop()) {
        logger.automationStep('collect:detail-safety-stop', { taskId, fresh, duplicate, noResult });
        break;
      }
      if (processed.has(noteId)) continue;

      // 验证码特征探测（每条详情前；命中 → 熔断 OPEN → abort-no-retry）
      if (captchaSelectors.length > 0) {
        const counts = await automation.probeFeatures(captchaSelectors);
        if (captchaSelectors.some((s) => (counts[s] ?? 0) > 0)) {
          await this.deps.store.upsertCollectRunStats({ runId: taskId, captchaConsumed: 1 });
          this.deps.breaker.reportCaptchaFeatureHit(this.now());
          throw new Error('E-COLLECT-CAPTCHA-PRESENT: 验证码特征命中（熔断器已介入，FR-9.5 不自动重试）');
        }
      }
      if (!this.deps.breaker.canProceed()) {
        throw new Error('E-COLLECT-CIRCUIT-OPEN: 熔断 OPEN，批读中止（abort-no-retry）');
      }

      // 节奏 + 单条预算（NFR-1 ≤8s；PacingEngine，pacingScale 消除测试等待）
      await this.delayMs(samplePageDwell(this.rng));
      const itemBudget = createItemBudget(() => this.now().getTime());
      const detail = await automation.readDetail(noteId);
      itemBudget.check();
      // 空详情护栏（pilot 修复）：详情上下文不可达时字段全空——不可读样本不入库（与 B-4 no_result 同口径），
      // 杜绝空语料进入报告环节被误读为「数据受限」。
      if (detail.title === null && detail.content === null) {
        noResult += 1;
        processed.add(noteId);
        continue;
      }
      await this.delayMs(sampleDetailRead(this.rng, { contentLengthChars: detail.content?.length ?? 0 }));

      // B-4 AND：标题正文全词过滤（不过滤项计 no_result，不入库、不占采集目标）
      if (payload.operator === 'and' && payload.terms.length > 0 && !allTermsMatch(payload.terms, detail.title, detail.content)) {
        noResult += 1;
        processed.add(noteId);
        continue;
      }

      // 日配额硬上限：消费前检查（触顶 → 跨日续采暂停）
      const remainingQuota = await this.deps.quota.remaining();
      if (remainingQuota <= 0) {
        // 剩余面 = 当前位置起未处理候选数（上限 = 未耗尽预算）
        const idx = candidates.indexOf(noteId);
        const restCandidates = candidates.slice(idx).filter((id) => !processed.has(id)).length;
        const restCount = Math.min(budget, restCandidates);
        await this.deps.store.kvSet(
          collectRemainderKey(taskId),
          JSON.stringify({
            topicId: payload.topicId,
            remaining: restCount,
            dayKey: localDateKeyOf(this.now()),
            pausedAt: this.now().toISOString(),
            reason: 'quota-exhausted',
          } satisfies CollectRemainder),
        );
        // 本生命周期已采/重复/无结果一并落账（增量语义：resume 续跑只补增量）
        await this.deps.store.upsertCollectRunStats({
          runId: taskId,
          completedUnique: fresh,
          duplicate,
          noResult,
          rateLimited: restCount,
        });
        // 配额触顶入本地账本（circuit_events：熔断/配额触顶/自检失败；FR-9.5 抽查证据源）
        await this.deps.store.appendCircuitEvent({
          kind: 'quota_exhausted',
          at: this.now().toISOString(),
          meta: { runId: taskId, topicId: payload.topicId, remaining: restCount },
        });
        await this.deps.runner.pause(taskId, 'quota-exhausted（日配额触顶，跨日续采）');
        await this.saveProcessed(taskId, processed);
        logger.automationStep('collect:quota-paused', { taskId, remaining: restCount });
        throw new QuotaPausedSignal();
      }

      const note: NoteInput = {
        noteId: detail.noteId,
        title: detail.title,
        content: detail.content,
        author: detail.author,
        likes: detail.likes,
        collects: detail.collects,
        comments: detail.comments,
        tags: detail.tags,
        coverUrl: detail.coverUrl,
        imageUrls: detail.imageUrls,
        publishedAt: detail.publishedAt,
        topicId: payload.topicId,
      };
      const decision = await this.deps.quota.consume(1);
      if (!decision.allowed) continue;
      await this.deps.store.upsertNote(note);
      if (knownIds.has(noteId)) {
        duplicate += 1; // 重复采集：仅更新互动 + 追加快照（upsertNote 语义）
      } else {
        fresh += 1;
        knownIds.add(noteId);
      }
      processed.add(noteId);
      budget -= 1;
    }

    // 门禁①分母公式数据源：增量累加（worker 按列合并，幂等于恢复续跑——fresh/dup 只计本生命周期）
    await this.deps.store.upsertCollectRunStats({ runId: taskId, completedUnique: fresh, duplicate, noResult });
    await this.saveProcessed(taskId, processed);
    logger.automationStep('collect:detail-batch-done', { taskId, fresh, duplicate, noResult });
    return { fresh, duplicate, noResult, at: this.now().toISOString() };
  }

  /** ④ finalize：remainder/processed 清理 + first_collection_completed（kv 幂等 + 唯一出口） */
  private async stepFinalize(taskId: string, logger: Logger): Promise<Record<string, unknown>> {
    await this.deps.store.kvDel(collectRemainderKey(taskId));
    await this.deps.store.kvDel(collectProcessedKey(taskId));
    const stats = await this.deps.store.getCollectRunStats(taskId);
    if ((stats?.completedUnique ?? 0) > 0) {
      const fired = await this.deps.store.kvGet(FIRST_COLLECTION_KV_KEY);
      if (fired === null) {
        await this.deps.sendTelemetry?.({ name: 'first_collection_completed', payload: { runId: taskId } });
        await this.deps.store.kvSet(FIRST_COLLECTION_KV_KEY, this.now().toISOString());
        logger.userAction('collect:first-collection-telemetry', { runId: taskId });
      }
    }
    return { completedAt: this.now().toISOString() };
  }

  /** search 步骤检查点（detail-batch 重入面；真源 task_steps） */
  private async searchCheckpoint(taskId: string): Promise<Record<string, unknown> | null> {
    for (const step of await this.deps.store.listSteps(taskId)) {
      if (step.stepId === 'collect-search' && step.status === 'completed' && step.output) {
        return step.output as Record<string, unknown>;
      }
    }
    return null;
  }

  private async loadProcessed(taskId: string): Promise<Set<string>> {
    const raw = await this.deps.store.kvGet(collectProcessedKey(taskId));
    if (typeof raw !== 'string') return new Set();
    try {
      const list = JSON.parse(raw) as string[];
      return new Set(Array.isArray(list) ? list : []);
    } catch {
      return new Set();
    }
  }

  private async saveProcessed(taskId: string, processed: Set<string>): Promise<void> {
    await this.deps.store.kvSet(collectProcessedKey(taskId), JSON.stringify([...processed]));
  }

  private blockedFeatureSelectors(adapter: Pick<AdapterDsl, 'selectors' | 'blockedFeatures'>): string[] {
    const out: string[] = [];
    for (const feature of adapter.blockedFeatures) {
      for (const name of feature.selectors) {
        const css = adapter.selectors[name];
        if (css) out.push(css);
      }
    }
    return out;
  }
}

/** 本地日历日键（YYYY-MM-DD，本地时区；与 stealth-middleware localDateKey 同口径） */
export function localDateKeyOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

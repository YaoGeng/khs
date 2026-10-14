/**
 * 报告组合根服务（m1-insight-plan todo 11 = T-M1-06②组合接线；纯逻辑 electron-free 可单测）。
 *
 * 职责（02 §8.2 / 02:274 E 步 / 02:708-710 idempotency_key）：
 * - 把 report-agent（@xinglian/agents generateReport）接入桌面组合根：collect 管道
 *   collect-report 步骤 → 真实 store client Ports（insertReport / llm_calls sink / kv /
 *   complianceService.sendTelemetry 唯一出口）→ reports 落库 → collect 任务转 awaiting_user
 *   关键词确认闸门（gate 两值枚举 keyword_confirm | llm_key_config，GATE_TYPES）；
 * - ⑦章建议关键词在展示与确认前过词库黑名单（wordlist:active 指针 → scanKeywordsWithConfig，
 *   命中词剔除 + keyword_hits 留痕，FR-9.6）；
 * - 闸门确认：idempotency_key=sha256(topic+report_id) → selection 任务占位记录（queued，
 *   执行归 M2 T-M2-02，不执行选品本体）；重复确认幂等 no-op；拒绝 → cancelled；
 * - 报告/图表/导出的读面：reports 索引（kv）、报告详情、图表数据（聚类/价格带/热词，
 *   由 @xinglian/agents 统计聚类与价格提取在主进程确定性计算）。
 *
 * store client 面冻结注记（todo 6 五面同步后不可改）：闸门挂起态落 kv_config
 * （gate:pending:<taskId>）+ task_events 审计事件（REPORT_GATE_SET 的 payload_json 携带
 * gate/report_id）；reports 列表枚举落 kv 索引（report:index）——tasks/reports 行本体
 * 仍由既有列承载，行为语义与任务书 payload_json{gate,report_id} 对齐（gate:list 出口同形）。
 *
 * 遥测幂等位单调时钟注记（前序评审）：本服务写入的幂等/审计标记统一携带
 * mono=process.hrtime.bigint()（单调，不受系统墙钟跳变影响）；at（ISO 墙钟）仅作展示。
 */
import { createHash, randomUUID } from 'node:crypto';
import { clusterTexts, extractPrices, generateReport, type AgentNote, type ReportOutcome } from '@xinglian/agents';
import type { SchemaInjectionStrategy } from '@xinglian/llm-gateway';
import { KV_LLM_RPM_GLOBAL } from './usage-service';
import type { Logger } from '@xinglian/logger';
import type { StoreClient, NoteRowView } from '../store';
import type { TaskRunner } from '../tasks';
import { CollectReportGateSignal, type CollectReportStepContext } from '../tasks/collect-service';
import type { WordlistScanFacade } from './key-service';
import { GATE_ERRORS } from '../shared/channels';
import type {
  GateConfirmResult,
  GateListResult,
  GateRejectResult,
  GateView,
  KeywordFilterView,
  NotesListResult,
  ReportChartDataResult,
  ReportGetResult,
  ReportsListResult,
} from '../shared/schemas';

/** gate 类型枚举（两值；任务书口径：文档化于 GATE_TYPES） */
export const GATE_TYPES = ['keyword_confirm', 'llm_key_config'] as const;
export type GateType = (typeof GATE_TYPES)[number];

export const GATE_KEYWORD_CONFIRM: GateType = 'keyword_confirm';
export const GATE_LLM_KEY_CONFIG: GateType = 'llm_key_config';

/* ---- kv 键（kv_config 单表；前缀分段） ---- */
export const KV_REPORT_INDEX = 'report:index';
export const gatePendingKey = (taskId: string): string => `gate:pending:${taskId}`;
export const gateResolutionKey = (taskId: string): string => `gate:resolved:${taskId}`;
export const gateKeywordsKey = (taskId: string): string => `gate:keywords:${taskId}`;
export const reportMetaKey = (reportId: number): string => `report:meta:${reportId}`;
export const reportKeywordFilterKey = (reportId: number): string => `report:kwfilter:${reportId}`;

/** 报告步骤 LLM 网关构造面（生产 = LlmGateway；测试注入 fake structured） */
export interface StructuredGateway {
  structured: <T>(req: {
    system?: string;
    user: string;
    name: string;
    schema: Record<string, unknown>;
    parse: (value: unknown) => T;
    strategies?: readonly SchemaInjectionStrategy[];
    traceId?: string;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<{ value: T; strategy: string; requestCount: number; tokensIn: number; tokensOut: number }>;
}

/** BYOK 解析结果（key-service kv 形态解密后的明文；仅主进程内存） */
export interface ReportLlmConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  /** FR-2.4 备用 Key（同 provider；主 Key 401/403 时网关轮换） */
  backupKeys: string[];
  model: string;
  /** FR-2.6 全局 RPM（0=不限流；resolveLlmConfig 时从 kv llm:rpm-global 读取，改设置后下次报告生效） */
  rpmGlobal: number;
}

export interface ReportServiceDeps {
  readonly store: Pick<
    StoreClient,
    | 'whenReady'
    | 'getTask'
    | 'listTasks'
    | 'createTask'
    | 'updateTaskStatus'
    | 'listNotes'
    | 'insertReport'
    | 'getReport'
    | 'insertLlmCall'
    | 'insertKeywordHit'
    | 'kvGet'
    | 'kvSet'
    | 'kvDel'
    | 'writeTaskEvent'
  >;
  readonly runner: TaskRunner;
  readonly logger: Logger;
  /** 词库扫描消费面（wordlist:active 指针；compliance/wordlist-service） */
  readonly wordlist: WordlistScanFacade;
  /** LLM 网关工厂（组合根接 LlmGateway + llm_calls sink；测试注入 fake） */
  readonly createGateway: (config: ReportLlmConfig) => StructuredGateway;
  /** 遥测唯一出口（complianceService.sendTelemetry） */
  readonly sendTelemetry?: (event: { name: string; payload?: unknown }) => Promise<unknown>;
  /** BYOK Key 解密面（key-service 同款 kv 布局；组合根注入，明文仅主进程内存） */
  /** BYOK Key 解密面（key-service GatewayKeyEntry 同构；backupKeys 供 FR-2.4 轮换） */
  readonly readKeyEntry: (provider: string) => Promise<{ provider: string; baseUrl: string; apiKey: string; backupKeys: string[]; model: string } | null>;
  /** 去标识化本地盐（与 realrun 同语义；组合根注入持久值） */
  readonly salt: string;
  /** 聚类/筛选确定性种子 */
  readonly seed?: number;
  readonly now?: () => Date;
}

export interface ReportService {
  /** collect 管道第 5 步（collect-report）主体；注入 CollectService.reportStep */
  runCollectReportStep(ctx: CollectReportStepContext): Promise<{ gate: GateType; reportId: number | null }>;
  /** 闸门读面（awaiting_user 任务 × gate:pending kv） */
  listGates(): Promise<GateListResult>;
  /** 确认闸门：selection 占位任务（queued + idempotency_key）；重复确认幂等 no-op */
  confirmGate(taskId: string): Promise<GateConfirmResult>;
  /** 拒绝闸门：collect 任务 cancelled */
  rejectGate(taskId: string): Promise<GateRejectResult>;
  /** 报告索引（report:index kv，新→旧） */
  listReports(): Promise<ReportsListResult>;
  /** 报告详情 + ⑦章过滤面 */
  getReportView(reportId: number): Promise<ReportGetResult>;
  /** FR-5.3 图表数据（聚类气泡/价格带直方/热词云；notes 确定性计算） */
  chartData(reportId: number): Promise<ReportChartDataResult>;
  /** FR-4.6 采集列表读面（CSV 导出数据源） */
  listNotes(topicId: string | undefined, limit: number | undefined): Promise<NotesListResult>;
  /** QA failure 组专用（debug 门控装配）：注入任意报告 JSON（含缺⑧章坏样本）并登记索引 */
  insertFixtureReport(params: { topic: string; report: unknown; contentMd?: string }): Promise<{ id: number }>;
}

/* ------------------------------ 纯函数（导出供单测） ------------------------------ */

/** sha256(topic+report_id)（02:708-710 幂等键口径；':' 分隔防拼接歧义） */
export function keywordGateIdempotencyKey(topic: string, reportId: number): string {
  return createHash('sha256').update(`${topic}:${reportId}`).digest('hex');
}

/** ⑦章 bullet → 建议关键词（「词根：理由」取词根段；无分隔符取整条） */
export function keywordFromBullet(bullet: string): string {
  const head = bullet.split(/[：:]/, 1)[0]?.trim() ?? '';
  if (head.length > 0 && head.length <= 40) return head;
  return bullet.trim().slice(0, 40);
}

export type KeywordFilterOutcome = KeywordFilterView;

/**
 * ⑦章黑名单过滤（FR-9.6 / todo 10 scanner 消费口）：逐条建议词过
 * scanKeywordsWithConfig（wordlist:active），命中词剔除；每个命中经 sink 落 keyword_hits。
 * 词库未就绪 = fail-closed（allowed 清空 + note），不放行未扫描的建议词。
 */
export async function filterSelectionKeywords(
  wordlist: WordlistScanFacade,
  bullets: readonly string[],
  topicId: string | undefined,
  persistHit: (hit: { wordlistVersion: string; term: string; category?: string; topicId?: string }) => Promise<unknown>,
): Promise<KeywordFilterOutcome> {
  await wordlist.whenReady;
  const version = wordlist.activeVersion();
  if (!version) {
    return { allowed: [], removed: [], wordlistVersion: null, persisted: 0 };
  }
  const allowed: string[] = [];
  const removed: KeywordFilterView['removed'] = [];
  let persisted = 0;
  for (const bullet of bullets) {
    const keyword = keywordFromBullet(bullet);
    const hits = wordlist.scanKeywords([keyword]);
    if (hits.length === 0) {
      allowed.push(bullet);
      continue;
    }
    for (const hit of hits) {
      await persistHit({ wordlistVersion: version, term: hit.term, ...(hit.category ? { category: hit.category } : {}), ...(topicId ? { topicId } : {}) });
      persisted += 1;
    }
    removed.push({ bullet, term: hits[0]!.term, kind: hits[0]!.kind, category: hits[0]!.category ?? null });
  }
  return { allowed, removed, wordlistVersion: version, persisted };
}

function toAgentNote(note: NoteRowView): AgentNote {
  return {
    noteId: note.noteId,
    title: note.title,
    content: note.content,
    author: note.author,
    likes: note.likes,
    collects: note.collects,
    comments: note.comments,
    tags: note.tags,
    publishedAt: note.publishedAt,
    collectedAt: note.collectedAt,
  };
}

/** 单调时钟标记（遥测幂等位防墙钟跳变；前序评审注记） */
function monoNow(): string {
  return process.hrtime.bigint().toString();
}

async function readKvJson<T>(store: { kvGet(key: string): Promise<string | Buffer | null> }, key: string): Promise<T | null> {
  const raw = await store.kvGet(key);
  const text = typeof raw === 'string' ? raw : raw ? raw.toString('utf8') : null;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface GatePendingRecord {
  gate: GateType;
  reportId?: number;
  topicId?: string;
  topic?: string;
  createdAt: string;
  mono?: string;
}

interface GateResolutionRecord {
  resolution: 'confirmed' | 'rejected';
  selectionTaskId?: string;
  idempotencyKey?: string;
  at: string;
}

interface ReportIndexEntry {
  id: number;
  topic: string;
  createdAt: string;
  model: string | null;
  tokenCost: number | null;
}

/** BYOK provider 解析顺序：custom（D11 dev 真实网关）优先，其余按预设序 */
const PROVIDER_PREFERENCE = ['custom', 'deepseek', 'tongyi', 'zhipu', 'siliconflow', 'openai'] as const;

export function createReportService(deps: ReportServiceDeps): ReportService {
  const now = deps.now ?? (() => new Date());
  const seed = deps.seed ?? 20261013;

  async function resolveLlmConfig(): Promise<ReportLlmConfig | null> {
    const override = process.env.XINGLIAN_REPORT_PROVIDER?.trim();
    const order = override ? [override, ...PROVIDER_PREFERENCE.filter((p) => p !== override)] : [...PROVIDER_PREFERENCE];
    for (const provider of order) {
      const entry = await deps.readKeyEntry(provider);
      if (entry) {
        // FR-2.6：全局 RPM 随解析一并读取（kv 读经 store worker；改设置后下一次报告步骤生效）
        const rpmRaw = await deps.store.kvGet(KV_LLM_RPM_GLOBAL);
        const rpm = typeof rpmRaw === 'string' ? Number(rpmRaw) : 0;
        return {
          provider: entry.provider,
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey,
          backupKeys: entry.backupKeys,
          model: entry.model,
          rpmGlobal: Number.isFinite(rpm) && rpm > 0 ? Math.floor(rpm) : 0,
        };
      }
    }
    return null;
  }

  async function appendReportIndex(entry: ReportIndexEntry): Promise<void> {
    const index = (await readKvJson<ReportIndexEntry[]>(deps.store, KV_REPORT_INDEX)) ?? [];
    const next = [entry, ...index.filter((e) => e.id !== entry.id)].slice(0, 50);
    await deps.store.kvSet(KV_REPORT_INDEX, JSON.stringify(next));
  }

  return {
    async runCollectReportStep(ctx) {
      const { taskId, payload } = ctx;
      const llm = await resolveLlmConfig();
      if (!llm) {
        const record: GatePendingRecord = {
          gate: GATE_LLM_KEY_CONFIG,
          topicId: payload.topicId,
          createdAt: now().toISOString(),
          mono: monoNow(),
        };
        await deps.store.kvSet(gatePendingKey(taskId), JSON.stringify(record));
        throw new CollectReportGateSignal(
          'llm_key_config',
          '未检测到可用的 LLM API Key——请在「设置」配置后恢复任务重跑报告步骤（gate=llm_key_config）',
        );
      }

      const notes = await deps.store.listNotes({ topicId: payload.topicId, limit: 500 });
      if (notes.length === 0) {
        throw new Error(`E-REPORT-NO-NOTES: 主题 ${payload.topicId} 无已采集笔记，无法生成报告`);
      }

      const outcome: ReportOutcome = await generateReport(
        {
          // 箭头包一层保住 this：方法脱实例引用（.structured 裸传）会因 this=undefined
          // 在 LlmGateway.structured 内部第一段就 TypeError，两段降级链全败（e2e 实测）
          structured: (req) => deps.createGateway(llm).structured(req),
          store: {
            insertReport: async (input) => {
              const { id } = await deps.store.insertReport({ ...input, gateState: 'awaiting_keyword_confirm' });
              await appendReportIndex({ id, topic: input.topic, createdAt: now().toISOString(), model: input.model ?? null, tokenCost: input.tokenCost ?? null });
              await deps.store.kvSet(
                reportMetaKey(id),
                JSON.stringify({ topicId: payload.topicId, taskId, createdAt: now().toISOString(), mono: monoNow() }),
              );
              return { id };
            },
          },
          kv: {
            get: async (key) => await deps.store.kvGet(key),
            set: async (key, value) => {
              await deps.store.kvSet(key, typeof value === 'string' ? value : JSON.stringify(value));
            },
          },
          telemetry: {
            emit: (kind, eventPayload) => {
              void deps.sendTelemetry?.({ name: kind, payload: eventPayload }).catch(() => {});
            },
          },
        },
        {
          topic: payload.topicId,
          notes: notes.map(toAgentNote),
          model: llm.model,
          salt: deps.salt,
          seed,
          strategies: ['prompt-embedded-schema', 'regex-extraction-fallback'],
          now,
        },
      );

      if (outcome.status === 'failed') {
        // LLM 失败保持可重试（网关内部已带退避重试；workflow 层 ≤3 次后任务 failed，可重建采集续跑）
        throw new Error(`E-REPORT-GENERATION-FAILED: ${outcome.reason}`);
      }

      const keywords = await filterSelectionKeywords(
        deps.wordlist,
        outcome.report.chapters.selectionKeywords.bullets,
        payload.topicId,
        (hit) => deps.store.insertKeywordHit(hit),
      );
      await deps.store.kvSet(reportKeywordFilterKey(outcome.reportId), JSON.stringify(keywords));
      await deps.store.kvSet(gateKeywordsKey(taskId), JSON.stringify(keywords));

      const pending: GatePendingRecord = {
        gate: GATE_KEYWORD_CONFIRM,
        reportId: outcome.reportId,
        topicId: payload.topicId,
        topic: payload.topicId,
        createdAt: now().toISOString(),
        mono: monoNow(),
      };
      await deps.store.kvSet(gatePendingKey(taskId), JSON.stringify(pending));
      await deps.store.writeTaskEvent({
        taskId,
        type: 'REPORT_GATE_SET',
        fromState: 'running',
        toState: 'awaiting_user',
        payload: { gate: GATE_KEYWORD_CONFIRM, reportId: outcome.reportId, topicId: payload.topicId },
      });
      await deps.runner.awaitUser(taskId, 'keyword-confirm-gate（请在「市场洞察」确认选品关键词，02:274 E 步）');
      ctx.logger.automationStep('collect:report-gate-set', { taskId, reportId: outcome.reportId, gate: GATE_KEYWORD_CONFIRM });
      return { gate: GATE_KEYWORD_CONFIRM, reportId: outcome.reportId };
    },

    async listGates(): Promise<GateListResult> {
      await deps.store.whenReady();
      const awaiting = await deps.store.listTasks('awaiting_user');
      const gates: GateView[] = [];
      for (const task of awaiting) {
        const pending = await readKvJson<GatePendingRecord>(deps.store, gatePendingKey(task.id));
        if (!pending) continue;
        const keywords =
          pending.gate === GATE_KEYWORD_CONFIRM
            ? await readKvJson<KeywordFilterView>(deps.store, gateKeywordsKey(task.id))
            : null;
        gates.push({
          taskId: task.id,
          kind: task.kind,
          status: task.status,
          gate: pending.gate,
          reportId: pending.reportId ?? null,
          topicId: pending.topicId ?? null,
          topic: pending.topic ?? null,
          createdAt: pending.createdAt ?? task.createdAt,
          keywords,
        });
      }
      return { gates };
    },

    async confirmGate(taskId): Promise<GateConfirmResult> {
      await deps.store.whenReady();
      const resolution = await readKvJson<GateResolutionRecord>(deps.store, gateResolutionKey(taskId));

      const findSelection = async (key: string) =>
        (await deps.store.listTasks()).find(
          (t) => t.kind === 'selection' && (t.payload as { selection?: { idempotencyKey?: string } } | null)?.selection?.idempotencyKey === key,
        );

      if (resolution?.idempotencyKey) {
        const existing = await findSelection(resolution.idempotencyKey);
        if (existing) {
          return { created: false, selectionTaskId: existing.id, idempotencyKey: resolution.idempotencyKey };
        }
      }

      const task = await deps.store.getTask(taskId);
      if (!task || task.status !== 'awaiting_user') {
        throw new Error(
          `${GATE_ERRORS.NOT_AWAITING}: 任务 ${taskId} 不在 awaiting_user 态（现态 ${task?.status ?? 'missing'}），无法确认闸门`,
        );
      }
      const pending = await readKvJson<GatePendingRecord>(deps.store, gatePendingKey(taskId));
      if (!pending || pending.gate !== GATE_KEYWORD_CONFIRM || pending.reportId === undefined) {
        throw new Error(`${GATE_ERRORS.NOT_KEYWORD_CONFIRM}: 任务 ${taskId} 的挂起闸门不是 keyword_confirm`);
      }

      const idempotencyKey = keywordGateIdempotencyKey(pending.topic ?? pending.topicId ?? '', pending.reportId);
      const existing = await findSelection(idempotencyKey);
      if (existing) {
        return { created: false, selectionTaskId: existing.id, idempotencyKey };
      }

      const keywords = await readKvJson<KeywordFilterView>(deps.store, gateKeywordsKey(taskId));
      const selectionTaskId = randomUUID();
      await deps.store.createTask({
        id: selectionTaskId,
        kind: 'selection',
        payload: {
          selection: {
            topic: pending.topic ?? pending.topicId ?? '',
            topicId: pending.topicId ?? null,
            reportId: pending.reportId,
            idempotencyKey,
            keywords: keywords?.allowed ?? [],
          },
        },
        idempotencyKey,
      });
      // selection 占位（queued）：执行归 M2 T-M2-02——本卡只建占位记录，不驱动 runner
      await deps.store.updateTaskStatus({ taskId: selectionTaskId, status: 'queued' });
      await deps.store.writeTaskEvent({
        taskId: selectionTaskId,
        type: 'TASK_ENQUEUE',
        fromState: 'idle',
        toState: 'queued',
        payload: { reason: 'keyword-gate-confirmed', reportId: pending.reportId, idempotencyKey },
      });
      await deps.store.kvSet(
        gateResolutionKey(taskId),
        JSON.stringify({ resolution: 'confirmed', selectionTaskId, idempotencyKey, at: now().toISOString() } satisfies GateResolutionRecord),
      );
      await deps.store.kvDel(gatePendingKey(taskId));

      // collect 任务收口：awaiting_user → running（检查点全完成）→ completed
      await deps.runner.resume(taskId);
      deps.logger.userAction('gate:keyword-confirmed', { taskId, reportId: pending.reportId, selectionTaskId, idempotencyKey });
      return { created: true, selectionTaskId, idempotencyKey };
    },

    async rejectGate(taskId): Promise<GateRejectResult> {
      await deps.store.whenReady();
      const resolution = await readKvJson<GateResolutionRecord>(deps.store, gateResolutionKey(taskId));
      const task = await deps.store.getTask(taskId);
      if (resolution && task && task.status !== 'awaiting_user') {
        return { taskId, status: task.status };
      }
      if (!task || task.status !== 'awaiting_user') {
        throw new Error(
          `${GATE_ERRORS.NOT_AWAITING}: 任务 ${taskId} 不在 awaiting_user 态（现态 ${task?.status ?? 'missing'}），无法拒绝闸门`,
        );
      }
      const pending = await readKvJson<GatePendingRecord>(deps.store, gatePendingKey(taskId));
      if (!pending) {
        throw new Error(`${GATE_ERRORS.NOT_PENDING}: 任务 ${taskId} 无挂起闸门记录`);
      }
      const status = await deps.runner.cancel(taskId, `gate-rejected:${pending.gate}`);
      await deps.store.kvSet(
        gateResolutionKey(taskId),
        JSON.stringify({ resolution: 'rejected', at: now().toISOString() } satisfies GateResolutionRecord),
      );
      await deps.store.kvDel(gatePendingKey(taskId));
      deps.logger.userAction('gate:rejected', { taskId, gate: pending.gate, status });
      return { taskId, status };
    },

    async listReports(): Promise<ReportsListResult> {
      await deps.store.whenReady();
      const index = (await readKvJson<ReportIndexEntry[]>(deps.store, KV_REPORT_INDEX)) ?? [];
      return { reports: index.map((e) => ({ id: e.id, topic: e.topic, createdAt: e.createdAt, model: e.model, tokenCost: e.tokenCost })) };
    },

    async getReportView(reportId): Promise<ReportGetResult> {
      await deps.store.whenReady();
      const row = await deps.store.getReport(reportId);
      const keywordFilter = await readKvJson<KeywordFilterView>(deps.store, reportKeywordFilterKey(reportId));
      if (!row) return { reportId, report: null, contentMd: null, keywordFilter: null };
      return { reportId, report: row.report, contentMd: row.contentMd, keywordFilter };
    },

    async chartData(reportId): Promise<ReportChartDataResult> {
      await deps.store.whenReady();
      const meta = await readKvJson<{ topicId?: string }>(deps.store, reportMetaKey(reportId));
      const notes = await deps.store.listNotes({ ...(meta?.topicId ? { topicId: meta.topicId } : {}), limit: 500 });
      const texts = notes.map((n) => `${n.title ?? ''}\n${n.content ?? ''}`);
      const clustered = clusterTexts(texts, { seed });

      const clusters = clustered.topTerms.map((terms, i) => {
        const members = notes.filter((_, j) => clustered.assignments[j] === i);
        const avgLikes = members.length === 0 ? 0 : members.reduce((s, n) => s + n.likes, 0) / members.length;
        const avgCollects = members.length === 0 ? 0 : members.reduce((s, n) => s + n.collects, 0) / members.length;
        return { label: `场景簇${i + 1}`, size: members.length, avgLikes: Math.round(avgLikes), avgCollects: Math.round(avgCollects), topTerms: terms.slice(0, 5) };
      });

      const prices = notes.flatMap((n) => extractPrices(`${n.title ?? ''} ${n.content ?? ''}`));
      const buckets = [
        { label: '<100', test: (p: number) => p < 100 },
        { label: '100-200', test: (p: number) => p >= 100 && p < 200 },
        { label: '200-300', test: (p: number) => p >= 200 && p < 300 },
        { label: '300+', test: (p: number) => p >= 300 },
      ];
      const counts = buckets.map((b) => prices.filter(b.test).length);

      const lowerTexts = texts.map((t) => t.toLowerCase());
      const wordcloud = [
        ...new Map(
          clustered.topTerms.flat().map((term) => [term, lowerTexts.reduce((sum, t) => sum + t.split(term.toLowerCase()).length - 1, 0)] as const),
        ).entries(),
      ]
        .filter(([, weight]) => weight > 0)
        .map(([term, weight]) => ({ term, weight }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 30);

      return { sampleSize: notes.length, clusters, priceBuckets: { ranges: buckets.map((b) => b.label), counts }, wordcloud };
    },

    async listNotes(topicId, limit): Promise<NotesListResult> {
      await deps.store.whenReady();
      const notes = await deps.store.listNotes({ ...(topicId ? { topicId } : {}), limit: limit ?? 100 });
      return {
        notes: notes.map((n) => ({
          id: n.id,
          noteId: n.noteId,
          title: n.title,
          author: n.author,
          likes: n.likes,
          collects: n.collects,
          comments: n.comments,
          publishedAt: n.publishedAt,
          collectedAt: n.collectedAt,
        })),
      };
    },

    async insertFixtureReport(params) {
      const { id } = await deps.store.insertReport({
        topic: params.topic,
        report: params.report,
        ...(params.contentMd !== undefined ? { contentMd: params.contentMd } : {}),
        model: 'fixture-mock',
        gateState: 'fixture',
      });
      await appendReportIndex({ id, topic: params.topic, createdAt: now().toISOString(), model: 'fixture-mock', tokenCost: null });
      return { id };
    },
  };
}

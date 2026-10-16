/**
 * selection 任务服务（T-M2-03，05 M2 选品链路执行侧）：
 * 报告关键词闸门确认 → queued 占位任务（report-service confirmGate 产出）→ 本服务
 * 注册 kind='selection' 进 runner 并驱动三步管道：
 *   ① selection-retrieve —— 经 SourcingSearchPort 逐词检索（真实实现 = CDP + 1688
 *      canonical URL；fixture seam XINGLIAN_SELECTION_FIXTURE = JSON 候选文件回放）
 *   ② selection-score —— generateSelection 五维确定性评分 + 推荐流防御 + Top30
 *   ③ selection-persist —— TopN 批量落 sourcing_candidates（同任务幂等替换）+ 完成
 *
 * 边界：
 * - 步骤级中间态归本服务（S9：不进 XState）；任务生命周期宏状态仍归 machine/runner。
 * - 登录态依赖诚实口径：1688 匿名检索返回推荐流（T-M2-01 取证）——agent 的相关性
 *   0 分剔除会把推荐流整批滤掉，任务 completed 且 stats.excludedJunk 高企 = 「需
 *   登录」的可观测信号，不臆造结果、不自动重试（FR-3.1 登录归用户本人）。
 * - 无配额计量 v1（选品检索只读卡片，不烧 xhs 采集配额；独立计量随 B-2 定论卡评估）。
 */
import { readFileSync } from 'node:fs';
import {
  generateSelection,
  type SelectionKeywordInput,
  type SelectionResult,
  type SourcingCandidate,
  type SourcingSearchPort,
} from '@xinglian/agents';
import type { Logger } from '@xinglian/logger';
import { serialSteps, runWorkflow } from '@xinglian/workflow';
import type { StoreClient, SourcingCandidateInput } from '../store';
import type { TaskRunner } from './runner';

export const SELECTION_KIND = 'selection';

/** report-service confirmGate 产出的占位任务 payload 形状（唯一上游契约） */
export interface SelectionTaskPayload {
  selection: {
    topic: string;
    topicId: string | null;
    reportId: number;
    idempotencyKey: string;
    /** 闸门放行的关键词（"词——理由" 复合格式，来自报告⑦章 bullets） */
    keywords: string[];
  };
}

/** "防晒帽 UPF50+——选购攻略类笔记…" → term="防晒帽 UPF50+", rationale="选购攻略…" */
export function parseSelectionKeyword(raw: string): SelectionKeywordInput {
  const idx = raw.indexOf('——');
  if (idx <= 0) return { term: raw.trim() };
  const term = raw.slice(0, idx).trim();
  const rationale = raw.slice(idx + 2).trim();
  return term ? { term, rationale: rationale || undefined } : { term: raw.trim() };
}

/** 检索词收敛：去空、去重（term 级）、上限 5（与采集 SearchQuerySchema 同口径） */
export function normalizeSelectionKeywords(raws: string[]): SelectionKeywordInput[] {
  const seen = new Set<string>();
  const out: SelectionKeywordInput[] = [];
  for (const raw of raws) {
    const kw = parseSelectionKeyword(raw);
    if (!kw.term || seen.has(kw.term)) continue;
    seen.add(kw.term);
    out.push(kw);
    if (out.length >= 5) break;
  }
  return out;
}

export interface SelectionServiceDeps {
  readonly store: Pick<
    StoreClient,
    | 'whenReady'
    | 'getTask'
    | 'listTasks'
    | 'upsertStep'
    | 'listSteps'
    | 'kvSet'
    | 'insertSourcingCandidates'
    | 'listSourcingCandidates'
  >;
  readonly runner: TaskRunner;
  readonly logger: Logger;
  /** 检索端口（组合根注入：真实 CDP 或 fixture 回放） */
  readonly searchPort: SourcingSearchPort;
  readonly now?: () => Date;
  /** TopN 保留上限（任务卡口径 30） */
  readonly topN?: number;
  /** 每词检索候选上限 */
  readonly perKeywordLimit?: number;
}

export class SelectionService {
  private readonly deps: SelectionServiceDeps;
  private readonly now: () => Date;

  constructor(deps: SelectionServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    deps.runner.registerKind(SELECTION_KIND, (ctx) => this.runPipeline(ctx.taskId, ctx.logger));
  }

  /** boot 扫描：queued selection 占位任务起跑（gate confirm 产出后重启应用/下轮启动时驱动） */
  async startQueued(): Promise<string[]> {
    await this.deps.store.whenReady();
    const started: string[] = [];
    for (const task of await this.deps.runner.listTaskViews()) {
      if (task.kind !== SELECTION_KIND || task.status !== 'queued') continue;
      await this.deps.runner.startQueued(task.id).catch((error) => {
        this.deps.logger.systemError('selection:queued-start-failed', { taskId: task.id, error: String(error).slice(0, 160) });
      });
      started.push(task.id);
    }
    return started;
  }

  /** 查询面（IPC/看板 v1 用）：任务候选 TopN */
  async listCandidates(taskId: string): Promise<SourcingCandidateInput[]> {
    await this.deps.store.whenReady();
    return (await this.deps.store.listSourcingCandidates({ taskId, limit: 50 })) as unknown as SourcingCandidateInput[];
  }

  private async runPipeline(taskId: string, logger: Logger): Promise<void> {
    const taskRow = await this.deps.store.getTask(taskId);
    const payload = (taskRow?.payload as SelectionTaskPayload | null)?.selection;
    if (!payload) throw new Error(`selection 任务 payload 缺失: ${taskId}`);

    let result: SelectionResult | null = null;
    await runWorkflow({
      steps: serialSteps([
        {
          id: 'selection-retrieve',
          run: async () => {
            const keywords = normalizeSelectionKeywords(payload.keywords);
            if (keywords.length === 0) throw new Error('E-SELECTION-NO-KEYWORD: 闸门关键词为空（解析后无可检索词）');
            logger.automationStep('selection:retrieve-start', { taskId, keywords: keywords.map((k) => k.term) });
            return { keywords: keywords.length };
          },
        },
        {
          id: 'selection-score',
          run: async () => {
            const keywords = normalizeSelectionKeywords(payload.keywords);
            const scored = await generateSelection(
              { keywords, topN: this.deps.topN ?? 30, perKeywordLimit: this.deps.perKeywordLimit ?? 30 },
              { search: this.deps.searchPort, now: this.now },
            );
            result = scored;
            logger.automationStep('selection:score-done', {
              taskId,
              selectionId: scored.selectionId,
              totalScored: scored.stats.totalScored,
              top: scored.top.length,
              excludedJunk: scored.stats.keywords.reduce((s, k) => s + k.excludedJunk, 0),
            });
            return { selectionId: scored.selectionId, totalScored: scored.stats.totalScored };
          },
        },
        {
          id: 'selection-persist',
          run: async () => {
            const r = result;
            if (!r) throw new Error('E-SELECTION-SCORE-MISSING: score 步骤未产出结果');
            const rows: SourcingCandidateInput[] = r.top.map((t) => ({
              taskId,
              selectionId: r.selectionId,
              rank: t.rank,
              offerId: t.offerId,
              keyword: t.keyword,
              total: t.total,
              dimensions: t.dimensions,
              title: t.candidate.title,
              priceText: t.candidate.priceText ?? null,
              salesText: t.candidate.salesText ?? null,
              supplierName: t.candidate.supplierName ?? null,
              supplierAddress: t.candidate.supplierAddress ?? null,
              sourceUrl: t.candidate.sourceUrl ?? null,
            }));
            await this.deps.store.insertSourcingCandidates(rows);
            await this.deps.store.kvSet(
              selectionStatsKey(taskId),
              JSON.stringify({ selectionId: r.selectionId, stats: r.stats, generatedAt: r.generatedAt }),
            );
            logger.automationStep('selection:persist-done', { taskId, inserted: rows.length });
            return { inserted: rows.length };
          },
        },
      ]),
      control: {
        shouldStop: () => false,
        yieldGate: async () => {},
      },
      checkpoints: this.checkpointsFor(taskId),
      retry: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 },
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
      now: this.now,
    });
  }

  /** 02 §6.1 检查点真源 = task_steps 表（同 collect-service 口径） */
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
}

/** 任务级选品统计 kv 键（UI/看板读面；stats 含各词 retained/excludedJunk） */
export function selectionStatsKey(taskId: string): string {
  return `selection:stats:${taskId}`;
}

/** fixture 回放端口（e2e/联调 seam：内存字典） */
export function createFixtureSearchPort(byKeyword: Record<string, SourcingCandidate[]>): SourcingSearchPort {
  return {
    async search(keyword, limit) {
      return (byKeyword[keyword] ?? []).slice(0, limit);
    },
  };
}

/** fixture 回放端口（文件形态）：JSON = { "关键词": SourcingCandidate[] }；读取失败即抛（启动期可见） */
export function createFixtureSearchPortFromFile(path: string): SourcingSearchPort {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, SourcingCandidate[]>;
  return createFixtureSearchPort(parsed);
}

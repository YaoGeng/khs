/**
 * 选品候选清单视图服务（05 T-M2-03；FR-6.2 权重可调 / FR-6.3 对比表格）。
 *
 * 语义边界（诚实口径）：
 * - 权重调整重算 = 读时纯算术：库内 rank/total 保留 selection-agent 的原始评分
 *   （溯源不动），渲染层按 kv 当前权重现算 displayTotal/序——不回写、不重跑检索。
 * - 置顶 = 用户显式 UI 偏好，落 kv `selection:pinned:<taskId>`（offerId 集），
 *   不触碰候选行本身；权重落 kv `selection:weights`（全局，六维 0-100 相对权重；
 *   T-M2-05b 起 repurchase 缺键的旧 kv 按默认值补齐，向后兼容）。
 * - excludedJunk 是「匿名检索吃到推荐流 → 需登录 1688」的可观测信号（T-M2-01
 *   取证结论），任务卡如实展示，不臆造候选、不自动重试。
 * - shared/channels SELECTION_DIMENSIONS_SCHEMA 与 agents SELECTION_DIMENSIONS 是
 *   互链镜像（渲染 bundle 不带 agents 包）：本服务构造期断言键集一致，漂移即抛。
 */
import { randomUUID } from 'node:crypto';
import { SELECTION_DIMENSIONS, type DimensionScore } from '@xinglian/agents';
import { SELECTION_DIMENSIONS_SCHEMA, type SelectionDimensionId } from '../shared/channels';
import type {
  SelectionCandidatesResult,
  SelectionConfigResult,
  SelectionInsertFixtureParams,
  SelectionInsertFixtureResult,
  SelectionListResult,
  SelectionSetPinnedParams,
  SelectionSetPinnedResult,
  SelectionSummary,
  SelectionWeights,
} from '../shared/schemas';
import { SELECTION_KIND, selectionStatsKey, type SelectionTaskPayload } from '../tasks/selection-service';
import type { StoreClient, SourcingCandidateInput } from '../store';
import type { TaskRunner } from '../tasks/runner';

const SELECTION_WEIGHTS_KEY = 'selection:weights';

export function selectionPinnedKey(taskId: string): string {
  return `selection:pinned:${taskId}`;
}

export interface SelectionViewDeps {
  readonly store: Pick<
    StoreClient,
    | 'whenReady'
    | 'createTask'
    | 'updateTaskStatus'
    | 'upsertStep'
    | 'kvGet'
    | 'kvSet'
    | 'insertSourcingCandidates'
    | 'listSourcingCandidates'
  >;
  readonly runner: Pick<TaskRunner, 'listTaskViews'>;
  readonly now?: () => Date;
}

/** kv JSON 读取（损坏/缺失 → null，不抛——读面容错优先） */
async function readKvJson(store: SelectionViewDeps['store'], key: string): Promise<unknown> {
  const value = await store.kvGet(key);
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isDimensionScores(value: unknown): value is DimensionScore[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (d) =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as DimensionScore).name === 'string' &&
        typeof (d as DimensionScore).score === 'number' &&
        Number.isFinite((d as DimensionScore).score),
    )
  );
}

export function defaultSelectionWeights(): SelectionWeights {
  const weights = {} as Record<SelectionDimensionId, number>;
  for (const id of SELECTION_DIMENSIONS_SCHEMA) {
    weights[id] = Math.round(SELECTION_DIMENSIONS[id].weight * 100);
  }
  return weights;
}

/** kv 侧权重表校验：0-100 整数 + 非全零；不符 → null（读面回退默认）。
 *  向后兼容（T-M2-05b 六维化）：旧 kv 只存五键 → 缺失的 repurchase 用该维默认值
 *  补齐（一次性迁移语义，保存时即写全六键）；其余键缺失仍视为损坏 → null。 */
function parseWeights(value: unknown): SelectionWeights | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const weights = {} as Record<SelectionDimensionId, number>;
  let sum = 0;
  for (const id of SELECTION_DIMENSIONS_SCHEMA) {
    const w = raw[id];
    if (w === undefined && id === 'repurchase') {
      weights[id] = Math.round(SELECTION_DIMENSIONS.repurchase.weight * 100);
      sum += weights[id];
      continue;
    }
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 0 || w > 100) return null;
    weights[id] = w;
    sum += w;
  }
  return sum > 0 ? weights : null;
}

/**
 * 按权重重算综合分（0-100）：Σ score × (w/Σw)。权重是相对值（30/20/20/15/15 与
 * 60/40/40/30/30 重算结果一致），与 agent 侧 Σ score×weight（权重和=1）在默认权重下
 * 严格相等。维度缺失/损坏行返回 null（渲染层回退显示库内原始 total）。
 */
export function recomputeTotal(dimensions: unknown, weights: SelectionWeights): number | null {
  if (!isDimensionScores(dimensions)) return null;
  const sum = SELECTION_DIMENSIONS_SCHEMA.reduce((acc, id) => acc + (weights[id] ?? 0), 0);
  if (sum <= 0) return null;
  let total = 0;
  for (const d of dimensions) {
    const w = weights[d.name as SelectionDimensionId] ?? 0;
    total += d.score * (w / sum);
  }
  return Math.round(total);
}

/** selection:stats kv 载荷解析（selection-service persist 步骤写入的形状） */
function parseStats(value: unknown): { excludedJunk: number; generatedAt: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const stats = (value as { stats?: unknown; generatedAt?: unknown }).stats;
  const generatedAt = (value as { generatedAt?: unknown }).generatedAt;
  if (typeof stats !== 'object' || stats === null || typeof generatedAt !== 'string') return null;
  const keywords = (stats as { keywords?: unknown }).keywords;
  if (!Array.isArray(keywords)) return null;
  let excludedJunk = 0;
  for (const k of keywords) {
    const n = (k as { excludedJunk?: unknown }).excludedJunk;
    if (typeof n === 'number' && Number.isFinite(n)) excludedJunk += n;
  }
  return { excludedJunk, generatedAt };
}

/** fixture 确定性五维分（无入参 dimensions 时的兜底；e2e 需要可控排序时应显式给分） */
function fixtureDimensions(offerId: string): DimensionScore[] {
  let h = 7;
  for (const ch of offerId) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 9973;
  return SELECTION_DIMENSIONS_SCHEMA.map((id, idx) => {
    const score = 30 + ((h + idx * 17) % 71);
    return {
      name: id,
      title: SELECTION_DIMENSIONS[id].title,
      score,
      weight: SELECTION_DIMENSIONS[id].weight,
      reason: `fixture 维度分（offer ${offerId.slice(0, 12)}）`,
    };
  });
}

export class SelectionViewService {
  private readonly deps: SelectionViewDeps;
  private readonly now: () => Date;

  constructor(deps: SelectionViewDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    // 镜像一致性断言（shared ↔ agents）：漂移即启动期可见，绝不静默错位
    const agentIds = Object.keys(SELECTION_DIMENSIONS).sort().join(',');
    const mirrorIds = [...SELECTION_DIMENSIONS_SCHEMA].sort().join(',');
    if (agentIds !== mirrorIds) {
      throw new Error(
        `E-SELECTION-DIMENSION-MIRROR-DRIFT: shared/channels 镜像(${mirrorIds}) 与 agents SELECTION_DIMENSIONS(${agentIds}) 键集不一致`,
      );
    }
  }

  /** selection:list —— 选品任务卡（最新在前；candidateCount 取自 persist 步骤产出） */
  async listSelections(): Promise<SelectionListResult> {
    await this.deps.store.whenReady();
    const selections: SelectionSummary[] = [];
    for (const view of await this.deps.runner.listTaskViews()) {
      if (view.kind !== SELECTION_KIND) continue;
      const selection = (view.payload as SelectionTaskPayload | null)?.selection ?? null;
      const persist = view.steps.find((s) => s.stepId === 'selection-persist');
      const inserted = (persist?.output as { inserted?: unknown } | null)?.inserted;
      const stats = parseStats(await readKvJson(this.deps.store, selectionStatsKey(view.id)));
      selections.push({
        taskId: view.id,
        topic: selection?.topic ?? '（payload 缺失）',
        topicId: selection?.topicId ?? null,
        keywords: selection?.keywords ?? [],
        status: view.status,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
        candidateCount: typeof inserted === 'number' && Number.isFinite(inserted) ? Math.max(0, Math.trunc(inserted)) : 0,
        excludedJunk: stats?.excludedJunk ?? null,
        generatedAt: stats?.generatedAt ?? null,
      });
    }
    selections.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { selections };
  }

  /** selection:candidates —— 某任务 TopN 候选 + 置顶集（重算由渲染层按 config 权重现算；
 *   checked 勾选集归 outreach kv，组合根合并后返回契约全形——T-M2-04） */
  async listCandidates(taskId: string): Promise<Omit<SelectionCandidatesResult, 'checked'>> {
    await this.deps.store.whenReady();
    const candidates = await this.deps.store.listSourcingCandidates({ taskId, limit: 500 });
    return { candidates, pinned: await this.readPinned(taskId) };
  }

  /** selection:config —— 五维元数据 + 当前权重（kv 无记录 = Agent 默认） */
  async getConfig(): Promise<SelectionConfigResult> {
    await this.deps.store.whenReady();
    const dimensions = SELECTION_DIMENSIONS_SCHEMA.map((id) => ({
      id,
      title: SELECTION_DIMENSIONS[id].title,
      default: Math.round(SELECTION_DIMENSIONS[id].weight * 100),
    }));
    const raw = await readKvJson(this.deps.store, SELECTION_WEIGHTS_KEY);
    const weights = parseWeights(raw) ?? defaultSelectionWeights();
    return { dimensions, weights, customized: raw !== null && parseWeights(raw) !== null };
  }

  /** selection:setWeights —— 权重持久化（全局 kv；重算发生在下次读取） */
  async setWeights(weights: SelectionWeights): Promise<SelectionConfigResult> {
    await this.deps.store.whenReady();
    await this.deps.store.kvSet(SELECTION_WEIGHTS_KEY, JSON.stringify(weights));
    return this.getConfig();
  }

  /** selection:setPinned —— 置顶切换（kv offerId 集；幂等） */
  async setPinned(params: SelectionSetPinnedParams): Promise<SelectionSetPinnedResult> {
    await this.deps.store.whenReady();
    const current = await this.readPinned(params.taskId);
    const set = new Set(current);
    if (params.pinned) set.add(params.offerId);
    else set.delete(params.offerId);
    const offerIds = [...set];
    await this.deps.store.kvSet(selectionPinnedKey(params.taskId), JSON.stringify(offerIds));
    return { taskId: params.taskId, offerIds };
  }

  /**
   * selection:insertFixture（QA 播种，debug 门控装配）：completed selection 任务 +
   * 候选行 + 三步产出 + stats kv——e2e/联调不依赖浏览器与登录态。rank 按入参顺序、
   * total 缺省按默认权重重算，保证 e2e 断言可预测。
   */
  async insertFixture(params: SelectionInsertFixtureParams): Promise<SelectionInsertFixtureResult> {
    await this.deps.store.whenReady();
    const taskId = randomUUID();
    const selectionId = `fixture-${taskId.slice(0, 8)}`;
    const at = this.now().toISOString();
    await this.deps.store.createTask({
      id: taskId,
      kind: SELECTION_KIND,
      payload: {
        selection: {
          topic: params.topic,
          topicId: null,
          reportId: 0,
          idempotencyKey: `fixture:${taskId}`,
          keywords: params.keywords,
        },
      },
    });
    const defaults = defaultSelectionWeights();
    const rows: SourcingCandidateInput[] = params.candidates.map((c, idx) => {
      const dimensions = c.dimensions ?? fixtureDimensions(c.offerId);
      return {
        taskId,
        selectionId,
        rank: idx + 1,
        offerId: c.offerId,
        keyword: c.keyword,
        total: c.total ?? recomputeTotal(dimensions, defaults) ?? 0,
        dimensions,
        title: c.title,
        priceText: c.priceText ?? null,
        salesText: c.salesText ?? null,
        supplierName: c.supplierName ?? null,
        supplierAddress: c.supplierAddress ?? null,
        sourceUrl: c.sourceUrl ?? null,
      };
    });
    await this.deps.store.insertSourcingCandidates(rows);
    // 三步产出镜像真实管道（selection:list 的 candidateCount 即取自 persist 步骤）
    const stepOutputs = [
      { stepId: 'selection-retrieve', seq: 1, output: { keywords: params.keywords.length } },
      { stepId: 'selection-score', seq: 2, output: { selectionId, totalScored: rows.length } },
      { stepId: 'selection-persist', seq: 3, output: { inserted: rows.length } },
    ];
    for (const step of stepOutputs) {
      await this.deps.store.upsertStep({ taskId, stepId: step.stepId, seq: step.seq, status: 'completed', output: step.output, checkpointAt: at });
    }
    await this.deps.store.kvSet(
      selectionStatsKey(taskId),
      JSON.stringify({
        selectionId,
        generatedAt: at,
        stats: {
          keywords: params.keywords.map((term) => ({ term, candidates: rows.filter((r) => r.keyword === term).length, retained: rows.filter((r) => r.keyword === term).length, excludedJunk: 0 })),
          dedupedAcrossKeywords: 0,
          totalScored: rows.length,
        },
      }),
    );
    await this.deps.store.updateTaskStatus({ taskId, status: 'completed' });
    return { taskId, inserted: rows.length };
  }

  private async readPinned(taskId: string): Promise<string[]> {
    const value = await readKvJson(this.deps.store, selectionPinnedKey(taskId));
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
  }
}

export function createSelectionViewService(deps: SelectionViewDeps): SelectionViewService {
  return new SelectionViewService(deps);
}

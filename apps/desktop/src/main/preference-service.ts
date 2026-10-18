/**
 * 偏好画像服务（05 T-M2-07；FR-6.7/FR-9.8 偏好回流 v1，Agent 工程师口径归口）。
 *
 * 语义边界（诚实口径）：
 * - **埋点 = append-only 流水**（preferences 表，scope=selection / key=behavior）：
 *   勾选（checked）/置顶（pinned）/显式淘汰（dismissed）三类行为各记一行，含六维分
 *   快照（dims name→score，埋点时点从 sourcing_candidates 内存映射取；取不到 → 缺省，
 *   派生时跳过该行）。取消勾选 ≠ 淘汰（语义污染），淘汰只有显式 UI 动作一个信号源。
 * - **互斥**：同一候选不能既是采纳又是淘汰——淘汰写面自动移出勾选集（kv 簿记归
 *   selection-view-service），勾选写面自动撤销淘汰（流水记 dismissed=false 行）；
 *   流水各记各的行为，派生按最末态兜底。
 * - **派生 = 读时确定性聚合，无 LLM**：每 offerId 取最末态分组 adopted / dismissed /
 *   neutral；`dimBias[dim] = clamp((mean(adopted) − mean(others)) / 100, ±0.5)`，
 *   others = dismissed ∪ neutral（已见未采纳）。生效门槛：采纳组 ≥ MIN_ADOPTED 且
 *   对照组 ≥ MIN_OTHERS（常量可审计），不足 → bias 全 0 + sampleInsufficient。
 *   流水读取上限 1000 行（超出按最近 1000 条派生，诚实截断不臆造全量）。
 * - **回流 = 权重乘性微调，用户显式权重不被静默覆盖**：effectiveWeights[dim] =
 *   round(max(0, weights[dim] × (1 + dimBias[dim])))；enabled=false 或样本不足时
 *   原样返回用户权重。开关落 kv（默认 true，FR-6.7 本意），UI 可见可关。
 * - **本地学习不上传**：preferences 无任何出站面；画像快照（key=profile）仅在
 *   内容变化时追加一行（学习轨迹），config 读面每次现算、不读缓存行。
 */
import { SELECTION_DIMENSIONS_SCHEMA, type SelectionDimensionId } from '../shared/channels';
import type { SelectionPreferenceInfo, SelectionWeights } from '../shared/schemas';
import type { PreferenceRowView } from '../store/protocol';
import type { StoreClient } from '../store';

export const PREFERENCE_SCOPE = 'selection';
export const PREFERENCE_BEHAVIOR_KEY = 'behavior';
export const PREFERENCE_PROFILE_KEY = 'profile';
/** 回流开关 kv 键（默认 true——FR-6.7「后续评分自动加权」本意；UI 显式可关） */
export const PREFERENCE_ENABLED_KV = 'selection:preference:enabled';

/** 生效门槛（常量可审计）：采纳组 ≥3 且对照组 ≥5 才计算 bias（对照组 = 已见未采纳） */
export const PREFERENCE_MIN_ADOPTED = 3;
export const PREFERENCE_MIN_OTHERS = 5;
/** 单维 bias 钳位（±0.5 = 权重最多 ×1.5 / ×0.5，防小样本极端值主导排序） */
export const PREFERENCE_BIAS_CLAMP = 0.5;
/** 流水派生读取上限（preferences 表单次 list 上限；超出按最近 1000 条派生） */
export const PREFERENCE_STREAM_LIMIT = 1000;

export type PreferenceBehaviorKind = 'checked' | 'pinned' | 'dismissed';

/** 埋点载荷（value_json 形状；dims = 六维分快照 name→score） */
export interface PreferenceBehaviorValue {
  kind: PreferenceBehaviorKind;
  taskId: string;
  offerId: string;
  flag: boolean;
  /** 取不到候选行（重采覆盖等）时缺省——派生跳过该行，不臆造 */
  dims?: Record<string, number>;
  total?: number;
  title?: string;
  at: string;
}

/** 读时派生的画像核（不含 enabled/effectiveWeights——那是融合面） */
export interface DerivedProfile {
  adopted: number;
  dismissed: number;
  sampleInsufficient: boolean;
  dimBias: Record<SelectionDimensionId, number>;
}

export interface PreferenceServiceDeps {
  readonly store: Pick<
    StoreClient,
    'whenReady' | 'kvGet' | 'kvSet' | 'insertPreference' | 'listPreferences' | 'listSourcingCandidates'
  >;
  readonly now?: () => Date;
}

/** 维度分快照校验：六维键内、有限数值（流水损坏行按无快照处理，不抛） */
function parseDims(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const dims: Record<string, number> = {};
  let count = 0;
  for (const id of SELECTION_DIMENSIONS_SCHEMA) {
    const v = raw[id];
    if (typeof v === 'number' && Number.isFinite(v)) {
      dims[id] = v;
      count += 1;
    }
  }
  return count > 0 ? dims : null;
}

function parseBehaviorValue(row: PreferenceRowView): PreferenceBehaviorValue | null {
  const v = row.value as Partial<PreferenceBehaviorValue> | null;
  if (typeof v !== 'object' || v === null) return null;
  if (v.kind !== 'checked' && v.kind !== 'pinned' && v.kind !== 'dismissed') return null;
  if (typeof v.offerId !== 'string' || v.offerId.length === 0) return null;
  if (typeof v.taskId !== 'string' || v.taskId.length === 0) return null;
  if (typeof v.flag !== 'boolean') return null;
  return { kind: v.kind, taskId: v.taskId, offerId: v.offerId, flag: v.flag, dims: v.dims, total: v.total, title: v.title, at: typeof v.at === 'string' ? v.at : row.updatedAt };
}

function zeroBias(): Record<SelectionDimensionId, number> {
  const bias = {} as Record<SelectionDimensionId, number>;
  for (const id of SELECTION_DIMENSIONS_SCHEMA) bias[id] = 0;
  return bias;
}

const clampBias = (v: number): number => Math.max(-PREFERENCE_BIAS_CLAMP, Math.min(PREFERENCE_BIAS_CLAMP, v));

/**
 * 偏好乘性微调（纯函数）：eff = round(max(0, w × (1+bias)))。权重是相对值，乘性微调
 * 后无需再归一（比例结构即意图）；全零防御回退原权重（权重契约非全零，理论不可达）。
 */
export function computeEffectiveWeights(weights: SelectionWeights, dimBias: Record<SelectionDimensionId, number>): SelectionWeights {
  const effective = {} as Record<SelectionDimensionId, number>;
  let sum = 0;
  for (const id of SELECTION_DIMENSIONS_SCHEMA) {
    const v = Math.max(0, Math.round(weights[id] * (1 + clampBias(dimBias[id] ?? 0))));
    effective[id] = v;
    sum += v;
  }
  return sum > 0 ? effective : { ...weights };
}

export class PreferenceService {
  private readonly deps: PreferenceServiceDeps;
  private readonly now: () => Date;

  constructor(deps: PreferenceServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** 埋点：checked 行（六维快照在埋点时点抓取——审计可回放「当时看到什么就学了什么」） */
  async recordChecked(taskId: string, offerId: string, flag: boolean): Promise<void> {
    await this.record('checked', taskId, offerId, flag);
  }

  /** 埋点：pinned 行（置顶 = 强采纳信号，派生时并入采纳组） */
  async recordPinned(taskId: string, offerId: string, flag: boolean): Promise<void> {
    await this.record('pinned', taskId, offerId, flag);
  }

  /** 埋点：dismissed 行（显式淘汰；flag=false = 撤销淘汰——勾选互斥回写用） */
  async recordDismissed(taskId: string, offerId: string, flag: boolean): Promise<void> {
    await this.record('dismissed', taskId, offerId, flag);
  }

  /** 淘汰集当前态（流水最末态派生；kv 不双写——单一事实源） */
  async dismissedSet(taskId: string): Promise<string[]> {
    await this.deps.store.whenReady();
    const rows = await this.deps.store.listPreferences({ scope: PREFERENCE_SCOPE, key: PREFERENCE_BEHAVIOR_KEY, limit: PREFERENCE_STREAM_LIMIT });
    const dismissed = new Map<string, boolean>();
    for (const row of [...rows].reverse()) {
      const v = parseBehaviorValue(row);
      if (!v || v.kind !== 'dismissed' || v.taskId !== taskId) continue;
      dismissed.set(v.offerId, v.flag);
    }
    return [...dismissed.entries()].filter(([, flag]) => flag).map(([offerId]) => offerId);
  }

  /** 回流开关读面（kv 损坏/缺省 → true；FR-6.7 默认开启本意） */
  async readEnabled(): Promise<boolean> {
    await this.deps.store.whenReady();
    const raw = await this.deps.store.kvGet(PREFERENCE_ENABLED_KV);
    if (raw === null) return true;
    try {
      const parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as unknown;
      return typeof parsed === 'boolean' ? parsed : true;
    } catch {
      return true;
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.deps.store.whenReady();
    await this.deps.store.kvSet(PREFERENCE_ENABLED_KV, JSON.stringify(enabled));
  }

  /**
   * 读时派生画像：最末态分组 → 组内六维均值差 → 钳位 bias。样本不足返回全 0 bias +
   * sampleInsufficient（诚实展示，不静默生效）。
   */
  async deriveProfile(): Promise<DerivedProfile> {
    await this.deps.store.whenReady();
    const rows = await this.deps.store.listPreferences({ scope: PREFERENCE_SCOPE, key: PREFERENCE_BEHAVIOR_KEY, limit: PREFERENCE_STREAM_LIMIT });
    // DESC → 正序回放（最末态覆盖前面）
    interface FinalState {
      dismissed: boolean;
      adopted: boolean;
      dims: Record<string, number> | null;
    }
    const byOffer = new Map<string, FinalState>();
    for (const row of [...rows].reverse()) {
      const v = parseBehaviorValue(row);
      if (!v) continue;
      const cur = byOffer.get(v.offerId) ?? { dismissed: false, adopted: false, dims: null };
      if (v.kind === 'dismissed') cur.dismissed = v.flag;
      else if (v.kind === 'checked') cur.adopted = v.flag;
      else if (v.flag) cur.adopted = true; // pinned=true 强采纳；pinned=false 不反向撤销勾选语义
      const dims = parseDims(v.dims);
      if (dims) cur.dims = dims;
      byOffer.set(v.offerId, cur);
    }

    const adopted: Array<Record<string, number>> = [];
    const others: Array<Record<string, number>> = [];
    let dismissedCount = 0;
    for (const state of byOffer.values()) {
      if (state.dismissed) {
        dismissedCount += 1;
        if (state.dims) others.push(state.dims);
      } else if (state.adopted) {
        if (state.dims) adopted.push(state.dims);
      } else if (state.dims) {
        others.push(state.dims);
      }
    }

    const dimBias = zeroBias();
    const sampleInsufficient = adopted.length < PREFERENCE_MIN_ADOPTED || others.length < PREFERENCE_MIN_OTHERS;
    if (!sampleInsufficient) {
      for (const id of SELECTION_DIMENSIONS_SCHEMA) {
        const a = adopted.filter((d) => id in d).map((d) => d[id]!);
        const o = others.filter((d) => id in d).map((d) => d[id]!);
        if (a.length === 0 || o.length === 0) continue; // 该维任一组无数据 → 中性 0，不臆造
        const meanA = a.reduce((s, v) => s + v, 0) / a.length;
        const meanO = o.reduce((s, v) => s + v, 0) / o.length;
        dimBias[id] = clampBias((meanA - meanO) / 100);
      }
    }
    return { adopted: adopted.length, dismissed: dismissedCount, sampleInsufficient, dimBias };
  }

  /**
   * 融合面（selection:config 出口）：画像现算 + 乘性微调 + 画像快照落表（内容变化才追加，
   * 学习轨迹）。enabled=false 或样本不足 → effectiveWeights 原样返回用户权重。
   */
  async deriveInfo(weights: SelectionWeights): Promise<SelectionPreferenceInfo> {
    const enabled = await this.readEnabled();
    const profile = await this.deriveProfile();
    const effective =
      enabled && !profile.sampleInsufficient ? computeEffectiveWeights(weights, profile.dimBias) : { ...weights };
    await this.appendProfileSnapshot(profile);
    return {
      enabled,
      adopted: profile.adopted,
      dismissed: profile.dismissed,
      sampleInsufficient: profile.sampleInsufficient,
      dimBias: profile.dimBias,
      effectiveWeights: effective,
    };
  }

  /** 画像快照 append（与最新一行内容相同则跳过——轨迹只记状态变化） */
  private async appendProfileSnapshot(profile: DerivedProfile): Promise<void> {
    const essence = { adopted: profile.adopted, dismissed: profile.dismissed, dimBias: profile.dimBias };
    const latest = (await this.deps.store.listPreferences({ scope: PREFERENCE_SCOPE, key: PREFERENCE_PROFILE_KEY, limit: 1 }))[0];
    if (latest) {
      const v = latest.value as { adopted?: unknown; dismissed?: unknown; dimBias?: unknown } | null;
      if (
        v !== null &&
        typeof v === 'object' &&
        v.adopted === essence.adopted &&
        v.dismissed === essence.dismissed &&
        JSON.stringify(v.dimBias) === JSON.stringify(essence.dimBias)
      ) {
        return;
      }
    }
    await this.deps.store.insertPreference({
      scope: PREFERENCE_SCOPE,
      key: PREFERENCE_PROFILE_KEY,
      value: { ...essence, sampleInsufficient: profile.sampleInsufficient, generatedAt: this.now().toISOString() },
    });
  }

  private async record(kind: PreferenceBehaviorKind, taskId: string, offerId: string, flag: boolean): Promise<void> {
    await this.deps.store.whenReady();
    const value: PreferenceBehaviorValue = { kind, taskId, offerId, flag, at: this.now().toISOString() };
    const row = (await this.deps.store.listSourcingCandidates({ taskId, limit: 500 })).find((c) => c.offerId === offerId);
    if (row) {
      const dims = parseDims(extractDims(row.dimensions));
      if (dims) value.dims = dims;
      value.total = row.total;
      value.title = row.title;
    }
    await this.deps.store.insertPreference({ scope: PREFERENCE_SCOPE, key: PREFERENCE_BEHAVIOR_KEY, value });
  }
}

/** sourcing_candidates.dimensions（unknown JSON）→ name→score 形态（parseDims 前置整形） */
function extractDims(dimensions: unknown): Record<string, unknown> | null {
  if (!Array.isArray(dimensions)) return null;
  const out: Record<string, unknown> = {};
  for (const d of dimensions) {
    if (typeof d === 'object' && d !== null && typeof (d as { name?: unknown }).name === 'string') {
      out[(d as { name: string }).name] = (d as { score?: unknown }).score;
    }
  }
  return out;
}

export function createPreferenceService(deps: PreferenceServiceDeps): PreferenceService {
  return new PreferenceService(deps);
}

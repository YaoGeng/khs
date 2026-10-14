/**
 * FR-2.5 用量面板 + FR-2.6 全局 RPM 设置（todo 12；01:130-131、04:63「探测表纳入用量面板」）。
 *
 * electron-free：store 走注入 Pick 面（listLlmCalls/kvGet/kvSet），探测档展示直接引用
 * presets 常量（主进程组合根允许引用业务引擎包——eslint.boundaries 规则二）。
 *
 * 聚合口径：
 * - 数据源 = llm_calls（计量元数据，无内容字段）；按天（本地日历日）/按工作流/按 provider+model 三向聚合；
 * - 工作流派生：traceId 前缀 `report-` → report（report-agent 生成规则，report-agent.ts:242）；
 *   其余 → other。M1 只有 report 一条 LLM 工作流；
 * - 成本估算：llm_calls.cost（网关注入定价时有值）优先；否则按自填单价表
 *   `<provider>/<model>` → `<provider>/*` 匹配；都无 → unestimated 计数（不造数）。
 */
import { PROVIDER_CAPABILITY_PRESETS, PROVIDER_IDS, type PresetSource, type ReachabilityClass } from '@xinglian/llm-gateway';
import type { StoreClient } from '../store/client';
import type { UsageIpcDeps } from './ipc-core';
import type { UsageSetPricingParams, UsageSetPricingResult, UsageSetRpmParams, UsageSetRpmResult, UsageSummaryParams, UsageSummaryResult } from '../shared/schemas';

export const KV_USAGE_PRICING = 'usage:pricing';
export const KV_LLM_RPM_GLOBAL = 'llm:rpm-global';

export interface UsagePricingEntry {
  inputPer1k?: number;
  outputPer1k?: number;
}

/** 自填单价表：键为 `<provider>/<model>` 或 `<provider>/*`（兜底） */
export type UsagePricingTable = Record<string, UsagePricingEntry>;

export interface UsageBucket {
  key: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costKnown: number;
  costEstimated: number;
  unestimatedCalls: number;
}

export interface UsageSummary {
  sinceDays: number;
  totals: UsageBucket;
  byDay: UsageBucket[];
  byWorkflow: UsageBucket[];
  byProviderModel: UsageBucket[];
  /** 自填单价表（当前生效值原样回显） */
  pricing: UsagePricingTable;
  /** FR-2.6 全局 RPM（0=不限流） */
  rpmGlobal: number;
  /** 能力矩阵探测档展示（04:63；五预设，custom 用户自配不进矩阵） */
  providers: Array<{ provider: string; label: string; tier: string; tierSource: PresetSource; reachability: ReachabilityClass }>;
}

export interface UsageServiceDeps {
  readonly store: Pick<StoreClient, 'listLlmCalls' | 'kvGet' | 'kvSet'>;
  readonly now?: () => Date;
}

export interface UsageRowLike {
  traceId: string | null;
  provider: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
  at: string;
}

/** 工作流派生（llm_calls 无 workflow 列；traceId 前缀是 M1 既定编码） */
export function workflowOf(traceId: string | null): string {
  if (traceId && traceId.startsWith('report-')) return 'report';
  return 'other';
}

/** 本地日历日 YYYY-MM-DD（按天聚合口径；与配额重置同口径） */
function localDayOf(atIso: string, now: () => Date): string {
  const t = Date.parse(atIso);
  const d = Number.isFinite(t) ? new Date(t) : now();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyBucket(key: string): UsageBucket {
  return { key, calls: 0, tokensIn: 0, tokensOut: 0, costKnown: 0, costEstimated: 0, unestimatedCalls: 0 };
}

function addInto(bucket: UsageBucket, row: UsageRowLike, cost: number | null, estimated: boolean): void {
  bucket.calls += 1;
  bucket.tokensIn += row.tokensIn ?? 0;
  bucket.tokensOut += row.tokensOut ?? 0;
  if (cost != null) {
    if (estimated) bucket.costEstimated += cost;
    else bucket.costKnown += cost;
  } else {
    bucket.unestimatedCalls += 1;
  }
}

function finalize(bucket: UsageBucket): UsageBucket {
  return { ...bucket, costKnown: Number(bucket.costKnown.toFixed(6)), costEstimated: Number(bucket.costEstimated.toFixed(6)) };
}

export function estimateCostOf(row: UsageRowLike, pricing: UsagePricingTable): number | null {
  if (row.cost != null) return row.cost;
  const exact = pricing[`${row.provider}/${row.model}`];
  const byProvider = pricing[`${row.provider}/*`];
  const entry = exact ?? byProvider;
  if (!entry || (entry.inputPer1k == null && entry.outputPer1k == null)) return null;
  const inCost = entry.inputPer1k != null ? ((row.tokensIn ?? 0) / 1000) * entry.inputPer1k : 0;
  const outCost = entry.outputPer1k != null ? ((row.tokensOut ?? 0) / 1000) * entry.outputPer1k : 0;
  return Number((inCost + outCost).toFixed(6));
}

/** 用量服务面（main.ts 装配；ipc 为 usage:* 三通道依赖注入对象） */
export interface UsageService {
  summary(params?: { days?: number }): Promise<UsageSummary>;
  setPricing(pricing: UsagePricingTable): Promise<{ set: boolean }>;
  setRpmGlobal(rpm: number): Promise<{ set: boolean }>;
  ipc: UsageIpcDeps;
}

export function createUsageService(deps: UsageServiceDeps): UsageService {
  const now = deps.now ?? (() => new Date());

  async function readPricing(): Promise<UsagePricingTable> {
    const raw = await deps.store.kvGet(KV_USAGE_PRICING);
    if (typeof raw !== 'string' || raw.length === 0) return {};
    try {
      return JSON.parse(raw) as UsagePricingTable;
    } catch {
      return {};
    }
  }

  const service = {
    async summary(params?: { days?: number }): Promise<UsageSummary> {
      const sinceDays = Math.min(Math.max(params?.days ?? 30, 1), 365);
      const since = new Date(now().getTime() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
      const [rows, pricing, rpmRaw] = await Promise.all([
        deps.store.listLlmCalls({ since, limit: 2000 }),
        readPricing(),
        deps.store.kvGet(KV_LLM_RPM_GLOBAL),
      ]);

      const totals = emptyBucket('total');
      const byDayMap = new Map<string, UsageBucket>();
      const byWorkflowMap = new Map<string, UsageBucket>();
      const byProviderModelMap = new Map<string, UsageBucket>();
      for (const row of rows) {
        const isEstimated = row.cost == null;
        const effectiveCost = isEstimated ? estimateCostOf(row, pricing) : row.cost;
        addInto(totals, row, effectiveCost, isEstimated);
        const day = localDayOf(row.at, now);
        const workflow = workflowOf(row.traceId);
        const providerModel = `${row.provider}/${row.model}`;
        for (const [map, key] of [
          [byDayMap, day],
          [byWorkflowMap, workflow],
          [byProviderModelMap, providerModel],
        ] as const) {
          let bucket = map.get(key);
          if (!bucket) {
            bucket = emptyBucket(key);
            map.set(key, bucket);
          }
          addInto(bucket, row, effectiveCost, isEstimated);
        }
      }

      const rpmGlobal = typeof rpmRaw === 'string' ? Number(rpmRaw) : typeof rpmRaw === 'number' ? rpmRaw : 0;
      return {
        sinceDays,
        totals: finalize(totals),
        byDay: [...byDayMap.values()].map(finalize).sort((a, b) => b.key.localeCompare(a.key)),
        byWorkflow: [...byWorkflowMap.values()].map(finalize).sort((a, b) => b.calls - a.calls),
        byProviderModel: [...byProviderModelMap.values()].map(finalize).sort((a, b) => b.calls - a.calls),
        pricing,
        rpmGlobal: Number.isFinite(rpmGlobal) && rpmGlobal > 0 ? Math.floor(rpmGlobal) : 0,
        providers: PROVIDER_IDS.map((id) => {
          const preset = PROVIDER_CAPABILITY_PRESETS[id];
          return { provider: id, label: preset.label, tier: preset.tier, tierSource: preset.tierSource, reachability: preset.reachability };
        }),
      };
    },

    async setPricing(pricing: UsagePricingTable): Promise<{ set: boolean }> {
      await deps.store.kvSet(KV_USAGE_PRICING, JSON.stringify(pricing ?? {}));
      return { set: true };
    },

    async setRpmGlobal(rpm: number): Promise<{ set: boolean }> {
      const value = Number.isFinite(rpm) && rpm > 0 ? Math.floor(rpm) : 0;
      await deps.store.kvSet(KV_LLM_RPM_GLOBAL, value === 0 ? '0' : String(value));
      return { set: true };
    },
  };

  return {
    ...service,
    ipc: {
      summary: (params: UsageSummaryParams): Promise<UsageSummaryResult> => service.summary(params),
      setPricing: (params: UsageSetPricingParams): Promise<UsageSetPricingResult> => service.setPricing(params.pricing),
      setRpm: (params: UsageSetRpmParams): Promise<UsageSetRpmResult> => service.setRpmGlobal(params.rpm),
    },
  };
}

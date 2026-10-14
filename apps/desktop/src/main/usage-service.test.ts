/**
 * FR-2.5 用量聚合 + FR-2.6 RPM 设置单测（todo 12）：自填单价估算、三向聚合、
 * 工作流派生、探测档 passthrough、未定价不造数（unestimatedCalls）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createUsageService, estimateCostOf, workflowOf, KV_USAGE_PRICING, KV_LLM_RPM_GLOBAL, type UsageRowLike } from './usage-service';
import type { LlmCallRowView } from '../store/protocol';

function rowOf(partial: Partial<LlmCallRowView> & { provider: string; model: string }): LlmCallRowView {
  return {
    id: 1,
    traceId: 'report-abc',
    tokensIn: 1000,
    tokensOut: 500,
    cost: null,
    latencyMs: null,
    at: '2026-10-14T10:00:00.000Z',
    ...partial,
  };
}

function makeDeps(rows: LlmCallRowView[], kv: Map<string, string>) {
  return {
    store: {
      listLlmCalls: vi.fn(async () => rows),
      kvGet: vi.fn(async (key: string) => kv.get(key) ?? null),
      kvSet: vi.fn(async (key: string, value: string) => {
        kv.set(key, value);
        return { set: true };
      }),
    },
    now: () => new Date('2026-10-14T12:00:00.000Z'),
  };
}

describe('FR-2.5 用量聚合（usage-service）', () => {
  it('自填单价估算：精确 <provider>/<model> 命中；<provider>/* 兜底；无定价不造数', () => {
    const r: UsageRowLike = { traceId: 'report-a', provider: 'zhipu', model: 'glm-4.7-flash', tokensIn: 2000, tokensOut: 1000, cost: null, at: '2026-10-14T10:00:00.000Z' };
    expect(estimateCostOf(r, { 'zhipu/glm-4.7-flash': { inputPer1k: 0.001, outputPer1k: 0.002 } })).toBeCloseTo(0.002 + 0.002, 10);
    expect(estimateCostOf(r, { 'zhipu/*': { inputPer1k: 0.001 } })).toBeCloseTo(0.002, 10);
    expect(estimateCostOf(r, {})).toBeNull();
    expect(estimateCostOf({ ...r, cost: 0.5 }, { 'zhipu/glm-4.7-flash': { inputPer1k: 9 } })).toBe(0.5); // 网关已知 cost 优先
  });

  it('summary 三向聚合 + 估算/已知成本分桶 + 工作流派生', async () => {
    const kv = new Map<string, string>();
    kv.set(KV_USAGE_PRICING, JSON.stringify({ 'zhipu/glm-4.7-flash': { inputPer1k: 0.001, outputPer1k: 0.002 } }));
    const deps = makeDeps(
      [
        rowOf({ provider: 'zhipu', model: 'glm-4.7-flash', tokensIn: 2000, tokensOut: 1000, at: '2026-10-14T10:00:00.000Z' }),
        rowOf({ provider: 'zhipu', model: 'glm-4.7-flash', tokensIn: 1000, tokensOut: 0, cost: 0.01, at: '2026-10-13T09:00:00.000Z' }),
        rowOf({ provider: 'custom', model: 'byok-model', tokensIn: 10, tokensOut: 10, traceId: 'other-trace', at: '2026-10-14T11:00:00.000Z' }),
      ],
      kv,
    );
    const usage = createUsageService(deps);
    const summary = await usage.summary({ days: 7 });

    expect(summary.sinceDays).toBe(7);
    expect(summary.totals.calls).toBe(3);
    expect(summary.totals.tokensIn).toBe(3010);
    expect(summary.totals.tokensOut).toBe(1010);
    // 估算行：(2000/1000)*0.001 + (1000/1000)*0.002 = 0.004；已知 0.01；custom 无定价 → unestimated
    expect(summary.totals.costEstimated).toBeCloseTo(0.004, 10);
    expect(summary.totals.costKnown).toBeCloseTo(0.01, 10);
    expect(summary.totals.unestimatedCalls).toBe(1);

    expect(summary.byDay.map((b) => b.key)).toEqual(['2026-10-14', '2026-10-13']);
    expect(summary.byDay[0]?.calls).toBe(2);
    expect(summary.byWorkflow.find((b) => b.key === 'report')?.calls).toBe(2);
    expect(summary.byWorkflow.find((b) => b.key === 'other')?.calls).toBe(1);
    expect(summary.byProviderModel.find((b) => b.key === 'zhipu/glm-4.7-flash')?.calls).toBe(2);
    expect(summary.pricing['zhipu/glm-4.7-flash']).toEqual({ inputPer1k: 0.001, outputPer1k: 0.002 });
  });

  it('探测档展示：五预设 tier/tierSource/reachability 原样透出（04:63）', async () => {
    const usage = createUsageService(makeDeps([], new Map()));
    const summary = await usage.summary();
    expect(summary.providers).toHaveLength(5);
    const zhipu = summary.providers.find((p) => p.provider === 'zhipu');
    expect(zhipu?.tierSource).toBe('probed');
    expect(zhipu?.tier).toBeTruthy();
    expect(zhipu?.reachability).toBe('domestic-ok');
  });

  it('setPricing / setRpmGlobal 落 kv；summary 回读 RPM（0=不限流）', async () => {
    const kv = new Map<string, string>();
    const usage = createUsageService(makeDeps([], kv));
    await usage.setPricing({ 'deepseek/*': { inputPer1k: 0.0005 } });
    expect(JSON.parse(kv.get(KV_USAGE_PRICING) ?? '{}')).toEqual({ 'deepseek/*': { inputPer1k: 0.0005 } });
    await usage.setRpmGlobal(120);
    expect(kv.get(KV_LLM_RPM_GLOBAL)).toBe('120');
    let summary = await usage.summary();
    expect(summary.rpmGlobal).toBe(120);
    await usage.setRpmGlobal(0);
    expect(kv.get(KV_LLM_RPM_GLOBAL)).toBe('0');
    summary = await usage.summary();
    expect(summary.rpmGlobal).toBe(0);
  });

  it('workflowOf：report- 前缀 → report，其余 → other', () => {
    expect(workflowOf('report-8f2c…')).toBe('report');
    expect(workflowOf('tr-llm-1')).toBe('other');
    expect(workflowOf(null)).toBe('other');
  });
});

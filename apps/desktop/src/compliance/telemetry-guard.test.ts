/**
 * 遥测本地守卫单测（todo 9 / FR-12.6 硬验收）：三态（同意/关闭/未征求）× 网络调用断言。
 * mock fetch 计数：关闭态（denied/unasked）必须零网络调用 + 拦截留痕可见；
 * 同意态有端点时恰好一次调用（证明守卫是网络唯一闸门）；M0 无端点 → 仅本地留存。
 */
import { describe, expect, it } from 'vitest';
import {
  createTelemetryGuard,
  TELEMETRY_GUARD_CODES,
  type TelemetryLocalRecord,
} from './telemetry-guard';

/** mock fetch：只计数不联网；返回最小 Response 形状 */
function makeMockFetch(): { fetch: typeof fetch; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: (init as { body?: string } | undefined)?.body ?? '' });
    return { ok: true, status: 202, json: async () => ({}) } as unknown as Response;
  };
  return { fetch: impl, calls };
}

const ENDPOINT = 'https://telemetry.example.invalid/events';

describe('sendTelemetry 三态 × 网络调用（FR-12.6 硬验收）', () => {
  it('同意（consent=true）+ 端点 → 恰好一次网络调用，载荷含事件名', async () => {
    const { fetch, calls } = makeMockFetch();
    const records: TelemetryLocalRecord[] = [];
    const guard = createTelemetryGuard({
      getConsent: () => true,
      endpoint: ENDPOINT,
      fetchFn: fetch,
      onLocalRecord: (r) => records.push(r),
      clock: () => '2026-10-11T00:00:00.000Z',
    });

    const outcome = await guard.sendTelemetry({ name: 'funnel.redeem', payload: { step: 2 } });
    expect(outcome.ok).toBe(true);
    expect(outcome.disposition).toBe('sent');
    expect(outcome.code).toBe(TELEMETRY_GUARD_CODES.SENT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ENDPOINT);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ name: 'funnel.redeem', payload: { step: 2 } });
    expect(records).toHaveLength(0);
  });

  it('关闭（consent=false）+ 端点已配置 → 零网络调用 + 拦截留痕可见', async () => {
    const { fetch, calls } = makeMockFetch();
    const records: TelemetryLocalRecord[] = [];
    const guard = createTelemetryGuard({
      getConsent: () => false,
      endpoint: ENDPOINT,
      fetchFn: fetch,
      onLocalRecord: (r) => records.push(r),
    });

    const outcome = await guard.sendTelemetry({ name: 'funnel.activate', payload: { step: 1 } });
    expect(outcome.ok).toBe(false);
    expect(outcome.disposition).toBe('blocked');
    expect(outcome.code).toBe(TELEMETRY_GUARD_CODES.BLOCKED);
    // 硬验收：关闭状态下零网络调用
    expect(calls).toHaveLength(0);
    // 拦截留痕：可见、带事件名与同意态
    expect(records).toHaveLength(1);
    expect(records[0]?.code).toBe(TELEMETRY_GUARD_CODES.BLOCKED);
    expect(records[0]?.msg).toContain('被拦截的遥测尝试');
    expect(records[0]?.payload).toMatchObject({ eventName: 'funnel.activate', consent: false });
  });

  it('未征求（consent=null）+ 端点已配置 → 零网络调用（opt-in：未征求 ≠ 已同意）', async () => {
    const { fetch, calls } = makeMockFetch();
    const records: TelemetryLocalRecord[] = [];
    const guard = createTelemetryGuard({
      getConsent: () => null,
      endpoint: ENDPOINT,
      fetchFn: fetch,
      onLocalRecord: (r) => records.push(r),
    });

    const outcome = await guard.sendTelemetry({ name: 'circuit-breaker.trip' });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(TELEMETRY_GUARD_CODES.BLOCKED);
    expect(calls).toHaveLength(0);
    expect(records[0]?.payload).toMatchObject({ consent: 'unasked' });
  });
});

describe('M0 生产姿态：无端点（不接真实上报通道）', () => {
  it('同意态 + 无端点 → local-only（事件仅本地留存），fetch 永不被触', async () => {
    const { fetch, calls } = makeMockFetch();
    const records: TelemetryLocalRecord[] = [];
    const guard = createTelemetryGuard({
      getConsent: () => true,
      fetchFn: fetch,
      onLocalRecord: (r) => records.push(r),
    });

    const outcome = await guard.sendTelemetry({ name: 'funnel.first-run' });
    expect(outcome.ok).toBe(true);
    expect(outcome.disposition).toBe('local-only');
    expect(outcome.code).toBe(TELEMETRY_GUARD_CODES.LOCAL_ONLY);
    expect(calls).toHaveLength(0);
    expect(records.map((r) => r.code)).toEqual([TELEMETRY_GUARD_CODES.LOCAL_ONLY]);
  });

  it('关闭态 + 无端点 → 同样零网络调用（端点缺失与同意关闭双闸并联）', async () => {
    const { fetch, calls } = makeMockFetch();
    const records: TelemetryLocalRecord[] = [];
    const guard = createTelemetryGuard({
      getConsent: () => false,
      fetchFn: fetch,
      onLocalRecord: (r) => records.push(r),
    });

    const outcome = await guard.sendTelemetry({ name: 'funnel.x' });
    expect(outcome.disposition).toBe('blocked');
    expect(calls).toHaveLength(0);
    expect(records).toHaveLength(1);
  });
});

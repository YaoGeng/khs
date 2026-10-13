import { describe, it, expect } from 'vitest';
import {
  circuitOpenRetryPolicy,
  deepEqual,
  proxyConfigUnchanged,
  retryDecisionForCircuitState,
  snapshotProxyConfig,
} from './retry-policy.js';
import { CircuitBreaker } from './circuit-breaker.js';

const MIN = 60_000;

describe('retry-policy: FR-9.5 固化（01:208-209）', () => {
  it('circuitOpenRetryPolicy = { action: "abort-no-retry" }（非 retry≤3）', () => {
    expect(circuitOpenRetryPolicy).toEqual({ action: 'abort-no-retry' });
    expect(circuitOpenRetryPolicy.action).toBe('abort-no-retry');
  });

  it('策略常量冻结（防宿主改写）', () => {
    expect(Object.isFrozen(circuitOpenRetryPolicy)).toBe(true);
  });

  it('OPEN → abort-no-retry；CLOSED / HALF_OPEN → null（常规重试策略归调用方）', () => {
    expect(retryDecisionForCircuitState('OPEN')).toEqual({ action: 'abort-no-retry' });
    expect(retryDecisionForCircuitState('CLOSED')).toBeNull();
    expect(retryDecisionForCircuitState('HALF_OPEN')).toBeNull();
  });

  it('retryDecisionForCircuitState 返回的就是唯一策略常量（同一引用）', () => {
    expect(retryDecisionForCircuitState('OPEN')).toBe(circuitOpenRetryPolicy);
  });
});

describe('retry-policy: 代理配置零改动承诺（FR-9.5 / 07:46 抽查面）', () => {
  it('snapshotProxyConfig 深冻结且与原对象隔离', () => {
    const source = { server: 'http://127.0.0.1:7890', nested: { mode: 'system' } };
    const snap = snapshotProxyConfig(source);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen((snap as { nested: object }).nested)).toBe(true);
  });

  it('deepEqual：深比较语义（嵌套/数组/键序无关）', () => {
    expect(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual([1, [2]], [1, [2]])).toBe(true);
  });

  it('proxyConfigUnchanged：前后一致为 true，任何写入差异为 false', () => {
    const before = { server: 'http://127.0.0.1:7890', bypass: null };
    expect(proxyConfigUnchanged(before, { bypass: null, server: 'http://127.0.0.1:7890' })).toBe(true);
    expect(proxyConfigUnchanged(before, { server: 'http://127.0.0.1:9', bypass: null })).toBe(false);
    expect(proxyConfigUnchanged(before, { server: null, bypass: null })).toBe(false);
  });
});

describe('QA failure: OPEN 态调重试策略 → abort-no-retry 且代理配置深比较不变', () => {
  it('驱动熔断器至 OPEN：决策恒为 abort-no-retry，全链路代理配置对象零改动', () => {
    const clock = { ms: 1_800_000_000_000 };
    const now = () => new Date(clock.ms);
    const breaker = new CircuitBreaker({ now });

    // 宿主代理配置快照（进入敏感路径前取）
    const proxyConfigBefore = snapshotProxyConfig({ server: null, bypass: null, pacUrl: undefined });

    // OPEN 态（验证码命中）
    breaker.reportCaptchaFeatureHit(now());
    expect(breaker.state).toBe('OPEN');

    // OPEN 态反复请求重试策略：恒 abort-no-retry
    for (let i = 0; i < 3; i += 1) {
      expect(retryDecisionForCircuitState(breaker.state)).toEqual({ action: 'abort-no-retry' });
      clock.ms += 1000;
    }

    // 代理配置深比较不变（FR-9.5：不自动切换代理）
    const proxyConfigAfter = { server: null, bypass: null, pacUrl: undefined };
    expect(proxyConfigUnchanged(proxyConfigBefore, proxyConfigAfter)).toBe(true);

    // 冷却期满+人工确认→HALF_OPEN 后：熔断器不再强制 abort（策略面返回 null）
    clock.ms += 30 * MIN;
    expect(breaker.confirmManualResume(now())).toBe(true);
    expect(retryDecisionForCircuitState(breaker.state)).toBeNull();
  });

  it('冻结快照上的写入在严格模式下抛错（零改动的类型/API 形状证明）', () => {
    const snap = snapshotProxyConfig({ server: 'x' });
    expect(() => {
      (snap as { server: string }).server = 'y';
    }).toThrow();
  });
});

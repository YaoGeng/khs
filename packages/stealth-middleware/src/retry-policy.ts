/**
 * FR-9.5 固化：熔断 OPEN 态重试策略与代理配置零改动承诺（01:208-209；07:46 M1 门禁抽查项）。
 *
 * 类型/API 形状承诺：
 * - `RetryAction` 只有 `'abort-no-retry'` 一个成员——「OPEN 态自动重试」「自动切换代理」
 *   在类型层面不存在（非 retry≤3，也非 switch-proxy 变体）；
 * - 代理配置以只读快照 + 深比较工具呈现：任何熔断路径都不产生代理配置写入。
 */

import type { CircuitState } from './circuit-breaker.js';

/** 重试动作：唯一成员 abort-no-retry（FR-9.5：OPEN 态终止而非重试）。 */
export type RetryAction = 'abort-no-retry';

export interface RetryDecision {
  readonly action: RetryAction;
}

/** OPEN 态重试策略（唯一策略常量；todo-7 采集 DAG 消费）。 */
export const circuitOpenRetryPolicy: Readonly<RetryDecision> = Object.freeze({ action: 'abort-no-retry' } as const);

/**
 * 按熔断状态给出重试约束：
 * - OPEN → circuitOpenRetryPolicy（abort-no-retry）；
 * - CLOSED / HALF_OPEN → null（熔断器不介入，由调用方常规重试策略——指数退避 ≤3——自行决策）。
 */
export function retryDecisionForCircuitState(state: CircuitState): Readonly<RetryDecision> | null {
  return state === 'OPEN' ? circuitOpenRetryPolicy : null;
}

/** 代理配置只读形状（键值面收窄为字符串/null，禁止宿主塞入可变句柄）。 */
export type ProxyConfig = Readonly<Record<string, string | null | undefined>>;

/** 深冻结快照：宿主在进入熔断敏感路径前取快照，事后比对「零改动」。 */
export function snapshotProxyConfig<T extends object>(config: T): Readonly<T> {
  const clone = Array.isArray(config) ? ([...config] as unknown as T) : ({ ...config } as T);
  for (const [k, v] of Object.entries(clone)) {
    if (v !== null && typeof v === 'object') {
      (clone as Record<string, unknown>)[k] = snapshotProxyConfig(v as object);
    }
  }
  return Object.isFrozen(clone) ? clone : Object.freeze(clone);
}

/** 深比较相等（plain object/array/原始值）；用于 FR-9.5 抽查「代理配置深比较不变」。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** 代理配置零改动断言（纯函数；FR-9.5 抽查与宿主防御共用）。 */
export function proxyConfigUnchanged(before: unknown, after: unknown): boolean {
  return deepEqual(before, after);
}

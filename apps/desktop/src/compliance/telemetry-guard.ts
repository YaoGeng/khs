/**
 * 遥测本地守卫（todo 9 = T-M0-11；FR-12.6；electron-free，vitest 直测）。
 *
 * 定位（任务卡「本地守卫（硬验收）」）：全应用遥测发送的**唯一出口** sendTelemetry(event)。
 * - 同意态 !== true（denied / unasked）→ 拒绝发送并写「被拦截的遥测尝试」本地日志，不触任何网络；
 * - 同意态 === true 且未配置端点（M0 恒为此态：真实上报器归 M1 T-M1-07）→ 事件仅本地留存；
 * - 同意态 === true 且配置端点（M1 注入）→ 经注入的 fetch 上报。
 *
 * opt-in 语义（FR-12.6 + PC-02）：默认不勾选；unasked（未征求）与 denied（已拒绝）都按
 * 关闭处理——「未征求 ≠ 已同意」。
 *
 * 网络断言口径（单测）：endpoint + mock fetch 同时注入时，关闭态必须零调用——
 * 证明本守卫是网络行为的唯一闸门；M0 生产装配不传 endpoint，即不存在任何真实上报通道。
 */

/** 遥测同意态：true=已同意 / false=已拒绝或已关闭 / null=尚未征求（unasked） */
export type TelemetryConsent = boolean | null;

export interface TelemetryEvent {
  /** 事件名（漏斗/熔断/埋点事件面归 M1 T-M1-07） */
  readonly name: string;
  readonly payload?: unknown;
  /** ISO 时间；缺省取 deps.clock */
  readonly at?: string;
}

export type TelemetryDisposition = 'sent' | 'local-only' | 'blocked';

export interface TelemetrySendOutcome {
  readonly ok: boolean;
  readonly disposition: TelemetryDisposition;
  /** 稳定码：TELEMETRY-SENT / TELEMETRY-LOCAL-ONLY / E-TELEMETRY-CONSENT-OFF */
  readonly code: string;
  readonly reason: string;
}

/** 本地留痕条目（注入 T11 logger 或测试 spy；实现必须只写本地，不得产生网络行为） */
export interface TelemetryLocalRecord {
  readonly code: string;
  readonly msg: string;
  readonly payload?: unknown;
}

export interface TelemetryGuardDeps {
  /** 同意态唯一来源（compliance 服务快照；严格 === true 才放行） */
  readonly getConsent: () => TelemetryConsent;
  /** 上报端点——M0 生产装配恒不传（不接真实上报通道）；M1 T-M1-07 接入 */
  readonly endpoint?: string;
  /** 网络实现注入（测试 mock 断言零调用；缺省 globalThis.fetch） */
  readonly fetchFn?: typeof fetch;
  /** 本地留痕出口（被拦截尝试 / 本地留存事件） */
  readonly onLocalRecord?: (record: TelemetryLocalRecord) => void;
  /** 时钟注入（测试用） */
  readonly clock?: () => string;
}

export interface TelemetryGuard {
  /** 全应用遥测发送唯一出口 */
  sendTelemetry(event: TelemetryEvent): Promise<TelemetrySendOutcome>;
}

export const TELEMETRY_GUARD_CODES = {
  SENT: 'TELEMETRY-SENT',
  LOCAL_ONLY: 'TELEMETRY-LOCAL-ONLY',
  BLOCKED: 'E-TELEMETRY-CONSENT-OFF',
} as const;

export function createTelemetryGuard(deps: TelemetryGuardDeps): TelemetryGuard {
  const clock = deps.clock ?? ((): string => new Date().toISOString());

  async function sendTelemetry(event: TelemetryEvent): Promise<TelemetrySendOutcome> {
    const consent = deps.getConsent();
    const at = event.at ?? clock();

    if (consent !== true) {
      deps.onLocalRecord?.({
        code: TELEMETRY_GUARD_CODES.BLOCKED,
        msg: '被拦截的遥测尝试（FR-12.6 opt-in 关闭态）：事件未发出，仅本地留痕',
        payload: { eventName: event.name, consent: consent ?? 'unasked', at },
      });
      return {
        ok: false,
        disposition: 'blocked',
        code: TELEMETRY_GUARD_CODES.BLOCKED,
        reason: `遥测同意态为 ${consent ?? 'unasked'}（需 true）：已拦截并本地留痕，未发起任何网络请求`,
      };
    }

    if (!deps.endpoint) {
      deps.onLocalRecord?.({
        code: TELEMETRY_GUARD_CODES.LOCAL_ONLY,
        msg: '遥测已同意但上报端点未接入（M0 无上报通道，真实上报器归 M1 T-M1-07）：事件仅本地留存',
        payload: { eventName: event.name, at },
      });
      return {
        ok: true,
        disposition: 'local-only',
        code: TELEMETRY_GUARD_CODES.LOCAL_ONLY,
        reason: '同意态放行，但当前无上报端点：事件仅本地留存',
      };
    }

    const fetchImpl = deps.fetchFn ?? globalThis.fetch;
    await fetchImpl(deps.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: event.name, payload: event.payload ?? null, at }),
    });
    return {
      ok: true,
      disposition: 'sent',
      code: TELEMETRY_GUARD_CODES.SENT,
      reason: '同意态放行且端点已配置：事件已交由网络实现上报',
    };
  }

  return { sendTelemetry };
}

/**
 * 熔断器（CircuitBreaker）与风控信号窗口计数 —— T-M1-03 / 02-系统架构设计.md §7.3。
 *
 * §7.5 参数表引用值（照抄，不自行发明）：
 *   breaker.open_signals          验证码出现 / HTTP 429 或 401 突增 / 评论失败率 >20%（10min 窗口） §7.3（:346）
 *   breaker.cooldown_to_half_open 冷却 30min + 人工确认                                              §7.3（:347）
 *   breaker.half_open_probe       试探成功→CLOSED；试探失败→OPEN 且冷却翻倍（60min）                   §7.3（:348-349）
 *   breaker.telemetry             熔断事件全量上报遥测（不含内容）                                     §7.3（:354）
 *
 * 边界（任务书 Must NOT do）：不落 XState（S9：只有任务生命周期进 XState）；本机为纯 TS 状态机。
 * 信号源协议 RiskSignalFeed 在此定义（429/401 计数、验证码特征命中、步骤失败率），真实信号源由
 * todo-4（adapter blockedFeatures 匹配）/ todo-7（network 层）接线。
 * FR-9.5：OPEN 态不自动重试、不自动切代理——重试策略面见 retry-policy.ts。
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type CircuitOpenReason = 'captcha-hit' | 'http-429-401-burst' | 'failure-rate' | 'probe-failed';

export type CircuitEventKind = 'circuit_open' | 'circuit_half_open' | 'circuit_closed';

export type CircuitEventReason = CircuitOpenReason | 'manual-confirm' | 'probe-success';

/**
 * 熔断事件（遥测载荷）：只有 kind/at/reason 三个机读字段——
 * 不含任何笔记内容/URL/账号字段（02 §7.3 :354「不含内容」）。
 */
export interface CircuitEvent {
  kind: CircuitEventKind;
  /** ISO 时间戳（注入时钟） */
  at: string;
  reason: CircuitEventReason;
}

export interface CircuitEventEmitter {
  emit(event: CircuitEvent): void;
}

/** OPEN 态任务挂起回调（todo-7 采集 DAG 注册：挂起全部 running 任务 + 桌面通知引导人工确认）。 */
export type SuspendCallback = (notice: { reason: CircuitOpenReason; at: string }) => void | Promise<void>;

/**
 * 窗口计数 hook 协议：本卡定义协议形状，信号源 todo-4/7 接线。
 * （对应 §7.3 :366「信号源：页面 DOM 检测（验证码组件）、网络层状态码统计、步骤失败率滑动窗口」）
 */
export interface RiskSignalFeed {
  /** 网络层状态码计数：429/401 计入 5min 滚窗；其余状态码忽略 */
  reportHttpStatus(status: number, at?: Date): void;
  /** 验证码/风控特征命中（adapter blockedFeatures 匹配、DOM 验证码组件检测） */
  reportCaptchaFeatureHit(at?: Date): void;
  /** 步骤结果计数：进入 10min 失败率滑窗 */
  reportStepOutcome(outcome: 'success' | 'failure', at?: Date): void;
}

export interface CircuitBreakerOptions {
  /** 时钟注入（冷却/滑窗判定全部经此；测试以 fake clock 覆盖） */
  now?: () => Date;
  /** 熔断事件出口（宿主接 sendTelemetry 唯一出口，02 §7.3 :354；缺省丢弃） */
  emitter?: CircuitEventEmitter;
  /** OPEN→HALF_OPEN 冷却（缺省 30min） */
  cooldownToHalfOpenMs?: number;
  /** 429|401 突增滑窗（缺省 5min） */
  httpBurstWindowMs?: number;
  /** 429|401 突增阈值 ≥N（缺省 3） */
  httpBurstThreshold?: number;
  /** 失败率滑窗（缺省 10min） */
  failureRateWindowMs?: number;
  /** 失败率阈值 >x（缺省 0.2） */
  failureRateThreshold?: number;
}

/** §7.3 缺省参数（与 §7.5 参数表一致）。 */
export const CIRCUIT_DEFAULTS = Object.freeze({
  cooldownToHalfOpenMs: 30 * 60_000,
  httpBurstWindowMs: 5 * 60_000,
  httpBurstThreshold: 3,
  failureRateWindowMs: 10 * 60_000,
  failureRateThreshold: 0.2,
});

interface StepEvent {
  atMs: number;
  ok: boolean;
}

/**
 * 熔断状态机：CLOSED→OPEN→（冷却+人工确认）→HALF_OPEN→（试探成功）CLOSED /（试探失败）OPEN+冷却×2。
 * 滑窗为半开区间 (now - windowMs, now]：恰好满 windowMs 的旧事件过期。
 * 失败率 = 窗口内失败步 / 窗口内全部步（分母即窗口样本量，不设额外最小样本数——
 * :346 阈值语义照抄为严格大于，信号源接线方（todo-4/7）可自行对瞬时抖动去抖）。
 */
export class CircuitBreaker implements RiskSignalFeed {
  private readonly now: () => Date;
  private readonly emitter: CircuitEventEmitter;
  private readonly cooldownBaseMs: number;
  private readonly httpBurstWindowMs: number;
  private readonly httpBurstThreshold: number;
  private readonly failureRateWindowMs: number;
  private readonly failureRateThreshold: number;

  private state_: CircuitState = 'CLOSED';
  private cooldownMs: number;
  private openedAtMs: number | null = null;
  private httpEvents: number[] = [];
  private stepEvents: StepEvent[] = [];
  private readonly suspendCallbacks = new Set<SuspendCallback>();

  constructor(opts: CircuitBreakerOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.emitter = opts.emitter ?? { emit: () => {} };
    this.cooldownBaseMs = opts.cooldownToHalfOpenMs ?? CIRCUIT_DEFAULTS.cooldownToHalfOpenMs;
    this.httpBurstWindowMs = opts.httpBurstWindowMs ?? CIRCUIT_DEFAULTS.httpBurstWindowMs;
    this.httpBurstThreshold = opts.httpBurstThreshold ?? CIRCUIT_DEFAULTS.httpBurstThreshold;
    this.failureRateWindowMs = opts.failureRateWindowMs ?? CIRCUIT_DEFAULTS.failureRateWindowMs;
    this.failureRateThreshold = opts.failureRateThreshold ?? CIRCUIT_DEFAULTS.failureRateThreshold;
    this.cooldownMs = this.cooldownBaseMs;
  }

  get state(): CircuitState {
    return this.state_;
  }

  get cooldownToHalfOpenMs(): number {
    return this.cooldownMs;
  }

  get openedAt(): Date | null {
    return this.openedAtMs === null ? null : new Date(this.openedAtMs);
  }

  /** OPEN 态剩余冷却 ms（非 OPEN 态为 0）。 */
  cooldownRemainingMs(at: Date = this.now()): number {
    if (this.state_ !== 'OPEN' || this.openedAtMs === null) return 0;
    return Math.max(0, this.cooldownMs - (at.getTime() - this.openedAtMs));
  }

  /** 注册 OPEN 挂起回调；返回反注册函数。回调异常不反噬状态机。 */
  onSuspend(cb: SuspendCallback): () => void {
    this.suspendCallbacks.add(cb);
    return () => {
      this.suspendCallbacks.delete(cb);
    };
  }

  /** CLOSED 才可放行（HALF_OPEN 的试探由宿主显式驱动 recordProbe*）。 */
  canProceed(): boolean {
    return this.state_ === 'CLOSED';
  }

  reportHttpStatus(status: number, at?: Date): void {
    if (status !== 429 && status !== 401) return;
    const atMs = (at ?? this.now()).getTime();
    this.httpEvents = this.prune(this.httpEvents, atMs, this.httpBurstWindowMs);
    if (this.state_ !== 'CLOSED') return;
    this.httpEvents.push(atMs);
    if (this.httpEvents.length >= this.httpBurstThreshold) this.open('http-429-401-burst', atMs);
  }

  reportCaptchaFeatureHit(at?: Date): void {
    if (this.state_ !== 'CLOSED') return;
    this.open('captcha-hit', (at ?? this.now()).getTime());
  }

  reportStepOutcome(outcome: 'success' | 'failure', at?: Date): void {
    const atMs = (at ?? this.now()).getTime();
    if (this.state_ === 'CLOSED') this.stepEvents.push({ atMs, ok: outcome === 'success' });
    if (this.state_ !== 'CLOSED') return;
    this.stepEvents = this.stepEvents.filter((e) => atMs - e.atMs < this.failureRateWindowMs);
    if (this.stepEvents.length === 0) return;
    const failures = this.stepEvents.filter((e) => !e.ok).length;
    const rate = failures / this.stepEvents.length;
    if (rate > this.failureRateThreshold) this.open('failure-rate', atMs);
  }

  /**
   * 人工确认恢复（设置页入口）：OPEN 且冷却期满 → HALF_OPEN。
   * 冷却未期满调用无效（返回 false）——「冷却 30min + 人工确认」两条件缺一不可（§7.3 :347）。
   */
  confirmManualResume(at: Date = this.now()): boolean {
    if (this.state_ !== 'OPEN') return false;
    if (this.cooldownRemainingMs(at) > 0) return false;
    this.state_ = 'HALF_OPEN';
    this.emit('circuit_half_open', 'manual-confirm', at);
    return true;
  }

  /** HALF_OPEN 试探成功 → CLOSED：冷却复位为基础值，滑窗清零重新计数。 */
  recordProbeSuccess(at: Date = this.now()): boolean {
    if (this.state_ !== 'HALF_OPEN') return false;
    this.state_ = 'CLOSED';
    this.cooldownMs = this.cooldownBaseMs;
    this.openedAtMs = null;
    this.httpEvents = [];
    this.stepEvents = [];
    this.emit('circuit_closed', 'probe-success', at);
    return true;
  }

  /** HALF_OPEN 试探失败 → OPEN 且冷却翻倍（§7.3 :348-349：30min→60min→…）。 */
  recordProbeFailure(at: Date = this.now()): boolean {
    if (this.state_ !== 'HALF_OPEN') return false;
    this.cooldownMs = this.cooldownMs * 2;
    this.open('probe-failed', at.getTime());
    return true;
  }

  snapshot(at: Date = this.now()): {
    state: CircuitState;
    openedAt: string | null;
    cooldownMs: number;
    cooldownRemainingMs: number;
    httpErrorsInWindow: number;
    failureRateInWindow: number | null;
  } {
    const atMs = at.getTime();
    const windowSteps = this.stepEvents.filter((e) => atMs - e.atMs < this.failureRateWindowMs);
    return {
      state: this.state_,
      openedAt: this.openedAtMs === null ? null : new Date(this.openedAtMs).toISOString(),
      cooldownMs: this.cooldownMs,
      cooldownRemainingMs: this.cooldownRemainingMs(at),
      httpErrorsInWindow: this.prune(this.httpEvents, atMs, this.httpBurstWindowMs).length,
      failureRateInWindow:
        windowSteps.length === 0
          ? null
          : windowSteps.filter((e) => !e.ok).length / windowSteps.length,
    };
  }

  private open(reason: CircuitOpenReason, atMs: number): void {
    this.state_ = 'OPEN';
    this.openedAtMs = atMs;
    this.httpEvents = [];
    this.stepEvents = [];
    this.emit('circuit_open', reason, new Date(atMs));
    for (const cb of this.suspendCallbacks) {
      try {
        const r = cb({ reason, at: new Date(atMs).toISOString() });
        if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => {});
      } catch {
        // 挂起回调异常不反噬状态机（宿主自行兜底）
      }
    }
  }

  private emit(kind: CircuitEventKind, reason: CircuitEventReason, at: Date): void {
    this.emitter.emit({ kind, at: at.toISOString(), reason });
  }

  private prune(events: number[], nowMs: number, windowMs: number): number[] {
    return events.filter((atMs) => nowMs - atMs < windowMs);
  }
}

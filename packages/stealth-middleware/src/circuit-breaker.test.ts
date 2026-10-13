import { describe, it, expect, vi } from 'vitest';
import {
  CIRCUIT_DEFAULTS,
  CircuitBreaker,
  type CircuitEvent,
  type CircuitEventEmitter,
  type SuspendCallback,
} from './circuit-breaker.js';

const MIN = 60_000;

/** fake clock：毫秒推进 */
function fakeClock(startMs = 1_800_000_000_000) {
  let nowMs = startMs;
  return {
    now: () => new Date(nowMs),
    at: () => new Date(nowMs),
    advance: (deltaMs: number) => {
      nowMs += deltaMs;
      return new Date(nowMs);
    },
    jumpTo: (ms: number) => {
      nowMs = ms;
      return new Date(nowMs);
    },
    get nowMs() {
      return nowMs;
    },
  };
}

function collector(): { events: CircuitEvent[]; emitter: CircuitEventEmitter } {
  const events: CircuitEvent[] = [];
  return { events, emitter: { emit: (e) => events.push(e) } };
}

describe('circuit: 初始态与参数缺省（02 §7.3）', () => {
  it('初始 CLOSED 且 canProceed=true', () => {
    const breaker = new CircuitBreaker({ now: fakeClock().now });
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.canProceed()).toBe(true);
  });

  it('缺省参数 = §7.5 参数表（30min / 5min≥3 / 10min>20%）', () => {
    expect(CIRCUIT_DEFAULTS.cooldownToHalfOpenMs).toBe(30 * MIN);
    expect(CIRCUIT_DEFAULTS.httpBurstWindowMs).toBe(5 * MIN);
    expect(CIRCUIT_DEFAULTS.httpBurstThreshold).toBe(3);
    expect(CIRCUIT_DEFAULTS.failureRateWindowMs).toBe(10 * MIN);
    expect(CIRCUIT_DEFAULTS.failureRateThreshold).toBe(0.2);
  });
});

describe('circuit: CLOSED→OPEN 触发信号（§7.3 :346）', () => {
  it('验证码特征命中 → OPEN + circuit_open 事件 + 挂起回调', () => {
    const clock = fakeClock();
    const { events, emitter } = collector();
    const breaker = new CircuitBreaker({ now: clock.now, emitter });
    const suspended: string[] = [];
    breaker.onSuspend((n) => {
      suspended.push(n.reason);
    });

    breaker.reportCaptchaFeatureHit(clock.at());
    expect(breaker.state).toBe('OPEN');
    expect(breaker.canProceed()).toBe(false);
    expect(suspended).toEqual(['captcha-hit']);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'circuit_open', at: events[0].at, reason: 'captcha-hit' });
  });

  it('2 次 429（5min 窗内）不触发', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    breaker.reportHttpStatus(429, clock.at());
    clock.advance(30_000);
    breaker.reportHttpStatus(429, clock.at());
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.canProceed()).toBe(true);
  });

  it('第 3 次 429（5min 窗内）→ OPEN', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    breaker.reportHttpStatus(429, clock.at());
    clock.advance(60_000);
    breaker.reportHttpStatus(429, clock.at());
    clock.advance(60_000);
    breaker.reportHttpStatus(429, clock.at());
    expect(breaker.state).toBe('OPEN');
  });

  it('401 与 429 混合计数同窗可达阈值；其他状态码忽略', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    breaker.reportHttpStatus(200, clock.at());
    breaker.reportHttpStatus(500, clock.at());
    breaker.reportHttpStatus(401, clock.at());
    clock.advance(1000);
    breaker.reportHttpStatus(429, clock.at());
    clock.advance(1000);
    breaker.reportHttpStatus(403, clock.at());
    clock.advance(1000);
    breaker.reportHttpStatus(401, clock.at());
    expect(breaker.state).toBe('OPEN');
  });

  it('窗口过期：前两次 429 距今超过 5min 后不计入', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    breaker.reportHttpStatus(429, clock.at());
    clock.advance(60_000);
    breaker.reportHttpStatus(429, clock.at());
    clock.advance(5 * MIN); // 首个事件恰好过期（半开区间）
    breaker.reportHttpStatus(429, clock.at());
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.snapshot().httpErrorsInWindow).toBe(1);
  });

  it('边界：事件年龄恰 = windowMs 过期（now-5min 时的第 3 次不计数）', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    const t0 = clock.nowMs;
    clock.jumpTo(t0 + MIN);
    breaker.reportHttpStatus(429, clock.at());
    clock.jumpTo(t0 + 2 * MIN);
    breaker.reportHttpStatus(429, clock.at());
    clock.jumpTo(t0 + 2 * MIN + 5 * MIN); // t0+MIN 的事件年龄 = 5min → 过期
    breaker.reportHttpStatus(429, clock.at());
    expect(breaker.state).toBe('CLOSED');
  });

  it('失败率边界：1/5 恰 20% 不触发（须 >20%），第 2 次失败 2/6≈33% → OPEN', () => {
    const clock = fakeClock();
    const { events, emitter } = collector();
    const breaker = new CircuitBreaker({ now: clock.now, emitter });
    for (let i = 0; i < 4; i += 1) {
      breaker.reportStepOutcome('success', clock.at());
      clock.advance(1000);
    }
    breaker.reportStepOutcome('failure', clock.at());
    clock.advance(1000);
    // 1/5 = 恰 20%，阈值语义为严格大于 → 仍 CLOSED
    expect(breaker.snapshot().failureRateInWindow).toBeCloseTo(0.2, 5);
    expect(breaker.state).toBe('CLOSED');
    breaker.reportStepOutcome('failure', clock.at());
    expect(breaker.state).toBe('OPEN');
    expect(events.map((e) => e.kind)).toEqual(['circuit_open']);
    expect(events[0].reason).toBe('failure-rate');
  });

  it('失败率字面语义：窗口内首步即失败（1/1 = 100% > 20%）→ OPEN（分母=窗口样本量，:346 照抄）', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    breaker.reportStepOutcome('failure', clock.at());
    expect(breaker.state).toBe('OPEN');
  });

  it('失败率窗口过期：窗口内 20% 组合的失败步滑出 10min 窗后不再计数', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < 4; i += 1) {
      breaker.reportStepOutcome('success', clock.at());
      clock.advance(1000);
    }
    breaker.reportStepOutcome('failure', clock.at());
    expect(breaker.state).toBe('CLOSED');
    clock.advance(10 * MIN); // 上述 5 步年龄全部 ≥10min → 过期
    breaker.reportStepOutcome('success', clock.at());
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.snapshot().failureRateInWindow).toBe(0);
  });
});

describe('circuit: OPEN→HALF_OPEN（冷却 30min + 人工确认 §7.3 :347）', () => {
  it('冷却未期满人工确认无效（两条件缺一不可）', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    breaker.reportCaptchaFeatureHit(clock.at());
    clock.advance(29 * MIN + 59_999);
    expect(breaker.confirmManualResume(clock.at())).toBe(false);
    expect(breaker.state).toBe('OPEN');
  });

  it('冷却期满 + 人工确认 → HALF_OPEN + circuit_half_open 事件', () => {
    const clock = fakeClock();
    const { events, emitter } = collector();
    const breaker = new CircuitBreaker({ now: clock.now, emitter });
    breaker.reportCaptchaFeatureHit(clock.at());
    clock.advance(30 * MIN);
    expect(breaker.confirmManualResume(clock.at())).toBe(true);
    expect(breaker.state).toBe('HALF_OPEN');
    expect(breaker.canProceed()).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(['circuit_open', 'circuit_half_open']);
    expect(events[1].reason).toBe('manual-confirm');
  });

  it('OPEN 态期间的信号不再重复触发 OPEN（事件不重复）', () => {
    const clock = fakeClock();
    const { events, emitter } = collector();
    const breaker = new CircuitBreaker({ now: clock.now, emitter });
    breaker.reportCaptchaFeatureHit(clock.at());
    breaker.reportCaptchaFeatureHit(clock.at());
    breaker.reportHttpStatus(429, clock.at());
    breaker.reportHttpStatus(429, clock.at());
    breaker.reportHttpStatus(429, clock.at());
    expect(events.filter((e) => e.kind === 'circuit_open')).toHaveLength(1);
  });
});

describe('circuit: HALF_OPEN 试探（§7.3 :348-349，含冷却×2）', () => {
  const toHalfOpen = (breaker: CircuitBreaker, clock: ReturnType<typeof fakeClock>) => {
    breaker.reportCaptchaFeatureHit(clock.at());
    clock.advance(30 * MIN);
    expect(breaker.confirmManualResume(clock.at())).toBe(true);
  };

  it('试探成功 → CLOSED + circuit_closed 事件；滑窗清零重新计数', () => {
    const clock = fakeClock();
    const { events, emitter } = collector();
    const breaker = new CircuitBreaker({ now: clock.now, emitter });
    toHalfOpen(breaker, clock);
    clock.advance(10_000);
    expect(breaker.recordProbeSuccess(clock.at())).toBe(true);
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.canProceed()).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(['circuit_open', 'circuit_half_open', 'circuit_closed']);
    expect(events[2].reason).toBe('probe-success');
  });

  it('试探失败 → OPEN 且冷却翻倍 30min→60min', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    toHalfOpen(breaker, clock);
    clock.advance(10_000);
    expect(breaker.recordProbeFailure(clock.at())).toBe(true);
    expect(breaker.state).toBe('OPEN');
    expect(breaker.cooldownToHalfOpenMs).toBe(60 * MIN);
  });

  it('翻倍冷却生效：再开 30min 后确认无效，满 60min 后确认成功', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    toHalfOpen(breaker, clock);
    clock.advance(10_000);
    breaker.recordProbeFailure(clock.at());
    clock.advance(30 * MIN);
    expect(breaker.confirmManualResume(clock.at())).toBe(false);
    clock.advance(30 * MIN); // 累计 60min
    expect(breaker.confirmManualResume(clock.at())).toBe(true);
    expect(breaker.state).toBe('HALF_OPEN');
  });

  it('连续试探失败继续翻倍：60min→120min（每次×2）', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    toHalfOpen(breaker, clock);
    breaker.recordProbeFailure(clock.at());
    clock.advance(60 * MIN);
    expect(breaker.confirmManualResume(clock.at())).toBe(true);
    breaker.recordProbeFailure(clock.at());
    expect(breaker.cooldownToHalfOpenMs).toBe(120 * MIN);
  });

  it('试探成功后冷却复位为基础 30min（不遗留翻倍）', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    toHalfOpen(breaker, clock);
    breaker.recordProbeFailure(clock.at());
    clock.advance(60 * MIN);
    expect(breaker.confirmManualResume(clock.at())).toBe(true);
    expect(breaker.recordProbeSuccess(clock.at())).toBe(true);
    expect(breaker.cooldownToHalfOpenMs).toBe(30 * MIN);
    // 复位验证：再次 OPEN 后 30min 冷却即可确认
    breaker.reportCaptchaFeatureHit(clock.at());
    clock.advance(30 * MIN);
    expect(breaker.confirmManualResume(clock.at())).toBe(true);
  });
});

describe('circuit: 挂起回调（SuspendCallback，todo-7 注册）', () => {
  it('每次进入 OPEN 都触发回调；反注册后不再触发', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    const cb = vi.fn<SuspendCallback>();
    const off = breaker.onSuspend(cb);
    breaker.reportCaptchaFeatureHit(clock.at());
    clock.advance(30 * MIN);
    breaker.confirmManualResume(clock.at());
    breaker.recordProbeFailure(clock.at());
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0][0].reason).toBe('captcha-hit');
    expect(cb.mock.calls[1][0].reason).toBe('probe-failed');
    off();
    clock.advance(60 * MIN);
    breaker.confirmManualResume(clock.at());
    breaker.recordProbeFailure(clock.at());
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('回调抛错/拒绝不反噬状态机', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    breaker.onSuspend(() => {
      throw new Error('host suspend failed');
    });
    breaker.onSuspend(() => Promise.reject(new Error('async suspend failed')));
    expect(() => breaker.reportCaptchaFeatureHit(clock.at())).not.toThrow();
    expect(breaker.state).toBe('OPEN');
  });
});

describe('circuit: 事件形状（02 §7.3 :354 不含内容字段）', () => {
  it('事件只有 kind/at/reason 三个字段，无任何内容字段', () => {
    const clock = fakeClock();
    const { events, emitter } = collector();
    const breaker = new CircuitBreaker({ now: clock.now, emitter });
    breaker.reportCaptchaFeatureHit(clock.at());
    clock.advance(30 * MIN);
    breaker.confirmManualResume(clock.at());
    breaker.recordProbeSuccess(clock.at());
    for (const e of events) expect(Object.keys(e).sort()).toEqual(['at', 'kind', 'reason']);
    for (const e of events) expect(Object.values(e).join(' ')).not.toMatch(/note|title|url|cookie/i);
  });
});

describe('QA happy: fake clock 全链 CLOSED→OPEN→30min→HALF_OPEN→试探成功→CLOSED', () => {
  it('事件序列 [open, half_open, closed] 且全程未触发冷却×2（保持 30min）', () => {
    const clock = fakeClock();
    const { events, emitter } = collector();
    const breaker = new CircuitBreaker({ now: clock.now, emitter });
    const suspended: string[] = [];
    breaker.onSuspend((n) => {
      suspended.push(n.reason);
    });

    // CLOSED：正常放行
    expect(breaker.canProceed()).toBe(true);
    // CLOSED→OPEN（验证码命中）
    breaker.reportCaptchaFeatureHit(clock.at());
    expect(breaker.state).toBe('OPEN');
    expect(suspended).toEqual(['captcha-hit']);
    // 冷却 30min（未翻倍：全程 cooldown 恒 30min）
    clock.advance(30 * MIN);
    expect(breaker.cooldownToHalfOpenMs).toBe(30 * MIN);
    // OPEN→HALF_OPEN（人工确认）
    expect(breaker.confirmManualResume(clock.at())).toBe(true);
    expect(breaker.state).toBe('HALF_OPEN');
    // 试探成功 → CLOSED
    clock.advance(5_000);
    expect(breaker.recordProbeSuccess(clock.at())).toBe(true);
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.canProceed()).toBe(true);

    expect(events.map((e) => e.kind)).toEqual(['circuit_open', 'circuit_half_open', 'circuit_closed']);
    expect(breaker.cooldownToHalfOpenMs).toBe(30 * MIN); // 冷却×2 全程未触发
    expect(suspended).toEqual(['captcha-hit']); // 挂起仅一次（成功路径不二次挂起）
  });
});

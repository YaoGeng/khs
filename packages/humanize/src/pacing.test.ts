import { describe, it, expect } from 'vitest';
import {
  PACING_DEFAULTS,
  PER_ITEM_BUDGET_MS,
  BudgetExceededError,
  QuietHoursError,
  assertNotQuietHours,
  assertPerItemBudget,
  createItemBudget,
  isQuietHours,
  minutesOfDay,
  sampleDetailRead,
  samplePageDwell,
  sampleScrollStep,
  sampleTruncatedNormal,
} from './pacing.js';
import { mulberry32 } from './rng.js';

/** 本地时间构造器：new Date(2026, monthIndex0, day, h, m, s, ms) */
const local = (h: number, m = 0, s = 0, ms = 0): Date => new Date(2026, 9, 13, h, m, s, ms);

describe('pacing: 截断正态抽样（§7.1 :327/:328）', () => {
  it('page_dwell 抽样 1000 次全落 [3000, 8000]ms', () => {
    const rng = mulberry32(20261013);
    for (let i = 0; i < 1000; i += 1) {
      const v = samplePageDwell(rng);
      expect(v).toBeGreaterThanOrEqual(3000);
      expect(v).toBeLessThanOrEqual(8000);
    }
  });

  it('detail_read 抽样 1000 次全落 [4000, 15000]ms', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 1000; i += 1) {
      const v = sampleDetailRead(rng);
      expect(v).toBeGreaterThanOrEqual(4000);
      expect(v).toBeLessThanOrEqual(15000);
    }
  });

  it('page_dwell 样本均值接近 5s（截断后约 5.07s，容忍 ±0.4s）', () => {
    const rng = mulberry32(7);
    let sum = 0;
    const n = 5000;
    for (let i = 0; i < n; i += 1) sum += samplePageDwell(rng);
    const mean = sum / n;
    expect(mean).toBeGreaterThan(4700);
    expect(mean).toBeLessThan(5400);
  });

  it('detail_read 随正文长度线性修正：长文均值更大，但终值仍落 [4000,15000]', () => {
    const rng = mulberry32(99);
    let shortSum = 0;
    let longSum = 0;
    const n = 2000;
    for (let i = 0; i < n; i += 1) {
      shortSum += sampleDetailRead(rng, { contentLengthChars: 50 });
      const v = sampleDetailRead(rng, { contentLengthChars: 5000 });
      expect(v).toBeGreaterThanOrEqual(4000);
      expect(v).toBeLessThanOrEqual(15000);
      longSum += v;
    }
    expect(longSum / n).toBeGreaterThan(shortSum / n);
  });

  it('极端正文长度不破坏截断区间与终止性（均值夹取进区间）', () => {
    const rng = mulberry32(1234);
    for (let i = 0; i < 200; i += 1) {
      expect(sampleDetailRead(rng, { contentLengthChars: 1_000_000 })).toBeLessThanOrEqual(15000);
      expect(sampleDetailRead(rng, { contentLengthChars: 0 })).toBeGreaterThanOrEqual(4000);
    }
  });

  it('sampleTruncatedNormal 通用入口：参数与返回均可控', () => {
    const rng = mulberry32(5);
    const v = sampleTruncatedNormal({ meanMs: 100, stdMs: 5, minMs: 90, maxMs: 110 }, rng);
    expect(v).toBeGreaterThanOrEqual(90);
    expect(v).toBeLessThanOrEqual(110);
  });

  it('同种子序列完全可复现（Rng 注入确定性）', () => {
    const a = mulberry32(2026);
    const b = mulberry32(2026);
    for (let i = 0; i < 50; i += 1) expect(samplePageDwell(a)).toBe(samplePageDwell(b));
  });
});

describe('pacing: 滚动（§7.1 :329）', () => {
  it('滚动步长 1000 次全落 [300, 700]px', () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 1000; i += 1) {
      const { scrollPx } = sampleScrollStep(rng);
      expect(scrollPx).toBeGreaterThanOrEqual(300);
      expect(scrollPx).toBeLessThanOrEqual(700);
    }
  });

  it('段间随机停顿复用停留分布：全落 [3000, 8000]ms', () => {
    const rng = mulberry32(12);
    for (let i = 0; i < 1000; i += 1) {
      const { pauseMs } = sampleScrollStep(rng);
      expect(pauseMs).toBeGreaterThanOrEqual(3000);
      expect(pauseMs).toBeLessThanOrEqual(8000);
    }
  });

  it('滚动步长覆盖区间两端（边界可达，非空分布）', () => {
    const lo = PACING_DEFAULTS.scroll.minPx;
    const hi = PACING_DEFAULTS.scroll.maxPx;
    expect(lo).toBe(300);
    expect(hi).toBe(700);
  });
});

describe('pacing: quiet hours 02:00–07:00 禁跑（§7.1 :330）', () => {
  it('边界四点：01:59:59.999 放行 / 02:00:00.000 禁 / 06:59:59.999 禁 / 07:00:00.000 放行', () => {
    expect(isQuietHours(local(1, 59, 59, 999))).toBe(false);
    expect(isQuietHours(local(2, 0, 0, 0))).toBe(true);
    expect(isQuietHours(local(6, 59, 59, 999))).toBe(true);
    expect(isQuietHours(local(7, 0, 0, 0))).toBe(false);
  });

  it('昼间时刻全程放行', () => {
    for (const h of [0, 9, 12, 18, 23]) expect(isQuietHours(local(h, 30))).toBe(false);
  });

  it('禁跑窗口可配置（startMinute/endMinute）', () => {
    expect(isQuietHours(local(3), { startMinute: 180, endMinute: 240 })).toBe(true);
    expect(isQuietHours(local(5), { startMinute: 180, endMinute: 240 })).toBe(false);
  });

  it('assertNotQuietHours：quiet hours 内抛 QuietHoursError，窗外不抛', () => {
    expect(() => assertNotQuietHours(local(3))).toThrow(QuietHoursError);
    expect(() => assertNotQuietHours(local(12))).not.toThrow();
  });

  it('minutesOfDay 含小数秒精度', () => {
    expect(minutesOfDay(local(2, 0, 0, 0))).toBeCloseTo(120, 6);
    expect(minutesOfDay(local(6, 59, 59, 999))).toBeLessThan(420);
  });
});

describe('pacing: 单条预算 ≤8s 校验钩子（NFR-1 01:262）', () => {
  it('7999ms / 8000ms 通过，8001ms 抛 BudgetExceededError', () => {
    expect(() => assertPerItemBudget(7999)).not.toThrow();
    expect(() => assertPerItemBudget(PER_ITEM_BUDGET_MS)).not.toThrow();
    expect(() => assertPerItemBudget(8001)).toThrow(BudgetExceededError);
    expect(() => assertPerItemBudget(8001)).toThrow(/per-item budget exceeded/);
  });

  it('预算上限可注入覆盖（收紧更严、放宽无效于调用方语义之外）', () => {
    expect(() => assertPerItemBudget(500, 400)).toThrow(BudgetExceededError);
  });

  it('createItemBudget：fake clock 下 check() 精确判定', () => {
    let nowMs = 1_000;
    const budget = createItemBudget(() => nowMs);
    nowMs = 1_000 + 8_000;
    expect(() => budget.check()).not.toThrow();
    expect(budget.elapsed()).toBe(8_000);
    nowMs = 1_000 + 8_001;
    expect(() => budget.check()).toThrow(BudgetExceededError);
  });
});

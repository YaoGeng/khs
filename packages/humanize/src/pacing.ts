/**
 * 节奏引擎（PacingEngine）纯函数 —— T-M1-03 / 02-系统架构设计.md §7.1。
 *
 * 数值唯一真源 = 02 §7.5「DSL v1.1 规范参数表」（出处行号为 v1.1 版本行号），照抄不自行发明：
 *   pacing.page_dwell   截断正态 N(5s, 2s)，截断 [3s, 8s]              §7.1（:327）
 *   pacing.detail_read  N(8s, 3s)，截断 [4s, 15s]，随正文长度线性修正    §7.1（:328）
 *   pacing.scroll       分段滚动 300–700px/次，随机停顿                  §7.1（:329）
 *   pacing.quiet_hours  02:00–07:00 禁跑（可配置）                       §7.1（:330）
 *   单条预算 ≤8s：01-需求说明书.md NFR-1（:262）「采集单条笔记平均耗时 ≤ 8s」。
 *
 * 纯函数约束：随机性经 Rng 注入、时钟经 Date/now 注入；本包不依赖 electron/cdp/fs。
 */
import { clamp, gaussStandard } from './rng.js';

export type { Rng } from './rng.js';

export interface TruncatedNormalParams {
  meanMs: number;
  stdMs: number;
  minMs: number;
  maxMs: number;
}

/** §7.1 参数缺省值（与 §7.5 参数表逐行对应；B 端下发收紧时恒取更保守值）。 */
export const PACING_DEFAULTS = Object.freeze({
  pageDwell: Object.freeze({ meanMs: 5_000, stdMs: 2_000, minMs: 3_000, maxMs: 8_000 }),
  detailRead: Object.freeze({ meanMs: 8_000, stdMs: 3_000, minMs: 4_000, maxMs: 15_000 }),
  scroll: Object.freeze({ minPx: 300, maxPx: 700 }),
  quietHours: Object.freeze({ startMinute: 120, endMinute: 420 }), // 02:00–07:00 本地时间
  perItemBudgetMs: 8_000,
});

/** 截断正态抽样：拒绝式（落在区间外重抽），密度为真截断正态而非 clamp 变形。 */
export function sampleTruncatedNormal(p: TruncatedNormalParams, rng: () => number): number {
  const meanMs = clamp(p.meanMs, p.minMs, p.maxMs);
  for (;;) {
    const v = meanMs + gaussStandard(rng) * p.stdMs;
    if (v >= p.minMs && v <= p.maxMs) return v;
  }
}

/** 页面间停留：截断正态 N(5s, 2s) ∈ [3s, 8s]（§7.1 :327）。 */
export function samplePageDwell(rng: () => number): number {
  return sampleTruncatedNormal(PACING_DEFAULTS.pageDwell, rng);
}

export interface DetailReadOptions {
  /** 正文长度（字符数）；缺省按基准长度 200 处理 */
  contentLengthChars?: number;
}

/**
 * 详情页阅读时长：N(8s, 3s) 截断 [4s, 15s]，随正文长度线性修正（§7.1 :328）。
 * 修正口径：以 200 字为基准、每字 ±10ms 线性调整均值，均值先夹取进 [4s,15s] 再截断抽样——
 * 基线只规定「线性修正」方向，斜率为实现缺省且终值恒落截断区间，B 端可下发收紧。
 */
export function sampleDetailRead(rng: () => number, opts: DetailReadOptions = {}): number {
  const extra = ((opts.contentLengthChars ?? 200) - 200) * 10;
  return sampleTruncatedNormal({ ...PACING_DEFAULTS.detailRead, meanMs: PACING_DEFAULTS.detailRead.meanMs + extra }, rng);
}

export interface ScrollStep {
  /** 本次滚动像素量 ∈ [300, 700] */
  scrollPx: number;
  /** 段间随机停顿 ms */
  pauseMs: number;
}

/**
 * 分段滚动：300–700px/次（§7.1 :329）。基线的「随机停顿」无独立分布数值，
 * 复用 §7.1 页面间停留的截断正态（同源保守缺省），B 端可下发收紧。
 */
export function sampleScrollStep(rng: () => number): ScrollStep {
  const { minPx, maxPx } = PACING_DEFAULTS.scroll;
  const scrollPx = Math.round(minPx + rng() * (maxPx - minPx));
  return { scrollPx, pauseMs: samplePageDwell(rng) };
}

/** 本地时刻的日内分钟数（含小数秒）， quiet_hours 判定基准。 */
export function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / 60_000;
}

export interface QuietHoursWindow {
  /** 起始日内分钟（含） */
  startMinute: number;
  /** 结束日内分钟（不含） */
  endMinute: number;
}

/**
 * 禁跑判定：本地时间 02:00–07:00（半开区间 [120, 420) 分钟）→ true。
 * 边界语义：02:00:00.000 起禁跑；07:00:00.000 起解禁（§7.1 :330，可配置）。
 */
export function isQuietHours(now: Date, window: QuietHoursWindow = PACING_DEFAULTS.quietHours): boolean {
  const m = minutesOfDay(now);
  return m >= window.startMinute && m < window.endMinute;
}

export class QuietHoursError extends Error {
  readonly code = 'E-HUMANIZE-QUIET-HOURS';
  constructor(now: Date) {
    super(`quiet hours active (02:00-07:00 local): ${now.toISOString()}`);
    this.name = 'QuietHoursError';
  }
}

/** 禁跑钩子：quiet hours 内抛错，工作流启跑前调用。 */
export function assertNotQuietHours(now: Date, window: QuietHoursWindow = PACING_DEFAULTS.quietHours): void {
  if (isQuietHours(now, window)) throw new QuietHoursError(now);
}

export const PER_ITEM_BUDGET_MS = PACING_DEFAULTS.perItemBudgetMs;

export class BudgetExceededError extends Error {
  readonly code = 'E-HUMANIZE-BUDGET-EXCEEDED';
  constructor(elapsedMs: number, budgetMs: number) {
    super(`per-item budget exceeded: ${elapsedMs}ms > ${budgetMs}ms (NFR-1 01:262)`);
    this.name = 'BudgetExceededError';
  }
}

/** ≤8s 校验（含 8s 即通过，>8s 抛错）。 */
export function assertPerItemBudget(elapsedMs: number, budgetMs: number = PER_ITEM_BUDGET_MS): void {
  if (elapsedMs > budgetMs) throw new BudgetExceededError(elapsedMs, budgetMs);
}

/**
 * 单条预算测量钩子（时钟注入）：`check()` 超预算抛错，`elapsed()` 返回已耗毫秒。
 * 采集单条笔记平均耗时 ≤ 8s（NFR-1，01:262）；本钩子做单条级硬校验，平均值监控归宿主统计。
 */
export function createItemBudget(
  now: () => number = Date.now,
  budgetMs: number = PER_ITEM_BUDGET_MS,
): { check(): void; elapsed(): number } {
  const startedAt = now();
  return {
    elapsed: () => now() - startedAt,
    check: () => assertPerItemBudget(now() - startedAt, budgetMs),
  };
}

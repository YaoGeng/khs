/**
 * 拟人操作层（Humanizer）纯函数 —— T-M1-03 / 02-系统架构设计.md §7.2。
 *
 * §7.5 参数表引用值（照抄）：
 *   humanizer.mouse     贝塞尔曲线（随机控制点）+ 过冲/修正抖动 + 变速移动；点击位置在元素 bbox 内高斯偏移 §7.2（:336）
 *   humanizer.keyboard  逐字符输入，间隔 60–180ms，偶发退格修正                                            §7.2（:337）
 *   humanizer.actions   优先模拟真实交互（click/scroll/type），禁用 JS 直取 DOM 写入                        §7.2（:338）
 *
 * 本包只产出「计划/点序列」数据；CDP 注入与执行由调用方完成，本包不依赖 electron/cdp。
 */
import { clamp, gaussStandard } from './rng.js';

export type { Rng } from './rng.js';

export interface Point {
  x: number;
  y: number;
}

export interface TimedPoint extends Point {
  /** 相对路径起点的毫秒偏移（单调不减） */
  t: number;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BezierMousePathOptions {
  from: Point;
  to: Point;
  rng: () => number;
  /** 采样点数下限（默认 20） */
  steps?: number;
}

/**
 * 贝塞尔鼠标轨迹点序列（§7.2 :336）：三次贝塞尔 + 随机控制点（垂直于直线方向的随机摆幅）
 * + 过冲/修正抖动（越靶后回拉）+ 变速移动（缓入缓出、步间时长随机抖动）。
 * 首点 = from（t=0），末点 = to（精确落点），t 单调递增。
 */
export function bezierMousePath(opts: BezierMousePathOptions): TimedPoint[] {
  const { from, to, rng } = opts;
  const steps = Math.max(8, opts.steps ?? 20);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  const px = -uy; // 垂直方向
  const py = ux;

  // 随机控制点：1/3 与 2/3 处沿垂直方向随机摆幅（≤25% 距离）
  const swing = () => (rng() * 2 - 1) * dist * 0.25;
  const c1: Point = { x: from.x + dx / 3 + px * swing(), y: from.y + dy / 3 + py * swing() };
  const c2: Point = { x: from.x + (2 * dx) / 3 + px * swing(), y: from.y + (2 * dy) / 3 + py * swing() };

  // 过冲靶点：沿行进方向越过 to 2%–6% 距离（短距不过冲），末段回拉修正
  const overshoot = dist > 60 ? dist * (0.02 + rng() * 0.04) : 0;
  const target: Point = { x: to.x + ux * overshoot, y: to.y + uy * overshoot };

  const totalMs = Math.max(220, dist * 0.9) * (0.9 + rng() * 0.2);

  const points: TimedPoint[] = [];
  const cubic = (a: number, b: number, c: number, d: number, u: number): number => {
    const v = 1 - u;
    return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d;
  };
  const easeInOut = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

  for (let i = 0; i <= steps; i += 1) {
    const u = i / steps;
    const eased = easeInOut(u);
    const x = cubic(from.x, c1.x, c2.x, target.x, eased);
    const y = cubic(from.y, c1.y, c2.y, target.y, eased);
    const jitter = 1 + (rng() * 2 - 1) * 0.15;
    const t = totalMs * eased * jitter;
    const prev = points[points.length - 1];
    points.push({ x, y, t: prev ? Math.max(prev.t, t) : 0 });
  }

  // 修正抖动：过冲点后回拉，精确落在 to（两步，模拟人手修正）
  const last = points[points.length - 1];
  const pullbackMs = last.t + 60 + rng() * 80;
  points.push({ x: to.x + (rng() * 2 - 1) * 1.5, y: to.y + (rng() * 2 - 1) * 1.5, t: pullbackMs });
  points.push({ x: to.x, y: to.y, t: pullbackMs + 40 + rng() * 60 });
  return points;
}

export interface KeystrokeStep {
  kind: 'char' | 'backspace';
  /** kind='char' 时为该字符；backspace 删除前一个已输入字符 */
  char?: string;
  /** 本步按下前的等待 ms ∈ [60, 180]（§7.2 :337） */
  delayMs: number;
}

export interface KeystrokePlanOptions {
  /** 逐字符间隔下界（缺省 60ms） */
  minDelayMs?: number;
  /** 逐字符间隔上界（缺省 180ms） */
  maxDelayMs?: number;
  /** 偶发退格修正概率（缺省 0.02；0 退禁、1 必退） */
  correctionChance?: number;
}

/**
 * 逐字符键入计划（§7.2 :337）：间隔 60–180ms，偶发退格修正。
 * 修正语义 = 输入该字符后按概率退格删除它并重输同字符（「打错→回删→重打」人手抖动），净文本恒等于输入。
 */
export function keystrokePlan(text: string, rng: () => number, opts: KeystrokePlanOptions = {}): KeystrokeStep[] {
  const minDelayMs = opts.minDelayMs ?? 60;
  const maxDelayMs = opts.maxDelayMs ?? 180;
  const correctionChance = opts.correctionChance ?? 0.02;
  const delay = () => Math.round(minDelayMs + rng() * (maxDelayMs - minDelayMs));
  const steps: KeystrokeStep[] = [];
  for (const char of Array.from(text)) {
    steps.push({ kind: 'char', char, delayMs: delay() });
    if (rng() < correctionChance) {
      steps.push({ kind: 'backspace', delayMs: delay() });
      steps.push({ kind: 'char', char, delayMs: delay() });
    }
  }
  return steps;
}

/** 键入计划回放（纯栈模拟）：返回净文本；用于宿主校验计划与测试断言。 */
export function replayKeystrokes(steps: readonly KeystrokeStep[]): string {
  const stack: string[] = [];
  for (const s of steps) {
    if (s.kind === 'backspace') stack.pop();
    else stack.push(s.char ?? '');
  }
  return stack.join('');
}

/**
 * 点击位置：元素 bbox 内高斯偏移（§7.2 :336）。
 * σ = 边长/6（约 99% 落在中心 ±3σ），终值夹取进 bbox 内缩 1px 的安全区。
 */
export function gaussianClickOffset(bbox: BBox, rng: () => number): Point {
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const sigmaX = Math.max(1, bbox.width / 6);
  const sigmaY = Math.max(1, bbox.height / 6);
  return {
    x: clamp(cx + gaussStandard(rng) * sigmaX, bbox.x + 1, bbox.x + bbox.width - 1),
    y: clamp(cy + gaussStandard(rng) * sigmaY, bbox.y + 1, bbox.y + bbox.height - 1),
  };
}

/** 允许的拟人动作全集：优先模拟真实交互（§7.2 :338）。 */
export const HUMANIZER_ACTIONS = ['click', 'scroll', 'type'] as const;
export type HumanizerAction = (typeof HUMANIZER_ACTIONS)[number];

export class ForbiddenHumanActionError extends Error {
  readonly code = 'E-HUMANIZE-FORBIDDEN-ACTION';
  constructor(action: string) {
    super(`forbidden humanizer action: ${action}; allowed: ${HUMANIZER_ACTIONS.join('/')}`);
    this.name = 'ForbiddenHumanActionError';
  }
}

export function assertAllowedHumanAction(action: string): asserts action is HumanizerAction {
  if (!(HUMANIZER_ACTIONS as readonly string[]).includes(action)) throw new ForbiddenHumanActionError(action);
}

/**
 * 「禁 JS 直取 DOM 写入」API 约束导出（§7.2 :338）：
 * 允许的动作只有 click/scroll/type（真实交互模拟）；任何「JS 直改 DOM」路径不在本包 API 内，
 * CDP 注入与执行一律由调用方完成（本包零 electron/cdp 依赖）。宿主组装动作时以此常量为白名单。
 */
export const HUMANIZER_CONSTRAINTS = Object.freeze({
  allowedActions: Object.freeze([...HUMANIZER_ACTIONS]),
  forbidDirectDomWrite: true,
  /** CDP 注入由调用方执行（本包不依赖 electron/cdp） */
  cdpInjectionByCaller: true,
  rationale: '02 §7.2（:338）: 优先模拟真实交互（click/scroll/type），禁用 JS 直取 DOM 写入。',
});

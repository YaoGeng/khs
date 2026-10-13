/**
 * 人工输入让位机制（FR-4.5 / 02 §9.1）—— T-M1-03 塔基部分。
 *
 * 本卡只产出三件纯件（宿主接线归 T-M1-04，见 docs/adr/notes-browser-m0.md §8 红线解释）：
 * 1) PASSIVE_INPUT_LISTENER_SCRIPT：经 CDP `Page.addScriptToEvaluateOnNewDocument` 注入的
 *    passive 输入监听脚本源码（keydown/pointerdown，1s 节流写 window.__khs_yield__）；
 * 2) AutomationWindow：每个 CDP 动作的 start/end 时间戳窗口，窗口内输入判「自动化回声」丢弃
 *    （防自触发回环）；
 * 3) YieldClassifier：让位分类器——窗口外用户输入 → yield；静默期满（默认 3s）→ 恢复。
 *
 * 红线口径（01 §7.5 :386）：passive 监听只读取用户自有浏览器的输入事件、不改变页面行为，
 * 属「驱动用户自有浏览器」的既定形态，不是「向平台页面注入功能」。
 */

/** 页面侧让位时间戳全局量（宿主经 CDP Runtime.evaluate 轮询读取）。 */
export const YIELD_FLAG_GLOBAL = '__khs_yield__';

/** 输入写入节流：至多 1s 一次（降低 CDP 轮询面与页面侧开销）。 */
export const INPUT_THROTTLE_MS = 1_000;

/** 静默恢复阈值缺省：3s（任务书默认值；窗口外输入停手满 3s 判恢复）。 */
export const SILENCE_RESUME_THRESHOLD_MS = 3_000;

export type PassiveInputType = 'keydown' | 'pointerdown';

/**
 * passive 输入监听脚本源码（注入由宿主执行；本常量为唯一真源）。
 * - `{ passive: true }` 机制上排除 preventDefault/stopPropagation——只读不干预；
 * - 幂等安装（重复注入不重复挂监听）；写 `window.__khs_yield__` = 最近一次用户输入的 Date.now()。
 */
export const PASSIVE_INPUT_LISTENER_SCRIPT = `(function () {
  'use strict';
  var w = window;
  if (w.__khs_yield_installed__) { return; }
  w.__khs_yield_installed__ = true;
  var last = 0;
  function mark() {
    var now = Date.now();
    if (now - last < ${INPUT_THROTTLE_MS}) { return; }
    last = now;
    w[${JSON.stringify(YIELD_FLAG_GLOBAL)}] = now;
  }
  document.addEventListener('keydown', mark, { passive: true, capture: true });
  document.addEventListener('pointerdown', mark, { passive: true, capture: true });
})();`;

export interface InputEvent {
  type: PassiveInputType;
  /** 宿主时钟 epoch ms（页面脚本写出的 __khs_yield__ 值或宿主合成事件时间） */
  at: number;
}

export type InputClassification = 'user-input' | 'automation-echo';

/**
 * automation-window：CDP 动作 start/end 时间戳。
 * 并发=1（ADR-6 单浏览器串行），窗口单开；保留最近窗口历史以分类「迟到事件」。
 */
export class AutomationWindow {
  private openStart: number | null = null;
  private readonly history: Array<{ start: number; end: number }> = [];
  private readonly historyLimit = 32;

  /** 动作开始（开窗；重复 begin 以新起点覆盖——宿主动作队列保证串行）。 */
  begin(now: number): void {
    this.openStart = now;
  }

  /** 动作结束（关窗并入历史；未开窗时为 no-op）。 */
  end(now: number): void {
    if (this.openStart === null) return;
    const start = this.openStart;
    this.openStart = null;
    this.history.push({ start, end: now });
    if (this.history.length > this.historyLimit) this.history.shift();
  }

  isOpen(now: number = Date.now()): boolean {
    return this.openStart !== null && now >= this.openStart;
  }

  /** 事件时间落在任何（开着的或历史）动作窗内 → 自动化回声。 */
  activeAt(at: number): boolean {
    if (this.openStart !== null && at >= this.openStart) return true;
    return this.history.some((w) => at >= w.start && at <= w.end);
  }

  classify(ev: InputEvent): InputClassification {
    return this.activeAt(ev.at) ? 'automation-echo' : 'user-input';
  }
}

export type YieldObservation = 'yield' | 'ignore-self-input';

/**
 * 让位分类器：合成/真实输入事件流 → yield/恢复决策。
 * - 窗口内输入（automation-echo）→ 'ignore-self-input'：既不让位也不推进静默时钟（防自回环）；
 * - 窗口外输入 → 'yield'（幂等 engage；重复输入刷新 lastInputAt，宿主侧 Flag 去重）；
 * - 恢复 = 静默期满：now - lastInputAt ≥ silenceThresholdMs（默认 3s）。
 */
export class YieldClassifier {
  private readonly window: AutomationWindow | null;
  private readonly silenceThresholdMs: number;
  private lastUserInputAt: number | null = null;
  private yielded = false;

  constructor(opts: { silenceThresholdMs?: number; window?: AutomationWindow } = {}) {
    this.silenceThresholdMs = opts.silenceThresholdMs ?? SILENCE_RESUME_THRESHOLD_MS;
    this.window = opts.window ?? null;
  }

  observe(ev: InputEvent): YieldObservation {
    if (this.window && this.window.classify(ev) === 'automation-echo') return 'ignore-self-input';
    this.lastUserInputAt = ev.at;
    this.yielded = true;
    return 'yield';
  }

  /** 静默期满恢复判定：恢复则转回 active 并返回 true。 */
  maybeResume(now: number): boolean {
    if (!this.yielded || this.lastUserInputAt === null) return false;
    if (now - this.lastUserInputAt < this.silenceThresholdMs) return false;
    this.yielded = false;
    return true;
  }

  /** 当前状态；now 缺省时 silenceForMs 为 null（无时钟基准可算）。 */
  status(now?: number): { yielded: boolean; lastUserInputAt: number | null; silenceForMs: number | null } {
    return {
      yielded: this.yielded,
      lastUserInputAt: this.lastUserInputAt,
      silenceForMs:
        now === undefined || this.lastUserInputAt === null
          ? null
          : Math.max(0, now - this.lastUserInputAt),
    };
  }
}

import { describe, it, expect } from 'vitest';
import {
  INPUT_THROTTLE_MS,
  PASSIVE_INPUT_LISTENER_SCRIPT,
  SILENCE_RESUME_THRESHOLD_MS,
  AutomationWindow,
  YIELD_FLAG_GLOBAL,
  YieldClassifier,
  type InputEvent,
} from './yield.js';

const input = (at: number, type: InputEvent['type'] = 'pointerdown'): InputEvent => ({ type, at });

describe('yield: passive 监听脚本源码常量（宿主 todo-7 注入）', () => {
  it('包含 keydown/pointerdown/passive/节流/全局量五要素', () => {
    expect(PASSIVE_INPUT_LISTENER_SCRIPT).toContain("'keydown'");
    expect(PASSIVE_INPUT_LISTENER_SCRIPT).toContain("'pointerdown'");
    expect(PASSIVE_INPUT_LISTENER_SCRIPT).toContain('passive: true');
    expect(PASSIVE_INPUT_LISTENER_SCRIPT).toContain(JSON.stringify(YIELD_FLAG_GLOBAL));
    expect(PASSIVE_INPUT_LISTENER_SCRIPT).toContain(`${INPUT_THROTTLE_MS}`);
  });

  it('行为级：fake DOM 下 keydown/pointerdown 命中即写 __khs_yield__，1s 节流，幂等安装', () => {
    const realNow = Date.now;
    let fakeNow = 10_000;
    Date.now = () => fakeNow;
    try {
      const handlers: Record<string, () => void> = {};
      const doc = {
        addEventListener: (type: string, fn: () => void) => {
          handlers[type] = fn;
        },
      };
      const win: Record<string, number | boolean> = {};
      const install = new Function('window', 'document', PASSIVE_INPUT_LISTENER_SCRIPT);

      install(win, doc);
      expect(win.__khs_yield_installed__).toBe(true);
      expect(win[YIELD_FLAG_GLOBAL]).toBeUndefined();

      handlers['keydown']();
      expect(win[YIELD_FLAG_GLOBAL]).toBe(10_000);

      fakeNow = 10_000 + 500; // <1s：节流不写
      handlers['pointerdown']();
      expect(win[YIELD_FLAG_GLOBAL]).toBe(10_000);

      fakeNow = 10_000 + INPUT_THROTTLE_MS; // 满 1s：再次写入
      handlers['pointerdown']();
      expect(win[YIELD_FLAG_GLOBAL]).toBe(11_000);

      // 幂等安装：重复注入不重挂监听（handler 表不被覆盖）
      const handlersSnapshot = { ...handlers };
      install(win, doc);
      expect(handlers).toEqual(handlersSnapshot);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('yield: automation-window（CDP 动作 start/end，窗口内输入丢弃防自回环）', () => {
  it('开窗内事件 → automation-echo；关窗后 → user-input', () => {
    const win = new AutomationWindow();
    win.begin(1000);
    win.end(2000);
    expect(win.classify(input(1500))).toBe('automation-echo');
    expect(win.classify(input(2500))).toBe('user-input');
  });

  it('未开窗时一切输入都是 user-input', () => {
    const win = new AutomationWindow();
    expect(win.classify(input(5000))).toBe('user-input');
    expect(win.isOpen(5000)).toBe(false);
  });

  it('开窗中（未 end）的迟到事件同样判回声；end 后窗口入历史仍可分类', () => {
    const win = new AutomationWindow();
    win.begin(100);
    expect(win.isOpen(150)).toBe(true);
    expect(win.classify(input(150))).toBe('automation-echo');
    win.end(300);
    expect(win.isOpen(150)).toBe(false);
    expect(win.classify(input(200))).toBe('automation-echo');
    expect(win.classify(input(301))).toBe('user-input');
  });

  it('连续多动作：历史窗口各自判定（串行动作序列）', () => {
    const win = new AutomationWindow();
    win.begin(0);
    win.end(100);
    win.begin(200);
    win.end(300);
    expect(win.classify(input(50))).toBe('automation-echo');
    expect(win.classify(input(150))).toBe('user-input');
    expect(win.classify(input(250))).toBe('automation-echo');
  });

  it('未 begin 先 end 为 no-op（宿主异常时序安全）', () => {
    const win = new AutomationWindow();
    expect(() => win.end(100)).not.toThrow();
    expect(win.classify(input(100))).toBe('user-input');
  });
});

describe('yield: 让位分类器（窗口外输入→yield；静默期满 3s→恢复）', () => {
  it('窗口外输入 → yield；再输入刷新静默时钟', () => {
    const c = new YieldClassifier();
    expect(c.observe(input(1000))).toBe('yield');
    expect(c.status(1000)).toMatchObject({ yielded: true, lastUserInputAt: 1000 });
    expect(c.observe(input(1500))).toBe('yield');
    expect(c.status(1500).lastUserInputAt).toBe(1500);
  });

  it('automation-window 内输入 → ignore-self-input，且不推进静默时钟（防自回环）', () => {
    const win = new AutomationWindow();
    const c = new YieldClassifier({ window: win });
    win.begin(1000);
    win.end(2000);
    expect(c.observe(input(1500))).toBe('ignore-self-input');
    expect(c.status(1500)).toMatchObject({ yielded: false, lastUserInputAt: null });
    // 关联窗口后，窗外输入照常触发
    expect(c.observe(input(2500))).toBe('yield');
  });

  it('静默恢复边界：2999ms 未恢复，3000ms 恢复（默认阈值 3s）', () => {
    const c = new YieldClassifier();
    expect(SILENCE_RESUME_THRESHOLD_MS).toBe(3000);
    c.observe(input(1000));
    expect(c.maybeResume(1000 + 2999)).toBe(false);
    expect(c.status(3999).yielded).toBe(true);
    expect(c.maybeResume(1000 + 3000)).toBe(true);
    expect(c.status(4000).yielded).toBe(false);
  });

  it('静默期内再次输入重新起算恢复时钟', () => {
    const c = new YieldClassifier();
    c.observe(input(0));
    c.maybeResume(2000);
    c.observe(input(2500)); // 刷新 lastInputAt
    expect(c.maybeResume(2500 + 2999)).toBe(false);
    expect(c.maybeResume(2500 + 3000)).toBe(true);
  });

  it('未 yield 时 maybeResume 恒 false；阈值可注入收紧', () => {
    const c = new YieldClassifier({ silenceThresholdMs: 1000 });
    expect(c.maybeResume(999_999)).toBe(false);
    c.observe(input(0));
    expect(c.maybeResume(999)).toBe(false);
    expect(c.maybeResume(1000)).toBe(true);
  });
});

describe('QA: 合成事件流全链（automation-window 抑制 + 3s 恢复）', () => {
  it('自动化动作窗内回声全丢弃 → 用户输入让位 → 静默 3s 恢复 → 检查后续', () => {
    const win = new AutomationWindow();
    const c = new YieldClassifier({ window: win });
    const decisions: string[] = [];

    // 宿主执行 CDP 动作（0–800ms），期间页面脚本上报的「输入」实为自动化回声
    win.begin(0);
    for (const at of [100, 300, 500, 700]) decisions.push(c.observe(input(at, 'keydown')));
    win.end(800);
    expect(decisions.every((d) => d === 'ignore-self-input')).toBe(true);
    expect(c.status(800).yielded).toBe(false);

    // 用户在动作窗外真实输入（850ms）→ 让位
    expect(c.observe(input(850))).toBe('yield');
    expect(c.status(850).yielded).toBe(true);

    // 用户继续输入（2100ms）刷新静默时钟
    expect(c.observe(input(2100, 'pointerdown'))).toBe('yield');
    // 静默 2999ms 未恢复
    expect(c.maybeResume(2100 + 2999)).toBe(false);
    // 静默期满（3s）恢复
    expect(c.maybeResume(2100 + 3000)).toBe(true);
    expect(c.status(5100).yielded).toBe(false);
  });
});

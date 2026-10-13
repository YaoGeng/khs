import { describe, it, expect } from 'vitest';
import {
  HUMANIZER_ACTIONS,
  HUMANIZER_CONSTRAINTS,
  ForbiddenHumanActionError,
  assertAllowedHumanAction,
  bezierMousePath,
  gaussianClickOffset,
  keystrokePlan,
  replayKeystrokes,
  type BBox,
  type KeystrokeStep,
  type TimedPoint,
} from './humanizer.js';
import { mulberry32 } from './rng.js';

describe('humanizer: 贝塞尔鼠标轨迹（§7.2 :336）', () => {
  const from = { x: 100, y: 200 };
  const to = { x: 800, y: 500 };

  it('首点 = from（t=0），末点 = to（精确落点）', () => {
    const pts = bezierMousePath({ from, to, rng: mulberry32(1) });
    expect(pts[0]).toEqual({ x: 100, y: 200, t: 0 });
    const last = pts[pts.length - 1];
    expect(last.x).toBe(to.x);
    expect(last.y).toBe(to.y);
  });

  it('t 单调不减且全部有限', () => {
    const pts = bezierMousePath({ from, to, rng: mulberry32(2) });
    for (let i = 1; i < pts.length; i += 1) expect(pts[i].t).toBeGreaterThanOrEqual(pts[i - 1].t);
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.t)).toBe(true);
    }
  });

  it('随机控制点：不同种子产生不同轨迹（非直线模板）', () => {
    const a = bezierMousePath({ from, to, rng: mulberry32(3) });
    const b = bezierMousePath({ from, to, rng: mulberry32(4) });
    const midA = a[Math.floor(a.length / 2)];
    const midB = b[Math.floor(b.length / 2)];
    expect(midA.x !== midB.x || midA.y !== midB.y).toBe(true);
  });

  it('过冲与修正抖动：末段存在偏离终点的点后回拉（长距离）', () => {
    const pts: TimedPoint[] = bezierMousePath({ from, to, rng: mulberry32(6) });
    const tail = pts.slice(-3);
    const beforeLast = tail[tail.length - 2];
    const pulledBack = Math.hypot(beforeLast.x - to.x, beforeLast.y - to.y);
    expect(pulledBack).toBeGreaterThan(0);
  });

  it('变速移动：点间距非均匀（存在疏密差异）', () => {
    const pts = bezierMousePath({ from, to, rng: mulberry32(8), steps: 40 });
    const gaps: number[] = [];
    for (let i = 1; i < pts.length; i += 1) gaps.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const maxGap = Math.max(...gaps);
    const minGap = Math.min(...gaps.filter((g) => g >= 0));
    expect(maxGap).toBeGreaterThan(minGap * 2);
  });

  it('短距离（<60px）不过冲，末点仍精确', () => {
    const pts = bezierMousePath({ from: { x: 10, y: 10 }, to: { x: 50, y: 20 }, rng: mulberry32(9) });
    const last = pts[pts.length - 1];
    expect(last.x).toBe(50);
    expect(last.y).toBe(20);
  });

  it('默认步数 ≥ 20 且可注入覆盖', () => {
    expect(bezierMousePath({ from, to, rng: mulberry32(10) }).length).toBeGreaterThanOrEqual(20);
    expect(bezierMousePath({ from, to, rng: mulberry32(10), steps: 30 }).length).toBeGreaterThanOrEqual(30);
  });
});

describe('humanizer: 逐字符键入计划（§7.2 :337）', () => {
  it('间隔抽样（长文本 ≥1000 步）全落 [60, 180]ms', () => {
    const longText = '拟人键入计划抽样'.repeat(130);
    const plan = keystrokePlan(longText, mulberry32(21));
    expect(plan.length).toBeGreaterThanOrEqual(1000);
    for (const step of plan) {
      expect(step.delayMs).toBeGreaterThanOrEqual(60);
      expect(step.delayMs).toBeLessThanOrEqual(180);
    }
  });

  it('净文本回放 = 原输入（退格修正后内容无损）', () => {
    const text = '搜索关键词：humanize v1';
    const plan = keystrokePlan(text, mulberry32(22));
    expect(replayKeystrokes(plan)).toBe(text);
  });

  it('缺省偶发退格：种子流中确实出现 backspace 步', () => {
    let sawBackspace = false;
    for (let seed = 0; seed < 50 && !sawBackspace; seed += 1) {
      const plan = keystrokePlan('这是一段足够长的文本来触发偶发退格修正概率', mulberry32(seed));
      sawBackspace = plan.some((s) => s.kind === 'backspace');
    }
    expect(sawBackspace).toBe(true);
  });

  it('correctionChance=0 时零退格；=1 时每字符「输入+退格+重输」，净文本不变', () => {
    const none = keystrokePlan('abcdef', mulberry32(23), { correctionChance: 0 });
    expect(none.every((s) => s.kind === 'char')).toBe(true);

    const all = keystrokePlan('abcdef', mulberry32(23), { correctionChance: 1 });
    const backspaces = all.filter((s): s is KeystrokeStep & { kind: 'backspace' } => s.kind === 'backspace');
    expect(backspaces.length).toBe('abcdef'.length);
    expect(replayKeystrokes(all)).toBe('abcdef');
  });

  it('空字符串产出空计划', () => {
    expect(keystrokePlan('', mulberry32(24))).toEqual([]);
  });
});

describe('humanizer: bbox 内高斯偏移（§7.2 :336）', () => {
  const bbox: BBox = { x: 400, y: 300, width: 160, height: 48 };

  it('抽样 1000 次全落 bbox 内', () => {
    const rng = mulberry32(31);
    for (let i = 0; i < 1000; i += 1) {
      const p = gaussianClickOffset(bbox, rng);
      expect(p.x).toBeGreaterThanOrEqual(bbox.x);
      expect(p.x).toBeLessThanOrEqual(bbox.x + bbox.width);
      expect(p.y).toBeGreaterThanOrEqual(bbox.y);
      expect(p.y).toBeLessThanOrEqual(bbox.y + bbox.height);
    }
  });

  it('分布集中于 bbox 中心（均值落在中央四分位）', () => {
    const rng = mulberry32(32);
    let sx = 0;
    let sy = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      const p = gaussianClickOffset(bbox, rng);
      sx += p.x;
      sy += p.y;
    }
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    expect(Math.abs(sx / n - cx)).toBeLessThan(bbox.width / 8);
    expect(Math.abs(sy / n - cy)).toBeLessThan(bbox.height / 8);
  });

  it('极小 bbox（1px 边）不越界不 NaN', () => {
    const tiny: BBox = { x: 0, y: 0, width: 1, height: 1 };
    const p = gaussianClickOffset(tiny, mulberry32(33));
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    expect(p.x).toBeGreaterThanOrEqual(tiny.x);
    expect(p.x).toBeLessThanOrEqual(tiny.x + tiny.width);
  });
});

describe('humanizer: 「禁 JS 直取 DOM 写入」约束导出（§7.2 :338）', () => {
  it('允许动作白名单 = click/scroll/type', () => {
    expect([...HUMANIZER_ACTIONS]).toEqual(['click', 'scroll', 'type']);
    expect(HUMANIZER_CONSTRAINTS.allowedActions).toEqual(['click', 'scroll', 'type']);
  });

  it('forbidDirectDomWrite=true 且 CDP 注入归调用方', () => {
    expect(HUMANIZER_CONSTRAINTS.forbidDirectDomWrite).toBe(true);
    expect(HUMANIZER_CONSTRAINTS.cdpInjectionByCaller).toBe(true);
  });

  it('assertAllowedHumanAction：白名单外抛 ForbiddenHumanActionError', () => {
    expect(() => assertAllowedHumanAction('click')).not.toThrow();
    expect(() => assertAllowedHumanAction('evaluate')).toThrow(ForbiddenHumanActionError);
    expect(() => assertAllowedHumanAction('innerHtml')).toThrow(ForbiddenHumanActionError);
  });
});

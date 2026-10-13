/**
 * CDP 动作封装 + mock CDP（fixture）单测（todo 7⑤）：
 * - 每个动作经 gate（whenAutomationAllowed 唯一入口）+ AutomationWindow 开关窗（回声锚点）；
 * - Runtime.evaluate JSON 提取 / 让位标志轮询；
 * - YieldClassifier 联动：窗口外输入 → yield；窗口内（自动化回声）→ 忽略；静默 3s → 恢复。
 */
import { describe, expect, it } from 'vitest';
import { AutomationWindow, YieldClassifier } from '@xinglian/stealth-middleware';
import { CdpAutomation, createFixtureAutomation, parseFixtureScenario, startYieldMonitor } from './automation';
import { CdpConnection, type CdpMessage } from './cdp';

/** 假 CDP 传输：记录请求并同步回包（onData 回放句柄在构造前声明，规避 TDZ） */
function fakeConnection(handler: (message: CdpMessage) => unknown): { connection: CdpConnection; sent: CdpMessage[] } {
  const sent: CdpMessage[] = [];
  let chunkSink: ((chunk: Buffer) => void) | null = null;
  const connection = new CdpConnection({
    write: (frame) => {
      for (const part of frame.toString('utf8').split('\0')) {
        if (!part) continue;
        const message = JSON.parse(part) as CdpMessage;
        sent.push(message);
        const response = JSON.stringify({ id: message.id, result: handler(message) }) + '\0';
        chunkSink?.(Buffer.from(response, 'utf8'));
      }
    },
    onData: (cb) => {
      chunkSink = cb;
    },
    onClose: () => {},
    onError: () => {},
    end: () => {},
  });
  return { connection, sent };
}

describe('CdpAutomation：gate + AutomationWindow 包裹', () => {
  it('每个动作前置 gate 并包 AutomationWindow 开/关窗（回声抑制锚点）', async () => {
    const windows = new AutomationWindow();
    let gateCalls = 0;
    let tick = 1_000;
    const { connection, sent } = fakeConnection((message) => {
      if (message.method === 'Runtime.evaluate') {
        return { result: { value: { '.login-btn': 0 } } };
      }
      return {};
    });
    const automation = new CdpAutomation({
      connection,
      sessionId: 'sess-1',
      gate: async () => {
        gateCalls += 1;
      },
      windows,
      delay: async () => {},
      now: () => (tick += 10),
    });
    await automation.probeFeatures(['.login-btn']);
    await automation.pollYieldFlag();
    expect(gateCalls).toBe(2);
    // evaluate 走 flat 会话（sessionId 透传）
    for (const message of sent) {
      expect(message.sessionId).toBe('sess-1');
    }
    // 动作已关窗（历史窗口记录存在，当前无开窗）
    expect(windows.isOpen(tick)).toBe(false);
  });

  it('pollYieldFlag：__khs_yield__ 数值透传', async () => {
    const { connection } = fakeConnection((message) =>
      message.method === 'Runtime.evaluate' ? { result: { value: 1728888888888 } } : {},
    );
    const automation = new CdpAutomation({
      connection,
      sessionId: 's',
      gate: async () => {},
      windows: new AutomationWindow(),
      delay: async () => {},
    });
    await expect(automation.pollYieldFlag()).resolves.toBe(1728888888888);
  });
});

describe('mock CDP（fixture）+ 让位监视器', () => {
  const SCENARIO_JSON = JSON.stringify({
    notes: [{ noteId: 'n1', title: 'T', content: 'C', likes: 1, collects: 1, comments: 1, tags: [], author: 'u', publishedAt: null }],
    captcha: true,
    loginEntryVisible: true,
  });

  it('fixture 场景：probeFeatures 验证码/登录入口命中；simulateUserInput → pollYieldFlag', async () => {
    const fixture = createFixtureAutomation(parseFixtureScenario(SCENARIO_JSON), { delay: async () => {} });
    expect((await fixture.probeFeatures(['.captcha-container']))['.captcha-container']).toBe(1);
    expect((await fixture.probeFeatures(['.login-btn']))['.login-btn']).toBe(1);
    fixture.simulateUserInput(1234);
    await expect(fixture.pollYieldFlag()).resolves.toBe(1234);
    const detail = await fixture.readDetail('n1');
    expect(detail).toMatchObject({ noteId: 'n1', title: 'T', author: { name: 'u' } });
    await expect(fixture.readDetail('missing')).rejects.toThrow(/not found/);
  });

  it('YieldMonitor：窗口内输入忽略（回声）；窗口外输入 yield；静默 3s 恢复', async () => {
    const windows = new AutomationWindow();
    const classifier = new YieldClassifier({ window: windows, silenceThresholdMs: 3_000 });
    let fakeNow = 10_000;
    const inputs: number[] = [];
    const resumes: number[] = [];
    let flagValue: number | null = null;
    const monitor = startYieldMonitor({
      poll: async () => flagValue,
      classifier,
      // 真实 timer：零延迟闭包会造成微任务自旋死锁（事件循环饿死）
      delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => fakeNow,
      intervalMs: 5,
      onUserInput: (at) => inputs.push(at),
      onSilenceResume: (at) => resumes.push(at),
    });
    // 自动化窗口内输入 = 回声：忽略（防自触发回环）
    windows.begin(9_000);
    windows.end(9_500);
    flagValue = 9_200;
    await new Promise((r) => setTimeout(r, 30));
    expect(inputs).toEqual([]);
    // 窗口外输入：yield
    flagValue = 10_500;
    await new Promise((r) => setTimeout(r, 30));
    expect(inputs).toEqual([10_500]);
    // 静默 ≥3s：恢复
    fakeNow = 13_600;
    await new Promise((r) => setTimeout(r, 30));
    expect(resumes.length).toBeGreaterThanOrEqual(1);
    monitor.stop();
  });
});

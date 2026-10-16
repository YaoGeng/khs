/**
 * CDP 动作封装 + mock CDP（fixture）单测（todo 7⑤）：
 * - 每个动作经 gate（whenAutomationAllowed 唯一入口）+ AutomationWindow 开关窗（回声锚点）；
 * - Runtime.evaluate JSON 提取 / 让位标志轮询；
 * - YieldClassifier 联动：窗口外输入 → yield；窗口内（自动化回声）→ 忽略；静默 3s → 恢复。
 */
import { describe, expect, it } from 'vitest';
import { AutomationWindow, YieldClassifier } from '@xinglian/stealth-middleware';
import { CdpAutomation, createFixtureAutomation, extractNoteLinksSource, parseFixtureScenario, readDetailSource, startYieldMonitor } from './automation';
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
    // pollYieldFlag 是让位传感器，不再过 gate（真实链路 yield 死锁修复）：只有 probeFeatures 计闸
    expect(gateCalls).toBe(1);
    await automation.pollYieldFlag();
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

describe('真实搜索/详情提取（pilot 修复：SPA 竞态 + href 凭证导航 + 空详情护栏上游）', () => {
  const LINKS = [
    { id: '6613aabbccddeeff00112233', href: '/search_result/6613aabbccddeeff00112233?xsec_token=AB' },
    { id: '6613aabbccddeeff00112244', href: '/explore/6613aabbccddeeff00112244' },
  ];

  it('search：轮询提取直至非空（固定 500ms 实测恒 0 的竞态对策），并留存 href 供详情导航', async () => {
    const windows = new AutomationWindow();
    let extracts = 0;
    const { connection, sent } = fakeConnection((message) => {
      const expression = String((message.params as { expression?: string } | undefined)?.expression ?? '');
      if (message.method === 'Runtime.evaluate' && expression.includes('a[href]')) {
        extracts += 1;
        return { result: { value: extracts >= 3 ? LINKS : [] } };
      }
      return {};
    });
    const automation = new CdpAutomation({
      connection,
      sessionId: 's',
      gate: async () => {},
      windows,
      delay: async () => {},
      pollIntervalMs: 1,
      waitForTimeoutMs: 5_000,
      now: () => extracts * 10,
    });
    await expect(automation.search('防晒衣')).resolves.toEqual(['6613aabbccddeeff00112233', '6613aabbccddeeff00112244']);
    expect(extracts).toBe(3);
    expect(sent.some((m) => m.method === 'Page.navigate')).toBe(true);
  });

  it('search：轮询超时优雅返回空数组（上层 noResult 口径），evaluate 异常不中断轮询', async () => {
    let calls = 0;
    const { connection } = fakeConnection(() => {
      calls += 1;
      return calls % 2 === 0 ? { result: { value: [] } } : { exceptionDetails: { text: 'context destroyed' } };
    });
    let tick = 0;
    const automation = new CdpAutomation({
      connection,
      sessionId: 's',
      gate: async () => {},
      windows: new AutomationWindow(),
      delay: async () => {},
      pollIntervalMs: 10,
      waitForTimeoutMs: 100,
      now: () => (tick += 30),
    });
    await expect(automation.search('kw')).resolves.toEqual([]);
  });

  it('pollYieldFlag 不经过让位闸门（真实链路 yield 死锁锁定：release 依赖本传感器）', async () => {
    let gateCalls = 0;
    const { connection } = fakeConnection((message) => {
      const expression = String((message.params as { expression?: string } | undefined)?.expression ?? '');
      if (message.method === 'Runtime.evaluate' && expression.includes('__khs_yield__')) {
        return { result: { value: 1728888888888 } };
      }
      return {};
    });
    const automation = new CdpAutomation({
      connection,
      sessionId: 's',
      gate: () => {
        gateCalls += 1;
        return new Promise<void>(() => {}); // 永不放行（模拟让位挂起中）
      },
      windows: new AutomationWindow(),
      delay: async () => {},
    });
    // 若传感器仍过 gate，此调用将永远挂起（测试超时即失败）
    await expect(automation.pollYieldFlag()).resolves.toBe(1728888888888);
    expect(gateCalls).toBe(0);
  });

  it('readDetail：用搜索留存的带 token href 导航到详情上下文，轮询到非空字段即回', async () => {
    let detailCalls = 0;
    const { connection, sent } = fakeConnection((message) => {
      const expression = String((message.params as { expression?: string } | undefined)?.expression ?? '');
      if (message.method === 'Runtime.evaluate' && expression.includes('a[href]')) {
        return { result: { value: LINKS } };
      }
      if (message.method === 'Runtime.evaluate' && expression.includes('#detail-title')) {
        detailCalls += 1;
        return {
          result: {
            value:
              detailCalls === 1
                ? null
                : {
                    noteId: '6613aabbccddeeff00112233',
                    title: '每次出门都是全副武装',
                    content: '防晒衣真的有用',
                    likes: 55,
                    collects: 3,
                    comments: 2,
                    tags: ['防晒衣'],
                    author: { name: null },
                    publishedAt: '04-24',
                    coverUrl: null,
                    imageUrls: [],
                  },
          },
        };
      }
      return {};
    });
    const automation = new CdpAutomation({
      connection,
      sessionId: 's',
      gate: async () => {},
      windows: new AutomationWindow(),
      delay: async () => {},
      pollIntervalMs: 1,
      waitForTimeoutMs: 5_000,
      now: () => detailCalls * 10,
    });
    await automation.search('kw');
    const detail = await automation.readDetail('6613aabbccddeeff00112233');
    expect(detail.title).toBe('每次出门都是全副武装');
    expect(detail.likes).toBe(55);
    const navUrls = sent.filter((m) => m.method === 'Page.navigate').map((m) => String((m.params as { url?: string }).url));
    expect(navUrls).toContain('https://www.xiaohongshu.com/search_result/6613aabbccddeeff00112233?xsec_token=AB');
  });

  it('readDetail：无留存 href 时先试当前页（note 路由已在详情），有字段则不导航', async () => {
    const { connection, sent } = fakeConnection((message) => {
      const expression = String((message.params as { expression?: string } | undefined)?.expression ?? '');
      if (message.method === 'Runtime.evaluate' && expression.includes('#detail-title')) {
        return {
          result: {
            value: {
              noteId: '6613aabbccddeeff00112244',
              title: 'T',
              content: 'C',
              likes: 1,
              collects: 0,
              comments: 0,
              tags: [],
              author: { name: null },
              publishedAt: null,
              coverUrl: null,
              imageUrls: [],
            },
          },
        };
      }
      return {};
    });
    const automation = new CdpAutomation({
      connection,
      sessionId: 's',
      gate: async () => {},
      windows: new AutomationWindow(),
      delay: async () => {},
    });
    const detail = await automation.readDetail('6613aabbccddeeff00112244');
    expect(detail.title).toBe('T');
    expect(sent.some((m) => m.method === 'Page.navigate')).toBe(false);
  });

  it('extractNoteLinksSource：按 href 提取 id+href；同一 id 优先保留带 xsec_token 的（300031 风控对策）；用户主页不误收', () => {
    const anchors = [
      { href: '/explore/6613aabbccddeeff00112233' },
      { href: '/search_result/6613aabbccddeeff00112233?xsec_token=AB' },
      { href: '/explore/6613aabbccddeeff00112244' },
      { href: '/user/profile/6613aabbccddeeff00112255' },
      { href: '/search_result/6613aabbccddeeff00112244?xsec_token=CD' },
      { href: 'javascript:;' },
    ];
    const stub = { querySelectorAll: () => anchors.map((a) => ({ getAttribute: (k: string) => (k === 'href' ? a.href : null) })) };
    (globalThis as { document?: unknown }).document = stub;
    try {
      const links = new Function(`return ${extractNoteLinksSource()}`)() as Array<{ id: string; href: string }>;
      expect(links).toEqual([
        { id: '6613aabbccddeeff00112233', href: '/search_result/6613aabbccddeeff00112233?xsec_token=AB' },
        { id: '6613aabbccddeeff00112244', href: '/search_result/6613aabbccddeeff00112244?xsec_token=CD' },
      ]);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('readDetailSource：互动数「万/w/k」量级解析（1.5万 → 15000）与字段提取', () => {
    const bySel: Record<string, string> = {
      '#detail-title': '防晒衣怎么选',
      '#detail-desc': '面料 UPF50+',
      '.engage-bar .like .count': '1.5万',
      '.engage-bar .collect .count': '2031',
      '.engage-bar .chat .count': '1.2万',
      '.date': '04-24',
    };
    const stub = {
      querySelector: (sel: string) => (bySel[sel] ? { textContent: bySel[sel] } : null),
      querySelectorAll: () => [],
    };
    (globalThis as { document?: unknown }).document = stub;
    try {
      const detail = new Function(`return ${readDetailSource(JSON.stringify('n1'))}`)() as { likes: number; collects: number; comments: number; title: string };
      expect(detail.title).toBe('防晒衣怎么选');
      expect(detail.likes).toBe(15000);
      expect(detail.collects).toBe(2031);
      expect(detail.comments).toBe(12000);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('readDetailSource：现代互动区选择器（2026-10 真页取证 .like/.collect/.chat-wrapper）与 og:image property 属性', () => {
    const metaHtml = [{ getAttribute: (k: string) => (k === 'content' ? 'https://img.xhscdn.com/cover.jpg' : null) }];
    const stub = {
      querySelector: (sel: string) => {
        const bySel: Record<string, string> = {
          '#detail-title': '标题',
          '.like-wrapper .count': '87',
          '.collect-wrapper .count': '2310',
          '.chat-wrapper .count': '456',
        };
        return bySel[sel] ? { textContent: bySel[sel] } : null;
      },
      querySelectorAll: (sel: string) => (sel === 'meta[property="og:image"], meta[name="og:image"]' ? metaHtml : []),
    };
    (globalThis as { document?: unknown }).document = stub;
    try {
      const detail = new Function(`return ${readDetailSource(JSON.stringify('n2'))}`)() as { likes: number; collects: number; comments: number; imageUrls: string[] };
      expect(detail.likes).toBe(87);
      expect(detail.collects).toBe(2310);
      expect(detail.comments).toBe(456);
      expect(detail.imageUrls).toEqual(['https://img.xhscdn.com/cover.jpg']);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
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

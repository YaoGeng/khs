/**
 * 最小 CDP 动作封装（m1-insight-plan todo 7 = T-M1-04⑤；FR-4.5 让位真实信号接线）。
 *
 * 形态（编排上下文⑦）：采集所需页面读取/交互只新增三类最小动作——
 * Runtime.evaluate 提取 JSON（returnByValue）、等待页面特征 = 轮询 evaluate selector 命中、
 * Page.navigate（navigateTab 同款唯一合法移动形态）。所有动作：
 * - 前置 await 宿主 gate（= browser-service whenAutomationAllowed，让位期间挂起）；
 * - 包 AutomationWindow start/end（窗口内输入判自动化回声丢弃，防自触发回环）；
 * - 页面钩子经 Page.addScriptToEvaluateOnNewDocument 注入 PASSIVE_INPUT_LISTENER_SCRIPT
 *   （keydown/pointerdown 1s 节流写 window.__khs_yield__）+ WEBDRIVER_FLAG_REMOVAL_SCRIPT
 *   （stealth 保守三项之一）。
 *
 * 动作间让位轮询：YieldMonitor 周期读 window.__khs_yield__ 喂 YieldClassifier；
 * 窗口外输入 → 宿主 onUserInput（runner.yieldTask）；静默 ≥3s → onSilenceResume。
 *
 * 本文件 electron-free（connection/gate/时钟全部注入）；mock CDP = createFixtureAutomation
 * （env XINGLIAN_COLLECT_FIXTURE seam，e2e 与调试期兜底，M0 debug 钩子同款后门口径）。
 */
import {
  PASSIVE_INPUT_LISTENER_SCRIPT,
  WEBDRIVER_FLAG_REMOVAL_SCRIPT,
  YIELD_FLAG_GLOBAL,
  AutomationWindow,
  YieldClassifier,
} from '@xinglian/stealth-middleware';
import type { CdpConnection } from './cdp';

/* ------------------------------ 采集自动化面 ------------------------------ */

export interface NoteDetail {
  noteId: string;
  title: string | null;
  content: string | null;
  likes: number;
  collects: number;
  comments: number;
  tags: string[];
  author: { name: string | null };
  publishedAt: string | null;
  coverUrl: string | null;
  imageUrls: string[];
}

/** 采集动作自动化面（真实 CDP / mock CDP 双实现；collect-service 只依赖本接口） */
export interface CollectAutomation {
  /** 注入页面钩子（yield passive 监听 + webdriver 去标志；幂等） */
  installPageHooks(): Promise<void>;
  /** 读取 window.__khs_yield__（最近一次用户输入 epoch ms；无则 null） */
  pollYieldFlag(): Promise<number | null>;
  /** 特征探测：selector → 命中数（preflight 登录态 / blockedFeatures 验证码） */
  probeFeatures(selectors: string[]): Promise<Record<string, number>>;
  navigate(url: string): Promise<void>;
  /** 搜索：返回笔记 id 列表（页面顺序） */
  search(keyword: string): Promise<string[]>;
  /** 详情批读（单条） */
  readDetail(noteId: string): Promise<NoteDetail>;
}

export interface CdpAutomationDeps {
  readonly connection: CdpConnection;
  /** flat 会话 id（Target.attachToTarget flatten） */
  readonly sessionId: string;
  /** 让位门（宿主 = browser-service.whenAutomationAllowed 唯一入口） */
  readonly gate: () => Promise<void>;
  readonly windows: AutomationWindow;
  readonly delay: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** waitForFeature 轮询间隔/超时（测试缩短） */
  readonly pollIntervalMs?: number;
  readonly waitForTimeoutMs?: number;
}

const EVAL_TIMEOUT_DEFAULT = 10_000;
const POLL_DEFAULT = 200;

export class CdpAutomation {
  private readonly deps: CdpAutomationDeps;
  private hooksInstalled = false;

  constructor(deps: CdpAutomationDeps) {
    this.deps = deps;
  }

  private get now(): () => number {
    return this.deps.now ?? (() => Date.now());
  }

  /** 每个动作的统一外壳：让位门 → 开窗 → 动作 → 关窗（AutomationWindow 回声抑制的锚点） */
  private async action<T>(label: string, fn: () => Promise<T>): Promise<T> {
    await this.deps.gate();
    const startedAt = this.now();
    this.deps.windows.begin(startedAt);
    try {
      return await fn();
    } finally {
      this.deps.windows.end(this.now());
      void label;
    }
  }

  /** Runtime.evaluate returnByValue JSON 提取 */
  private async evaluate<T>(expression: string): Promise<T> {
    const result = await this.deps.connection.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: false },
      this.deps.sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(`页面表达式执行失败: ${JSON.stringify(result.exceptionDetails).slice(0, 200)}`);
    }
    return result.result?.value as T;
  }

  async installPageHooks(): Promise<void> {
    if (this.hooksInstalled) return;
    await this.action('install-hooks', async () => {
      await this.deps.connection.send('Page.enable', {}, this.deps.sessionId);
      // stealth 保守三项之一 + FR-4.5 passive 让位监听（均 addScriptToEvaluateOnNewDocument）
      await this.deps.connection.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: WEBDRIVER_FLAG_REMOVAL_SCRIPT },
        this.deps.sessionId,
      );
      await this.deps.connection.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: PASSIVE_INPUT_LISTENER_SCRIPT },
        this.deps.sessionId,
      );
      await this.deps.connection.send(
        'Runtime.evaluate',
        { expression: `(${installHooksSource()})()`, returnByValue: true },
        this.deps.sessionId,
      );
    });
    this.hooksInstalled = true;
  }

  async pollYieldFlag(): Promise<number | null> {
    return this.action('poll-yield', async () => {
      const value = await this.evaluate<number | null>(
        `typeof window.${YIELD_FLAG_GLOBAL} === 'number' ? window.${YIELD_FLAG_GLOBAL} : null`,
      );
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    });
  }

  async probeFeatures(selectors: string[]): Promise<Record<string, number>> {
    return this.action('probe-features', async () => {
      return this.evaluate<Record<string, number>>(probeFeaturesSource(selectors));
    });
  }

  async navigate(url: string): Promise<void> {
    await this.action('navigate', async () => {
      await this.deps.connection.send('Page.navigate', { url }, this.deps.sessionId);
    });
  }

  /** 等待页面特征 = 轮询 evaluate selector 命中（minCount 满足即通过；超时抛错） */
  async waitForFeature(selector: string, minCount = 1): Promise<void> {
    const interval = this.deps.pollIntervalMs ?? POLL_DEFAULT;
    const timeout = this.deps.waitForTimeoutMs ?? EVAL_TIMEOUT_DEFAULT;
    const deadline = this.now() + timeout;
    for (;;) {
      await this.deps.gate();
      const counts = await this.action('wait-feature', () =>
        this.evaluate<Record<string, number>>(probeFeaturesSource([selector])),
      );
      if ((counts[selector] ?? 0) >= minCount) return;
      if (this.now() + interval > deadline) {
        throw new Error(`等待页面特征超时: ${selector}（${timeout}ms）`);
      }
      await this.deps.delay(interval);
    }
  }

  async search(keyword: string): Promise<string[]> {
    return this.action('search', async () => {
      const escaped = JSON.stringify(keyword);
      await this.deps.connection.send('Page.navigate', { url: 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(keyword) }, this.deps.sessionId);
      await this.deps.delay(500);
      return this.evaluate<string[]>(extractNoteIdsSource(escaped));
    });
  }

  async readDetail(noteId: string): Promise<NoteDetail> {
    return this.action('read-detail', async () => {
      return this.evaluate<NoteDetail>(readDetailSource(JSON.stringify(noteId)));
    });
  }
}

/* ---- 页面侧表达式源码（字符串模板；与 PASSIVE 监听同级的只读提取，无 DOM 写入） ---- */

function installHooksSource(): string {
  return `function () {
  return true;
}`;
}

function probeFeaturesSource(selectors: string[]): string {
  const list = JSON.stringify(selectors);
  return `(function () {
  var out = {};
  var selectors = ${list};
  for (var i = 0; i < selectors.length; i++) {
    try { out[selectors[i]] = document.querySelectorAll(selectors[i]).length; }
    catch (e) { out[selectors[i]] = 0; }
  }
  return out;
})()`;
}

function extractNoteIdsSource(keywordJson: string): string {
  return `(function () {
  var keyword = ${keywordJson};
  var links = Array.prototype.slice.call(document.querySelectorAll('section.note-item a.cover, a.cover'));
  var ids = [];
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href') || '';
    var m = /(?:\\/explore\\/|\\/search_result\\/|note=)([0-9a-fA-F]{16,32})/.exec(href);
    if (m && ids.indexOf(m[1]) < 0) ids.push(m[1]);
  }
  return ids;
})()`;
}

function readDetailSource(noteIdJson: string): string {
  return `(function () {
  var noteId = ${noteIdJson};
  var text = function (sel) {
    var el = document.querySelector(sel);
    return el ? (el.textContent || '').trim() : null;
  };
  var count = function (sel) {
    var raw = text(sel);
    if (!raw) return 0;
    var m = parseInt(raw.replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(m) ? m : 0;
  };
  var list = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel)).map(function (el) {
      return (el.textContent || '').trim();
    }).filter(Boolean);
  };
  var images = Array.prototype.slice.call(document.querySelectorAll('meta[name="og:image"]')).map(function (m) {
    return m.getAttribute('content') || '';
  }).filter(Boolean);
  return {
    noteId: noteId,
    title: text('#detail-title'),
    content: text('#detail-desc'),
    likes: count('.engage-bar .like .count'),
    collects: count('.engage-bar .collect .count'),
    comments: count('.engage-bar .chat .count'),
    tags: list('#detail-desc a.tag'),
    author: { name: text('.author-container .username') },
    publishedAt: text('.date') || null,
    coverUrl: images[0] || null,
    imageUrls: images
  };
})()`;
}

/* ------------------------------ 让位监视器（动作间轮询 → 分类器） ------------------------------ */

export interface YieldMonitorDeps {
  /** 让位标志轮询（真实 = CdpAutomation.pollYieldFlag；mock = fixture 注入值） */
  readonly poll: () => Promise<number | null>;
  /** 轮询间隔（缺省 500ms；e2e 缩短） */
  readonly intervalMs?: number;
  readonly classifier?: YieldClassifier;
  readonly delay: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** 窗口外真实用户输入（宿主 = browser-service.yieldToUser + runner.yieldTask） */
  readonly onUserInput?: (at: number) => void;
  /** 静默 ≥3s 恢复（宿主 = browser-service.resumeFromYield + runner.resume） */
  readonly onSilenceResume?: (at: number) => void;
  readonly logger?: { debug?: (msg: string, payload?: unknown) => void };
}

export interface YieldMonitorHandle {
  stop(): void;
  classifier: YieldClassifier;
}

/**
 * 让位监视器：动作间轮询 __khs_yield__ → AutomationWindow 回声过滤 → YieldClassifier。
 * 返回 stop()（任务终态/退出时调用，防句柄泄漏）与 classifier（状态查询面）。
 */
export function startYieldMonitor(deps: YieldMonitorDeps): YieldMonitorHandle {
  const classifier = deps.classifier ?? new YieldClassifier();
  const interval = deps.intervalMs ?? 500;
  const now = deps.now ?? (() => Date.now());
  let stopped = false;
  let lastFedAt: number | null = null;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const at = await deps.poll();
        // 只喂「新」时间戳：页面脚本 1s 节流写 __khs_yield__，同一时间戳重复轮询不得
        // 反复触发 yield（防静默恢复后被陈旧值再次打回 yielded 的振荡）
        if (at !== null && at !== lastFedAt) {
          lastFedAt = at;
          if (classifier.observe({ type: 'keydown', at }) === 'yield') {
            deps.logger?.debug?.('yield:user-input', { at });
            deps.onUserInput?.(at);
          }
        }
        if (classifier.maybeResume(now())) {
          deps.logger?.debug?.('yield:silence-resume', { at: now() });
          deps.onSilenceResume?.(now());
        }
      } catch {
        // 轮询失败（页面跳转中）：下个周期重试
      }
      await deps.delay(interval);
    }
  };
  void loop();
  return { stop: () => { stopped = true; }, classifier };
}

/* ------------------------------ mock CDP（fixture 场景） ------------------------------ */

export interface FixtureNote {
  noteId: string;
  title: string;
  content: string;
  likes: number;
  collects: number;
  comments: number;
  tags: string[];
  author: string;
  publishedAt: string | null;
}

export interface FixtureScenario {
  /** 搜索结果（顺序即页面顺序；所有路由输入共用此池，e2e 由 targetTotal 截断） */
  notes: FixtureNote[];
  /** 验证码特征命中（circuit e2e 置 true） */
  captcha: boolean;
  /** 登录入口特征可见（未登录态；preflight 置 true 演示引导重登） */
  loginEntryVisible: boolean;
  /** blockedFeatures selector 形态（与 adapters-xhs 的 selectors 表同键） */
  selectors?: Record<string, string>;
  /** simulateUserInput 写入的让位时间戳（e2e 经 debug 钩子注入） */
  yieldFlagValue?: number | null;
}

export interface FixtureAutomation extends CollectAutomation {
  readonly scenario: FixtureScenario;
  /** e2e/调试后门：模拟真实用户输入（等价页面脚本写 __khs_yield__） */
  simulateUserInput(atMs?: number): void;
}

/** mock CDP 自动化（不触任何真实浏览器进程；形态与 CdpAutomation 逐方法对齐） */
export function createFixtureAutomation(scenario: FixtureScenario, opts: { gate?: () => Promise<void>; delay?: (ms: number) => Promise<void>; now?: () => number } = {}): FixtureAutomation {
  const gate = opts.gate ?? (async () => {});
  const delay = opts.delay ?? (async () => {});
  let yieldFlagValue: number | null = scenario.yieldFlagValue ?? null;

  const automation: FixtureAutomation = {
    scenario,
    simulateUserInput(atMs) {
      yieldFlagValue = atMs ?? Date.now();
    },
    async installPageHooks() {
      await gate();
    },
    async pollYieldFlag() {
      await gate();
      return yieldFlagValue;
    },
    async probeFeatures(selectors) {
      await gate();
      await delay(0);
      const counts: Record<string, number> = {};
      for (const selector of selectors) {
        // 入参为已解析 CSS selector（xhsAdapterDsl.selectors 解析值）
        const isCaptcha = selector === '.captcha-container' || selector === 'iframe#captcha-iframe' || selector === 'captchaContainer' || selector === 'captchaIframe';
        const isLoginEntry = selector === '.login-btn' || selector === 'loginEntry';
        counts[selector] = (isCaptcha && scenario.captcha) || (isLoginEntry && scenario.loginEntryVisible) ? 1 : 0;
      }
      return counts;
    },
    async navigate() {
      await gate();
      await delay(0);
    },
    async search() {
      await gate();
      await delay(0);
      return scenario.notes.map((n) => n.noteId);
    },
    async readDetail(noteId) {
      await gate();
      await delay(0);
      const note = scenario.notes.find((n) => n.noteId === noteId);
      if (!note) throw new Error(`fixture note not found: ${noteId}`);
      return {
        noteId: note.noteId,
        title: note.title,
        content: note.content,
        likes: note.likes,
        collects: note.collects,
        comments: note.comments,
        tags: [...note.tags],
        author: { name: note.author },
        publishedAt: note.publishedAt,
        coverUrl: null,
        imageUrls: [],
      };
    },
  };
  return automation;
}

/** 场景 JSON 反序列化（e2e seam：XINGLIAN_COLLECT_FIXTURE=<path>） */
export function parseFixtureScenario(json: string): FixtureScenario {
  const raw = JSON.parse(json) as Partial<FixtureScenario>;
  if (!Array.isArray(raw.notes)) throw new Error('fixture 场景非法：notes 缺失');
  return {
    notes: raw.notes,
    captcha: raw.captcha === true,
    loginEntryVisible: raw.loginEntryVisible === true,
    ...(raw.selectors ? { selectors: raw.selectors } : {}),
    ...(raw.yieldFlagValue !== undefined ? { yieldFlagValue: raw.yieldFlagValue } : {}),
  };
}

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
/** 详情轮询上限：压在单条读预算（NFR-1 ≤8s）内，给导航耗时留余量 */
const DETAIL_POLL_CAP = 5_000;
/** 单条详情读取总目标（导航起点算起）：压在 NFR-1 8s 预算内，留 action 外壳/账本开销余量。
 *  实采教训（2026-10-16 两次任务被 10.2s 打死）：冷会话首条 Runtime.evaluate 可阻塞数秒，
 *  而 poll 截止只在 evaluate 之间检查——跨截止的单次往返把整条读拖出预算，任务 failed
 *  （不可恢复）且已读数据被丢弃。故轮询必须被绝对截止硬约束。 */
const DETAIL_ITEM_TARGET_MS = 7_600;
/** 单次 evaluate 往返竞速上限：页面忙（hydration/编译）时可阻塞数秒；竞速上限随剩余
 *  预算收缩，保证任何一次往返都跑不出截止。竞速输掉的往返按跳转中处理（下周期重试）；
 *  迟到的响应解析到已放弃的 promise 上，无副作用。 */
const EVAL_ROUNDTRIP_CAP = 2_000;
/** 互动计数补轮窗口：SSR 标题先于 React hydration 的计数渲染（2026-10-16 实采实证：
 *  标题到位即回导致整批计数 0，而同页延时 2.5s 后计数可取——见
 *  .omo/evidence/engagement-selector-fix/）。正文出现后给计数至多这么多毫秒补轮；
 *  真实 0 互动笔记最多多等这一段，仍在单条 8s 预算内。 */
const ENGAGE_SETTLE_CAP = 2_000;
/** 平台 origin（宿主预热/导航兜底共用；搜索与详情 URL 的同源基座） */
export const XHS_ORIGIN = 'https://www.xiaohongshu.com';

/** 空详情占位（pollDetail 轮询失败/硬停的兜底形状） */
function emptyDetail(noteId: string): NoteDetail {
  return { noteId, title: null, content: null, likes: 0, collects: 0, comments: 0, tags: [], author: { name: null }, publishedAt: null, coverUrl: null, imageUrls: [] };
}

export class CdpAutomation {
  private readonly deps: CdpAutomationDeps;
  private hooksInstalled = false;
  /** 搜索时留存的笔记 href（含 xsec_token；readDetail 导航凭证） */
  private noteHrefs = new Map<string, string>();

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

  /** 让位传感器专用：**不走 gate / AutomationWindow**。闸门 release 只能由本传感器的静默
   *  判断触发——若传感器自己过 gate，让位期间 poll 挂起等 release → 循环等待死锁
   *  （pilot 实测；fixture 的 gate 是空操作，e2e 测不出）。轮询失败按无输入处置。 */
  async pollYieldFlag(): Promise<number | null> {
    try {
      const value = await this.evaluate<number | null>(
        `typeof window.${YIELD_FLAG_GLOBAL} === 'number' ? window.${YIELD_FLAG_GLOBAL} : null`,
      );
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
      // 页面跳转中：视为无输入，下个周期重试
      return null;
    }
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
      await this.deps.connection.send('Page.navigate', { url: 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(keyword) }, this.deps.sessionId);
      // 真实搜索页是 SPA：Page.navigate 完成只代表导航提交，列表要等 XHR+渲染（pilot 实测
      // 固定 500ms 提取恒 0）。轮询提取直至非空；期间 evaluate 异常（跳转中上下文销毁）按
      // 空结果重试；超时返回末次结果（可能为空）走上层 noResult 口径，不抛错。
      const links = await this.pollExtractNoteLinks();
      for (const link of links) this.noteHrefs.set(link.id, link.href);
      return links.map((link) => link.id);
    });
  }

  /** 搜索结果轮询提取（竞态对策）：非空即回；deadline 兜底返回空数组 */
  private async pollExtractNoteLinks(): Promise<Array<{ id: string; href: string }>> {
    const interval = this.deps.pollIntervalMs ?? POLL_DEFAULT;
    const timeout = this.deps.waitForTimeoutMs ?? EVAL_TIMEOUT_DEFAULT;
    const deadline = this.now() + timeout;
    for (;;) {
      let links: Array<{ id: string; href: string }> = [];
      try {
        links = await this.evaluate<Array<{ id: string; href: string }>>(extractNoteLinksSource());
      } catch {
        // 页面跳转/上下文重建中：下个周期重试
      }
      if (links.length > 0 || this.now() + interval > deadline) return links;
      await this.deps.delay(interval);
    }
  }

  async readDetail(noteId: string): Promise<NoteDetail> {
    return this.action('read-detail', async () => {
      // 单条读总目标：从导航/首评起点算（NFR-1 8s 减余量）；轮询被它硬约束，
      // 杜绝「evaluate 阻塞跨过 poll 截止」把整条读拖出预算打死任务。
      const hardDeadlineAt = this.now() + DETAIL_ITEM_TARGET_MS;
      const stored = this.noteHrefs.get(noteId);
      if (stored) {
        // 关键词路由：详情必须在笔记上下文读（pilot 实测在搜索结果页 evaluate 详情选择器恒空），
        // 用带 xsec_token 的完整 href 导航后再轮询提取。
        const target = new URL(stored, 'https://www.xiaohongshu.com').toString();
        await this.deps.connection.send('Page.navigate', { url: target }, this.deps.sessionId);
        return this.pollDetail(noteId, hardDeadlineAt);
      }
      // note/user 路由：服务层已把页面导航到目标，先试当前页；无详情再兜底裸 /explore/<id>。
      const direct = await this.pollDetail(noteId, hardDeadlineAt);
      if (direct.title !== null || direct.content !== null) return direct;
      await this.deps.connection.send('Page.navigate', { url: `https://www.xiaohongshu.com/explore/${noteId}` }, this.deps.sessionId);
      return this.pollDetail(noteId, hardDeadlineAt);
    });
  }

  /** 详情轮询提取：标题或正文出现后，若互动计数为 0 再给 ENGAGE_SETTLE_CAP 补轮
   *  （hydration 计数晚于 SSR 标题挂载）；期间 evaluate 异常/竞速超时按跳转中重试；
   *  deadline 兜底返回空字段对象（由上层空详情护栏计 noResult，不入库）。
   *  硬约束（2026-10-16 实采教训）：poll 截止只在 evaluate 之间检查时，冷会话单次
   *  往返阻塞可跨过截止（10.2s > 8s 任务被打死）——故每次 evaluate 都带不超出剩余
   *  预算的竞速上限，且循环入口硬检查截止；硬停时返回最后已见数据（标题可能已到、
   *  计数未挂载——宁返回部分数据也不丢弃）。 */
  private async pollDetail(noteId: string, hardDeadlineAt: number = Number.POSITIVE_INFINITY): Promise<NoteDetail> {
    const interval = this.deps.pollIntervalMs ?? POLL_DEFAULT;
    const timeout = Math.min(this.deps.waitForTimeoutMs ?? EVAL_TIMEOUT_DEFAULT, DETAIL_POLL_CAP);
    const deadline = Math.min(this.now() + timeout, hardDeadlineAt);
    let settleDeadline = 0;
    let lastKnown: NoteDetail | null = null;
    for (;;) {
      const active = settleDeadline > 0 ? settleDeadline : deadline;
      // 竞速上限随剩余预算收缩：任何一次往返都跑不出截止；无剩余即硬停
      const raceCap = Math.min(EVAL_ROUNDTRIP_CAP, active - this.now());
      if (raceCap <= 0) {
        return lastKnown ?? emptyDetail(noteId);
      }
      let detail: NoteDetail | null = null;
      try {
        detail = await Promise.race([
          this.evaluate<NoteDetail>(readDetailSource(JSON.stringify(noteId))),
          this.deps.delay(raceCap).then(() => null),
        ]);
      } catch {
        // 页面跳转/上下文重建中：下个周期重试
      }
      if (detail !== null) lastKnown = detail;
      const current = detail ?? emptyDetail(noteId);
      if (current.title !== null || current.content !== null) {
        if (current.likes + current.collects + current.comments > 0) return current;
        // 正文已到位而计数为 0：要么真 0，要么计数未挂载——补轮窗口内再取，超窗即回
        if (settleDeadline === 0) settleDeadline = Math.min(this.now() + ENGAGE_SETTLE_CAP, deadline);
        if (this.now() + interval > settleDeadline) return current;
      } else if (this.now() + interval > deadline) {
        return current;
      }
      await this.deps.delay(interval);
    }
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

/** 搜索结果笔记链接提取（页面侧表达式；导出供单测以 stub document 直评源码）。
 *  返回 [{id, href}]：href 含 xsec_token 是笔记详情页可达的必要凭证（裸 /explore/<id> 会被
 *  风控拦截，pilot 实测 error_code=300031）——同一 id 出现多条时**优先保留带 token 的**。 */
export function extractNoteLinksSource(): string {
  return `(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('a[href]'));
  var seen = {};
  var order = [];
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href') || '';
    var m = /(?:\\/explore\\/|\\/search_result\\/|note=)([0-9a-fA-F]{16,32})/.exec(href);
    if (!m) continue;
    var id = m[1];
    var prev = seen[id];
    var tokened = href.indexOf('xsec_token') >= 0;
    if (!prev) {
      seen[id] = { id: id, href: href, tokened: tokened };
      order.push(id);
    } else if (tokened && !prev.tokened) {
      seen[id] = { id: id, href: href, tokened: true };
    }
  }
  var out = [];
  for (var j = 0; j < order.length; j++) out.push({ id: seen[order[j]].id, href: seen[order[j]].href });
  return out;
})()`;
}

/** 笔记详情提取（页面侧表达式；导出供单测以 stub document 直评源码）。
 *  选择器对应笔记详情上下文（/explore/<id> 或搜索态详情视图），必须在导航到位后 evaluate。
 *  互动数走三链（2026-10-16 登录态真页取证，scripts/probe-engagement.mjs）：笔记级互动条是
 *  `.engage-bar`（element class="interactions engage-bar"）内套**现代 wrapper**
 *  (.like-wrapper/.collect-wrapper/.chat-wrapper .count)——必须用 engage-bar 作用域：
 *  详情页评论区每条评论各有同名 wrapper（实测 31~48 个），裸 .like-wrapper .count 会取到
 *  评论的赞；旧链 `.engage-bar .like .count`（wrapper 换代前结构）与裸链只作兜底。
 *  封面/图集（同日取证）：正文图**无专属容器**（.media-container/.swiper-slide/.note-content img
 *  全 0 命中），稳定签名是 img 宿主 `sns-webpic-*`（头像在 sns-avatar、图标在 fe-platform/data:，
 *  父层 .cover mask ld 轮播位仅作旁证）；og:image 是全站通用分享图，不再充当封面兜底（宁缺毋滥）。 */
export function readDetailSource(noteIdJson: string): string {
  return `(function () {
  var noteId = ${noteIdJson};
  var text = function (sel) {
    var el = document.querySelector(sel);
    return el ? (el.textContent || '').trim() : null;
  };
  var count = function (sel) {
    var raw = text(sel);
    if (!raw) return 0;
    var m = /([\\d.]+)\\s*(万|w|k)?/i.exec(raw);
    if (!m) return 0;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    var unit = (m[2] || '').toLowerCase();
    var mult = unit === '万' || unit === 'w' ? 10000 : unit === 'k' ? 1000 : 1;
    return Math.round(n * mult);
  };
  var countOf = function (selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      var v = count(selectors[i]);
      if (v > 0) return v;
    }
    return 0;
  };
  var list = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel)).map(function (el) {
      return (el.textContent || '').trim();
    }).filter(Boolean);
  };
  var seen = {};
  var images = Array.prototype.slice.call(document.querySelectorAll('img')).map(function (img) {
    return img.currentSrc || img.src || '';
  }).filter(function (src) {
    if (src.indexOf('sns-webpic') < 0 || seen[src]) return false;
    seen[src] = 1;
    return true;
  });
  return {
    noteId: noteId,
    title: text('#detail-title'),
    content: text('#detail-desc'),
    likes: countOf(['.engage-bar .like-wrapper .count', '.engage-bar .like .count', '.like-wrapper .count']),
    collects: countOf(['.engage-bar .collect-wrapper .count', '.engage-bar .collect .count', '.collect-wrapper .count']),
    comments: countOf(['.engage-bar .chat-wrapper .count', '.engage-bar .chat .count', '.chat-wrapper .count']),
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

/**
 * 1688 收藏/询盘执行端口（T-M2-04；写操作 CDP 实现——与 sourcing-port 同一受控浏览器）。
 *
 * 执行形态（T-M2-01/登录态取证锚点，2026-10-18 probe-1688-loggedin.json）：
 * - 每 offer 开独立 tab（Target.createTarget → flat attach）→ 详情页 URL 直达 →
 *   页面特征轮询（DSL offerTitle = module-od-title h1）→ 写操作 → Target.closeTarget。
 *   用户在确认弹窗在场的透明窗口内操作——开前台 tab（backgrounded=false）让动作可见。
 * - 点击 = 元素 bbox 中心 + 高斯偏移 → Input.dispatchMouseEvent（§7.2：优先真实交互，
 *   禁 JS 直取 DOM 写入）；键入 = 点击聚焦 + Input.insertText（IME 同款路径）。
 * - 写操作位点（DSL v1.1.1 校准）：收藏 [data-click="FAV"] / 关注店铺
 *   [data-click="follow-shop"] / 询盘入口 [data-click="咨询客服"]；会话窗内部位点
 *   （chat-window/textarea/send/sent）为「合理编写」待用户在场联调——超时如实报
 *   chat-window-missing，不臆造成功。
 * - 成功态核对（S2 verify 语义）：收藏后查 favoriteDoneState（待联调选择器——超时按
 *   clicked-unverified 诚实记录，不判成功也不判失败）。
 * - fixture seam：createFixtureOutreachPort 回放内存会话（e2e 全链路不碰真站）。
 */
import type { CdpConnection } from './cdp';

/** 详情页提取（素材留存 FR-6.5 数据源） */
export interface DetailExtraction {
  title: string | null;
  supplierName: string | null;
  priceText: string | null;
  salesText: string | null;
  /** 商品详情模块文本（素材 kind=desc；≤2000 字） */
  descText: string | null;
  /** 商品图集（cbu01 图片域过滤后；≤12 张） */
  gallerySrcs: string[];
}

export interface OfferSession {
  /** 轮询等待页面特征命中（超时抛错） */
  waitForFeature(selector: string, minCount?: number, timeoutMs?: number): Promise<void>;
  /** 一次性特征计数（confirm.expect / verify 核对用） */
  checkFeatures(selectors: string[]): Promise<Record<string, number>>;
  /** blockedFeatures 探测（登录墙/滑块命中返回特征名） */
  detectBlocked(): Promise<string | null>;
  /** 拟人点击（bbox 中心 + Input.dispatchMouseEvent） */
  click(selector: string): Promise<void>;
  /** 点击聚焦 + insertText 键入 */
  type(selector: string, text: string): Promise<void>;
  extractDetail(): Promise<DetailExtraction>;
  /** 页内 fetch 图片 → base64（素材留存；失败返回 null 不抛） */
  fetchAsBase64(url: string): Promise<{ base64: string; mime: string } | null>;
  close(): Promise<void>;
}

export interface OutreachPort {
  openOffer(offerUrl: string): Promise<OfferSession>;
}

/* ------------------------------ 页面侧源码 ------------------------------ */

/** 详情页特征探测 + 写位点解析源（生成：按选择器清单计数；点击目标取 bbox） */
function featuresSource(selectors: string[]): string {
  const list = JSON.stringify(selectors);
  return `(function () {
  var out = {};
  var sels = ${list};
  for (var i = 0; i < sels.length; i += 1) {
    try { out[sels[i]] = document.querySelectorAll(sels[i]).length; } catch (e) { out[sels[i]] = -1; }
  }
  return out;
})()`;
}

const DETECT_BLOCKED_SOURCE = `(function () {
  var sels = ['.login-panel', '[class*="login-dialog"]', 'iframe[src*="login"]', '#nc_1_wrapper', '.nc-container', '[class*="punish"]', '#captcha'];
  for (var i = 0; i < sels.length; i += 1) {
    try { if (document.querySelectorAll(sels[i]).length > 0) return sels[i]; } catch (e) {}
  }
  return null;
})()`;

const BBOX_SOURCE = (selector: string): string => {
  const sel = JSON.stringify(selector);
  return `(function () {
  var el = document.querySelector(${sel});
  if (!el) return null;
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`;
};

/** 详情提取源（锚点 = 2026-10-18 登录态取证：module-od-title h1 / shop-company-name /
 * priceMain+priceSub / 售N件 sales / collapse-header=商品详情 模块文本 / cbu01 图集） */
const EXTRACT_DETAIL_SOURCE = `(function () {
  var clean = function (s) { return (s || '').replace(/\\s+/g, ' ').trim(); };
  var titleEl = document.querySelector('[class*="module-od-title"] h1');
  var supplierEl = document.querySelector('[class*="shop-company-name"]');
  var main = document.querySelector('[class*="priceMain"]');
  var sub = document.querySelector('[class*="priceSub"]');
  var priceText = main ? clean('¥' + clean(main.textContent) + clean(sub ? sub.textContent : '')) : null;
  var salesText = null;
  var salesEls = document.querySelectorAll('[class*="sales"]');
  for (var i = 0; i < salesEls.length; i += 1) {
    var t = clean(salesEls[i].textContent);
    if (/\\d[\\d.]*(万|w)?\\+?件/.test(t) && t.length <= 24) { salesText = t; break; }
  }
  var descText = null;
  var modules = document.querySelectorAll('.od-collapse-module');
  for (var m = 0; m < modules.length; m += 1) {
    var head = modules[m].querySelector('.collapse-header');
    if (head && head.textContent.indexOf('商品详情') >= 0) {
      descText = clean(modules[m].innerText || modules[m].textContent).slice(0, 2000);
      break;
    }
  }
  var seen = {};
  var gallerySrcs = [];
  var imgs = document.querySelectorAll('[class*="gallery"] img');
  for (var g = 0; g < imgs.length && gallerySrcs.length < 12; g += 1) {
    var src = imgs[g].src || '';
    if (!/cbu01\\.alicdn\\.com/.test(src) || !/\\.(jpg|jpeg|png|webp)/.test(src)) continue;
    if (seen[src]) continue;
    seen[src] = 1;
    gallerySrcs.push(src);
  }
  return {
    title: titleEl ? clean(titleEl.textContent).slice(0, 160) : null,
    supplierName: supplierEl ? clean(supplierEl.textContent).slice(0, 80) : null,
    priceText: priceText,
    salesText: salesText,
    descText: descText,
    gallerySrcs: gallerySrcs
  };
})()`;

/** 页内 fetch 图片 → base64（同源 Cookie 携带；返回 {base64, mime}） */
const FETCH_IMAGE_SOURCE = (url: string): string => {
  const u = JSON.stringify(url);
  return `(async function () {
  try {
    var res = await fetch(${u}, { credentials: 'include' });
    if (!res.ok) return null;
    var blob = await res.blob();
    if (blob.size > 4 * 1024 * 1024) return null;
    var mime = blob.type || 'image/jpeg';
    var buf = await new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onloadend = function () { resolve(reader.result); };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(blob);
    });
    if (typeof buf !== 'string' || buf.indexOf('base64,') < 0) return null;
    return { base64: buf.slice(buf.indexOf('base64,') + 7), mime: mime };
  } catch (e) { return null; }
})()`;
};

/* ------------------------------ CDP 实现 ------------------------------ */

const POLL_INTERVAL_DEFAULT = 300;
const WAIT_TIMEOUT_DEFAULT = 12_000;

export interface CdpOutreachPortDeps {
  readonly connection: () => Promise<CdpConnection>;
  /** 浏览器级让位门（与采集/检索同一入口） */
  readonly gate: () => Promise<void>;
  readonly delay: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly logger?: { networkMeta?: (msg: string, payload?: unknown) => void };
}

/** 页面表达式求值（awaitPromise 可选：fetch 图片路径需要） */
async function evaluate<T>(
  connection: CdpConnection,
  sessionId: string,
  expression: string,
  awaitPromise = false,
): Promise<T> {
  const result = await connection.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(`页面表达式执行失败: ${JSON.stringify(result.exceptionDetails).slice(0, 160)}`);
  }
  return result.result?.value as T;
}

/** bbox 内高斯近似偏移（三角分布近似：两次随机均值收束于中心；±20% 半径） */
function jitter(width: number, height: number): { dx: number; dy: number } {
  const g = () => (Math.random() + Math.random() - 1) * 0.4;
  return { dx: Math.round(width * g()), dy: Math.round(height * g()) };
}

class CdpOfferSession implements OfferSession {
  constructor(
    private readonly connection: CdpConnection,
    private readonly sessionId: string,
    private readonly targetId: string,
    private readonly deps: CdpOutreachPortDeps,
  ) {}

  private get interval(): number {
    return this.deps.pollIntervalMs ?? POLL_INTERVAL_DEFAULT;
  }

  async waitForFeature(selector: string, minCount = 1, timeoutMs = WAIT_TIMEOUT_DEFAULT): Promise<void> {
    const deadline = (this.deps.now ?? (() => Date.now()))() + timeoutMs;
    for (;;) {
      let counts: Record<string, number> = {};
      try {
        counts = await evaluate<Record<string, number>>(this.connection, this.sessionId, featuresSource([selector]));
      } catch {
        // 跳转中上下文销毁：下轮重试
      }
      if ((counts[selector] ?? 0) >= minCount) return;
      if ((this.deps.now ?? (() => Date.now()))() + this.interval > deadline) {
        throw new Error(`E-OUTREACH-WAIT-TIMEOUT: 等待页面特征超时 ${selector}（${timeoutMs}ms）`);
      }
      await this.deps.delay(this.interval);
    }
  }

  async checkFeatures(selectors: string[]): Promise<Record<string, number>> {
    return evaluate<Record<string, number>>(this.connection, this.sessionId, featuresSource(selectors));
  }

  async detectBlocked(): Promise<string | null> {
    try {
      return await evaluate<string | null>(this.connection, this.sessionId, DETECT_BLOCKED_SOURCE);
    } catch {
      return null;
    }
  }

  async click(selector: string): Promise<void> {
    await this.deps.gate();
    const bbox = await evaluate<{ x: number; y: number; width: number; height: number } | null>(
      this.connection, this.sessionId, BBOX_SOURCE(selector),
    );
    if (!bbox) throw new Error(`E-OUTREACH-CLICK-TARGET-MISSING: 点击目标不可达 ${selector}`);
    const { dx, dy } = jitter(bbox.width, bbox.height);
    const x = Math.round(bbox.x + bbox.width / 2 + dx);
    const y = Math.round(bbox.y + bbox.height / 2 + dy);
    // §7.2 拟人：先移动后按压/释放（真实输入路径，禁 el.click() JS 写入）
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, this.sessionId);
    await this.deps.delay(80 + Math.round(Math.random() * 120));
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, this.sessionId);
    await this.deps.delay(40 + Math.round(Math.random() * 80));
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, this.sessionId);
  }

  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.deps.delay(120);
    await this.connection.send('Input.insertText', { text }, this.sessionId);
  }

  async extractDetail(): Promise<DetailExtraction> {
    return evaluate<DetailExtraction>(this.connection, this.sessionId, EXTRACT_DETAIL_SOURCE);
  }

  async fetchAsBase64(url: string): Promise<{ base64: string; mime: string } | null> {
    try {
      return await evaluate<{ base64: string; mime: string } | null>(
        this.connection, this.sessionId, FETCH_IMAGE_SOURCE(url), true,
      );
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.connection.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

export function createCdpOutreachPort1688(deps: CdpOutreachPortDeps): OutreachPort {
  return {
    async openOffer(offerUrl: string): Promise<OfferSession> {
      const connection = await deps.connection();
      const created = await connection.send<{ targetId?: string }>('Target.createTarget', {
        url: offerUrl,
        backgrounded: false,
      });
      const targetId = created.targetId;
      if (!targetId) throw new Error('E-OUTREACH-TAB-FAILED: 无法创建商品标签页');
      const attached = await connection.send<{ sessionId?: string }>('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = attached.sessionId ?? '';
      try {
        await connection.send('Page.enable', {}, sessionId);
      } catch (error) {
        await connection.send('Target.closeTarget', { targetId }).catch(() => {});
        throw error;
      }
      return new CdpOfferSession(connection, sessionId, targetId, deps);
    },
  };
}

/* ------------------------------ fixture 回放（e2e） ------------------------------ */

export interface FixtureOutreachOptions {
  /** 详情特征命中选择器集（缺省 = 校准写位点 + 会话窗全在场） */
  features?: Record<string, number>;
  detail?: Partial<DetailExtraction>;
  /** 点击后待核对的「成功态」选择器集（verify 语义；缺省 favoriteDoneState=inquirySentMark 在场） */
  afterClickFeatures?: Record<string, number>;
  /** 会话窗等待失败模拟（true = chat-window-missing 路径） */
  chatWindowMissing?: boolean;
}

export function createFixtureOutreachPort(options: FixtureOutreachOptions = {}): OutreachPort {
  const features = options.features ?? {
    '[class*="module-od-title"] h1': 1,
    '[data-click="FAV"]': 1,
    '[data-click="follow-shop"]': 1,
    '[data-click="咨询客服"]': 1,
    '[class*="chat-window"]': 1,
    '[class*="chat-input"] textarea': 1,
    '[class*="chat-send"]': 1,
  };
  const afterClick = options.afterClickFeatures ?? {
    '[class*="favor-done"]': 1,
    '[class*="msg-sent"]': 1,
  };
  // 会话窗缺失模拟：真实点击咨询客服后窗口未出现（待联调位点）→ chat-window-missing 路径
  if (options.chatWindowMissing) {
    features['[class*="chat-window"]'] = 0;
    features['[class*="chat-input"] textarea'] = 0;
    features['[class*="chat-send"]'] = 0;
  }
  return {
    async openOffer(offerUrl) {
      if (!/detail\.1688\.com\/offer\/\d+\.html|^file:/.test(offerUrl)) {
        throw new Error(`E-OUTREACH-FIXTURE-URL: fixture 端口只接受 offer/file URL: ${offerUrl.slice(0, 80)}`);
      }
      return {
        async waitForFeature(selector, minCount = 1) {
          if ((features[selector] ?? afterClick[selector] ?? 0) < minCount) {
            throw new Error(`E-OUTREACH-WAIT-TIMEOUT: fixture 缺特征 ${selector}`);
          }
        },
        async checkFeatures(selectors) {
          const merged = { ...features, ...afterClick };
          return Object.fromEntries(selectors.map((s) => [s, merged[s] ?? 0]));
        },
        async detectBlocked() {
          return null;
        },
        async click(selector) {
          if ((features[selector] ?? 0) < 1) throw new Error(`E-OUTREACH-CLICK-TARGET-MISSING: fixture 缺 ${selector}`);
        },
        async type(selector, text) {
          if ((features[selector] ?? 0) < 1) throw new Error(`E-OUTREACH-CLICK-TARGET-MISSING: fixture 缺 ${selector}`);
          if (!text) throw new Error('E-OUTREACH-FIXTURE-EMPTY-MESSAGE: fixture 拒绝空消息键入');
        },
        async extractDetail() {
          return {
            title: options.detail?.title ?? 'fixture 商品标题 冰丝防晒帽UPF50+',
            supplierName: options.detail?.supplierName ?? 'fixture供应商有限公司',
            priceText: options.detail?.priceText ?? '¥3.5',
            salesText: options.detail?.salesText ?? '3.4万+件',
            descText: options.detail?.descText ?? 'fixture 商品详情文案描述',
            gallerySrcs: options.detail?.gallerySrcs ?? [
              'https://cbu01.alicdn.com/img/ibank/fixture-a.jpg_.webp',
              'https://cbu01.alicdn.com/img/ibank/fixture-b.jpg_.webp',
            ],
          };
        },
        async fetchAsBase64(url) {
          return url.includes('cbu01.alicdn.com') ? { base64: 'Zml4dHVyZS1pbWFnZQ==', mime: 'image/jpeg' } : null;
        },
        async close() {},
      };
    },
  };
}

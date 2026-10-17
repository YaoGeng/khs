/**
 * 1688 选品检索端口（T-M2-03；SourcingSearchPort 的 CDP 真实实现）。
 *
 * 执行形态（与采集自动化共享同一受控浏览器实例，浏览器级让位门）：
 * - 每次检索开独立后台 tab（Target.createTarget → flat attach）→ canonical
 *   selloffer URL 直达（T-M2-01 取证：URL 直达最稳）→ 轮询提取卡片锚点 →
 *   Target.closeTarget 关 tab（不留痕、不占用户的 xhs 标签页）。
 * - 动作前置 gate（browserService.whenAutomationAllowed，浏览器级）——与采集
 *   自动化同一让位机制（FR-4.5）；检索是只读动作，不烧采集配额。
 *
 * 提取口径（2026-10-18 登录态实页取证，scripts/out/probe-1688-loggedin.json + probe-1688-loggedin.mjs）：
 * - 关键词编码：selloffer 端点默认按 GBK 解码 keywords——纯 UTF-8 encodeURIComponent 的
 *   URL 关键词会乱码返回无关结果（登录态下也发生，会被相关性防御剔除并误判未登录），
 *   URL 必带 `charset=utf8`（2026-10-18 b8842d1 修复）。
 * - 卡片 = 锚自身 `a.offerCard--<hash>`（CSS Modules 哈希类，一律前缀匹配容忍发版换哈希；
 *   旧口径 `[class*="offer-item"]` 实页 0 命中）；列表容器 offerList/gridCell 只做外层。
 * - title 取卡内 `[class*="titleText"]`（干净商品标题；旧口径 card.textContent 混入
 *   「找相似+公司名+服务分」整卡噪声——pilot-5 30 条样本即该缺陷产物）。
 * - price 取 priceSign+priceMain+priceSub 拼接（「¥2.8」主价块；纯价格不含数量，
 *   parsePriceRange 取全数字 min/max，混入「2~99顶」会污染区间）。阶梯价在 hover 面板
 *   （hoverPriceValue/hoverPriceQty），v1 不入候选快照（products.moq 留详情深读）。
 * - sales 取 descText 中以「件」结尾且含数字的文本（「3.4万+件」「全网2.9万+件」；
 *   同类名还有营销语「新人价」「包邮」与「100件起批」——后者不以待尾「件」命中被排除）。
 *   旧口径 `[class*="sales"]` 搜索卡 0 命中 → pilot-5 sales_text 全 null 的根因。
 * - supplier 取 shopRow 内 descText 的 title 属性（干净公司名；详情页 .company-name
 *   命中的是页尾推荐模块，勿用）。address 卡片层不存在 → null（详情深读补）。
 * - 登录墙/滑块（blockedFeatures 特征）命中即中止本轮并返回空——上层 agent 的
 *   推荐流防御 + stats.excludedJunk 提供「需登录」可观测信号，不自动重试（02:321）。
 */
import type { SourcingCandidate, SourcingSearchPort } from '@xinglian/agents';
import type { CdpConnection } from './cdp';
import { CdpProtocolError } from './cdp';

const SEARCH_URL = (keyword: string) =>
  `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}&charset=utf8`;

const POLL_INTERVAL_DEFAULT = 300;
const POLL_TIMEOUT_DEFAULT = 12_000;

export interface CdpSourcingPortDeps {
  /** 取浏览器级 CDP 连接（组合根注入：browserService 会话；须已接管浏览器） */
  readonly connection: () => Promise<CdpConnection>;
  /** 浏览器级让位门（与采集自动化同一入口） */
  readonly gate: () => Promise<void>;
  readonly delay: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  readonly logger?: { networkMeta?: (msg: string, payload?: unknown) => void };
}

/** 页面侧提取源（导出供单测以 stub 直评）：卡片级候选抽取。
 * 校准依据：2026-10-18 登录态真页取证（probe-1688-loggedin.mjs 三轮）——锚点结构见文件头。 */
export function extractOfferCardsSource(): string {
  return `(function () {
  var anchors = Array.prototype.slice.call(document.querySelectorAll('a[href*="detail.1688.com/offer"]'));
  var seen = {};
  var out = [];
  var clean = function (s) { return (s || '').replace(/\\s+/g, ' ').trim(); };
  for (var i = 0; i < anchors.length && out.length < 60; i += 1) {
    var a = anchors[i];
    var m = /offer\\/(\\d+)/.exec(a.getAttribute('href') || '');
    if (!m || seen[m[1]]) continue;
    seen[m[1]] = 1;
    var card = a.closest('[class*="offerCard"]') || a;
    var titleEl = card.querySelector('[class*="titleText"]');
    var title = clean(titleEl ? titleEl.textContent : '').slice(0, 160) || clean(card.textContent).slice(0, 160);
    var main = card.querySelector('[class*="priceMain"]');
    var sub = card.querySelector('[class*="priceSub"]');
    var priceText = main ? clean('¥' + clean(main.textContent) + clean(sub ? sub.textContent : '')).slice(0, 40) : null;
    var salesText = null;
    var descs = card.querySelectorAll('[class*="descText"]');
    for (var d = 0; d < descs.length; d += 1) {
      var t = clean(descs[d].textContent);
      if (/\\d[\\d.]*(万|w)?\\+?件$/.test(t)) { salesText = t.slice(0, 40); break; }
    }
    var supEl = card.querySelector('[class*="shopRow"] [class*="descText"]');
    var supplierName = supEl ? clean(supEl.getAttribute('title') || supEl.textContent).slice(0, 80) : null;
    out.push({
      offerId: m[1],
      title: title,
      priceText: priceText,
      salesText: salesText,
      supplierName: supplierName,
      supplierAddress: null,
      sourceUrl: 'https://detail.1688.com/offer/' + m[1] + '.html'
    });
  }
  return out;
})()`;
}

/** blockedFeatures 探测源：登录墙/滑块命中即放弃本轮（返回命中的特征名） */
export function detectBlockedSource(): string {
  return `(function () {
  var sels = ['.login-panel', '[class*="login-dialog"]', 'iframe[src*="login"]', '#nc_1_wrapper', '.nc-container', '[class*="punish"]', '#captcha'];
  for (var i = 0; i < sels.length; i += 1) {
    try { if (document.querySelectorAll(sels[i]).length > 0) return sels[i]; } catch (e) {}
  }
  return null;
})()`;
}

/** 页面表达式求值（returnByValue；异常详情收敛为短消息） */
async function evaluate<T>(connection: CdpConnection, sessionId: string, expression: string): Promise<T> {
  const result = await connection.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: false },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(`页面表达式执行失败: ${JSON.stringify(result.exceptionDetails).slice(0, 160)}`);
  }
  return result.result?.value as T;
}

/** 单次检索尝试（开后台 tab → canonical URL 直达 → 轮询提取 → 关 tab） */
async function searchOnce(
  connection: CdpConnection,
  keyword: string,
  limit: number,
  log: CdpSourcingPortDeps['logger'],
  timing: { interval: number; timeout: number; now: () => number; delay: (ms: number) => Promise<void> },
): Promise<SourcingCandidate[]> {
  const created = await connection.send<{ targetId?: string }>('Target.createTarget', { url: 'about:blank' });
  const targetId = created.targetId;
  if (!targetId) throw new Error('E-SOURCING-TAB-FAILED: 无法创建检索标签页');
  const attached = await connection.send<{ sessionId?: string }>('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.sessionId ?? '';
  try {
    await connection.send('Page.enable', {}, sessionId);
    await connection.send('Page.navigate', { url: SEARCH_URL(keyword) }, sessionId);
    const deadline = timing.now() + timing.timeout;
    for (;;) {
      let blocked: string | null = null;
      try {
        blocked = await evaluate<string | null>(connection, sessionId, detectBlockedSource());
      } catch { /* 跳转中重试 */ }
      if (blocked) {
        log?.networkMeta?.('sourcing:blocked-feature', { keyword, feature: blocked, action: 'abort-empty（不自动重试，02:321）' });
        return [];
      }
      let cards: SourcingCandidate[] = [];
      try {
        cards = await evaluate<SourcingCandidate[]>(connection, sessionId, extractOfferCardsSource());
      } catch { /* 跳转中重试 */ }
      if (cards.length > 0 || timing.now() + timing.interval > deadline) {
        const sliced = cards.slice(0, limit);
        log?.networkMeta?.('sourcing:cards-extracted', { keyword, raw: cards.length, kept: sliced.length });
        return sliced;
      }
      await timing.delay(timing.interval);
    }
  } finally {
    await connection.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

export function createCdpSourcingPort1688(deps: CdpSourcingPortDeps): SourcingSearchPort {
  const interval = deps.pollIntervalMs ?? POLL_INTERVAL_DEFAULT;
  const timeout = deps.pollTimeoutMs ?? POLL_TIMEOUT_DEFAULT;
  const now = deps.now ?? (() => Date.now());

  return {
    /**
     * 端口级重试（2026-10-18 登录态首跑取证）：长活浏览器上新开 tab 会话的
     * Page.enable 偶发响应超时（首轮验收两次任务各挂在第 1/第 3 个关键词，
     * 工作流级重试要整步重来浪费已取得的词）。瞬态 CDP 错误在此重试，
     * 登录墙/空结果等业务口径不重试。
     */
    async search(keyword, limit): Promise<SourcingCandidate[]> {
      await deps.gate();
      const maxAttempts = 3;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          // deps.connection()（= prepareAutomationTab，内含平台页会话的 Page.enable）
          // 与 searchOnce 一样会抛瞬态 CdpProtocolError，必须同在重试环内
          //（2026-10-18 第三轮首跑取证：kw1-3 全成功，kw4 挂在 connection() 的 Page.enable）。
          const connection = await deps.connection();
          return await searchOnce(connection, keyword, limit, deps.logger, { interval, timeout, now, delay: deps.delay });
        } catch (error) {
          lastError = error;
          if (!(error instanceof CdpProtocolError) || attempt >= maxAttempts) throw error;
          deps.logger?.networkMeta?.('sourcing:search-retry', {
            keyword,
            attempt,
            error: String((error as Error).message).slice(0, 100),
          });
          await deps.delay(1_500);
        }
      }
      throw lastError;
    },
  };
}

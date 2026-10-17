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
 * 提取口径（2026-10-16 匿名真页取证，scripts/out/probe-1688.json）：
 * - 锚点 `a[href*="detail.1688.com/offer"]` 三轮稳定命中（15/15/60）；offerId 取
 *   href 内 /offer/<id> 段；title 取锚点祖先卡片（[class*="offer-item"] 优先，缺省
 *   锚点自身 textContent）——真实结果卡锚文本必含商品标题（含公司名等噪声，
 *   agent 的 bigram 相关性对噪声鲁棒；推荐流卡片则零重叠被剔除）。
 * - 关键词编码（2026-10-18 登录态实页取证）：selloffer 端点默认按 **GBK** 解码
 *   keywords 参数——纯 UTF-8 encodeURIComponent 的 URL 关键词会变乱码（页面标题
 *   「閻叉檼甯」），返回与查询词无关的杂货结果（登录态下也会发生，会被相关性
 *   防御整体剔除并误判为未登录）。必须追加 `charset=utf8`（真页验证：标题正确
 *   「防晒帽_防晒帽批发」、结果全为关键词命中）。
 * - priceText/salesText 取卡片内首个 [class*="price"] / [class*="sales"] 文本
 *   （取证命中 69/297 与 12 个）；supplier/gallery 卡片层不可得 → null（agent 按
 *   「无信息」维度口径计分）——详情深读留登录联调卡（T-M2-03b 校准 offerTitle）。
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

/** 页面侧提取源（导出供单测以 stub 直评）：卡片级候选抽取 */
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
    var card = a.closest('[class*="offer-item"]') || a.parentElement;
    if (!card) continue;
    var priceEl = card.querySelector('[class*="price"]');
    var salesEl = card.querySelector('[class*="sales"]');
    out.push({
      offerId: m[1],
      title: clean(card.textContent).slice(0, 160) || clean(a.textContent).slice(0, 160),
      priceText: priceEl ? clean(priceEl.textContent).slice(0, 40) : null,
      salesText: salesEl ? clean(salesEl.textContent).slice(0, 40) : null,
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
      const connection = await deps.connection();
      const maxAttempts = 3;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
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

/**
 * SourcingSearchPort 官方 API 实现 + 传输路由器（T-M2-05a）。
 *
 * - **API 实现**：searchoffer → SourcingCandidate。salesText 取 stats.last30DaysSales
 *   的文本形态（近 30 天 ≈ 月销口径，selection-agent 的 parseMonthlySales 可直读）；
 *   API 检索无供应商字段 → supplierName=null（selection-agent 的供应商维度按既有
 *   「无供应商」口径计分）；galleryCount 不知 → null（与 CDP 检索同口径）。
 * - **路由器**（组合根注入）：每次 search 现读 AK——已配置走官方 API，未配置回落
 *   CDP 浏览器检索。**不做静默回落**：API 配置后出错原样抛（auth/param 属配置问题、
 *   network/service 属通道问题，一律可观测），用户清除 AK 即回到浏览器通道；每次
 *   选择的传输落日志（sourcing:transport）。
 */
import type { SourcingCandidate, SourcingSearchPort } from '@xinglian/agents';
import { searchOffers1688, type AkParts, type FetchLike } from '@xinglian/adapters-1688';

/**
 * API stats 原始记录 → 候选 stats 归一化（T-M2-05b）。
 * 实测形状（2026-10-18 真 AK 探针）：repurchaseRate="0.19…"（小数字符串）、
 * goodRates=100（0-100 数值）、downstreamOffer="298"、last30DaysSales="100+"；
 * 缺失/垃圾值 → null（复购维按无数据中性计，不臆造）。
 */
function normalizeStats(stats: Record<string, unknown> | null): SourcingCandidate['stats'] {
  if (!stats) return null;
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const m = /(\d+(?:\.\d+)?)/.exec(v);
      if (m) return Number(m[1]);
    }
    return null;
  };
  const repurchaseRate = num(stats.repurchaseRate);
  return {
    repurchaseRate: repurchaseRate !== null && repurchaseRate >= 0 && repurchaseRate <= 1 ? repurchaseRate : null,
    goodRates: num(stats.goodRates),
    downstreamOffer: num(stats.downstreamOffer),
    last30DaysSales: num(stats.last30DaysSales),
  };
}

export function createApiSourcingPort1688(deps: {
  fetchImpl: FetchLike;
  /** 每次调用现取（组合根闭包 akStore.get；secret 不出主进程） */
  ak: () => Promise<AkParts | null>;
  logger?: { networkMeta?: (msg: string, payload?: unknown) => void };
}): SourcingSearchPort {
  return {
    async search(keyword, limit): Promise<SourcingCandidate[]> {
      const ak = await deps.ak();
      if (!ak) throw new Error('E-SOURCING-AK-MISSING: 官方 API 检索需要先配置 AK');
      const items = await searchOffers1688({ fetchImpl: deps.fetchImpl, ak, query: keyword });
      const candidates: SourcingCandidate[] = items.map((item) => ({
        offerId: item.offerId,
        title: item.title,
        priceText: item.priceText.length > 0 ? item.priceText : null,
        salesText: item.salesText,
        supplierName: null,
        supplierAddress: null,
        galleryCount: null,
        sourceUrl: `https://detail.1688.com/offer/${item.offerId}.html`,
        stats: normalizeStats(item.stats),
      }));
      deps.logger?.networkMeta?.('sourcing:api-search', {
        keyword,
        raw: items.length,
        kept: Math.min(candidates.length, limit),
      });
      return candidates.slice(0, limit);
    },
  };
}

export function createRoutedSearchPort(deps: {
  getAk: () => Promise<AkParts | null>;
  fetchImpl: FetchLike;
  cdpPort: SourcingSearchPort;
  logger?: { networkMeta?: (msg: string, payload?: unknown) => void };
}): SourcingSearchPort {
  return {
    async search(keyword, limit): Promise<SourcingCandidate[]> {
      const ak = await deps.getAk();
      if (ak) {
        deps.logger?.networkMeta?.('sourcing:transport', { keyword, transport: 'api' });
        const apiPort = createApiSourcingPort1688({ fetchImpl: deps.fetchImpl, ak: async () => ak, logger: deps.logger });
        return apiPort.search(keyword, limit);
      }
      deps.logger?.networkMeta?.('sourcing:transport', { keyword, transport: 'browser-cdp' });
      return deps.cdpPort.search(keyword, limit);
    },
  };
}

/** sourcing-api-port 单测：API 映射 + 路由器（fetch/CDP 端口全注入桩） */
import { describe, expect, it } from 'vitest';
import type { SourcingCandidate, SourcingSearchPort } from '@xinglian/agents';
import { createApiSourcingPort1688, createRoutedSearchPort } from './sourcing-api-port';
import type { FetchLike } from '@xinglian/adapters-1688';

const AK = { accessKeyId: 'AKID12345', accessKeySecret: 'S'.repeat(32) };

function fetchWith(payload: unknown): { fetchImpl: FetchLike; count: () => number } {
  const state = { calls: 0 };
  const fetchImpl: FetchLike = async () => {
    state.calls += 1;
    return { status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetchImpl, count: () => state.calls };
}

describe('createApiSourcingPort1688', () => {
  it('searchoffer → SourcingCandidate 映射 + limit 切片', async () => {
    const { fetchImpl, count } = fetchWith({
      success: true,
      model: { data: {
        '111': { title: 'A 商品', price: '3.5', stats: { last30DaysSales: 8500 } },
        '222': { title: 'B 商品', price: '' },
      } },
    });
    const port = createApiSourcingPort1688({ fetchImpl, ak: async () => AK });
    const candidates = await port.search('收纳', 1);
    expect(candidates).toHaveLength(1);
    const first: SourcingCandidate = candidates[0];
    expect(first).toMatchObject({
      offerId: '111',
      title: 'A 商品',
      priceText: '3.5',
      salesText: '8500件',
      supplierName: null,
      sourceUrl: 'https://detail.1688.com/offer/111.html',
    });
    expect(count()).toBe(1);
  });

  it('AK 缺失 → E-SOURCING-AK-MISSING（不发请求）', async () => {
    const { fetchImpl, count } = fetchWith({ success: true, model: { data: {} } });
    const port = createApiSourcingPort1688({ fetchImpl, ak: async () => null });
    await expect(port.search('x', 5)).rejects.toMatchObject({
      message: expect.stringContaining('E-SOURCING-AK-MISSING'),
    });
    expect(count()).toBe(0);
  });

  it('stats 归一化（T-M2-05b）：字符串数值提取 + 越界归 null（真 AK 实测形状）', async () => {
    const { fetchImpl } = fetchWith({
      success: true,
      model: { data: {
        // 2026-10-18 探针实测形态：repurchaseRate 小数字符串 / goodRates 0-100 数值 /
        // downstreamOffer 数字字符串 / last30DaysSales "N+"
        'a': { title: 'x', price: '1', stats: { repurchaseRate: '0.1918238993710692', goodRates: 100, downstreamOffer: '298', last30DaysSales: '100+' } },
        'b': { title: 'y', price: '1', stats: { repurchaseRate: 1.5, goodRates: '垃圾', downstreamOffer: '', last30DaysSales: null } },
        'c': { title: 'z', price: '1', stats: null },
      } },
    });
    const port = createApiSourcingPort1688({ fetchImpl, ak: async () => AK });
    const items = await port.search('kw', 10);
    expect(items[0].stats).toEqual({ repurchaseRate: 0.1918238993710692, goodRates: 100, downstreamOffer: 298, last30DaysSales: 100 });
    // repurchaseRate 越界（>1）→ null（复购维走无数据中性）；垃圾字符串提取不出 → null
    expect(items[1].stats).toEqual({ repurchaseRate: null, goodRates: null, downstreamOffer: null, last30DaysSales: null });
    expect(items[2].stats).toBeNull();
  });
});

describe('createRoutedSearchPort（AK 有走 API、无走 CDP；不静默回落）', () => {
  const apiPayload = { success: true, model: { data: { '999': { title: 'API 商品', price: '1' } } } };

  it('AK 已配置 → API 通道（CDP 桩不得被调用）', async () => {
    const { fetchImpl, count } = fetchWith(apiPayload);
    let cdpCalls = 0;
    const cdpPort: SourcingSearchPort = { search: async () => { cdpCalls += 1; return []; } };
    const logs: unknown[] = [];
    const port = createRoutedSearchPort({
      getAk: async () => AK,
      fetchImpl,
      cdpPort,
      logger: { networkMeta: (msg, payload) => logs.push([msg, payload]) },
    });
    const candidates = await port.search('kw', 10);
    expect(candidates[0]?.offerId).toBe('999');
    expect(count()).toBe(1);
    expect(cdpCalls).toBe(0);
    expect(logs).toContainEqual(['sourcing:transport', { keyword: 'kw', transport: 'api' }]);
  });

  it('AK 未配置 → CDP 通道（不发网络请求）', async () => {
    const { fetchImpl, count } = fetchWith(apiPayload);
    const cdpPort: SourcingSearchPort = { search: async (kw) => [{ offerId: '1', title: kw }] };
    const port = createRoutedSearchPort({ getAk: async () => null, fetchImpl, cdpPort });
    const candidates = await port.search('kw', 10);
    expect(candidates[0]?.title).toBe('kw');
    expect(count()).toBe(0);
  });

  it('API 出错原样抛（不回落 CDP）', async () => {
    const failingFetch: FetchLike = async () => ({ status: 401, text: async () => 'unauthorized' });
    let cdpCalls = 0;
    const cdpPort: SourcingSearchPort = { search: async () => { cdpCalls += 1; return []; } };
    const port = createRoutedSearchPort({ getAk: async () => AK, fetchImpl: failingFetch, cdpPort });
    await expect(port.search('kw', 10)).rejects.toMatchObject({ kind: 'auth' });
    expect(cdpCalls).toBe(0);
  });
});

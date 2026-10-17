/**
 * sourcing-port 提取源回归（T-M2-04 前置校准，2026-10-18 登录态真页取证）：
 * extractOfferCardsSource 产出的页面 JS 在真实 DOM 形态上回放——
 *   ① title 取 titleText（旧口径 card.textContent 整卡噪声：找相似/公司名/服务分）；
 *   ② price = priceSign+priceMain+priceSub 纯主价块（不掺「2~99顶」数量，保
 *      parsePriceRange 语义）；
 *   ③ sales = descText 中以「件」结尾的文本（排除「新人价」「包邮」「100件起批」）；
 *   ④ supplier = shopRow descText 的 title 属性；
 *   ⑤ 同卡去重 + canonical sourceUrl。
 * 页面源码以 eval 在 linkedom document 上执行（与真实页同 API 面）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { extractOfferCardsSource } from './sourcing-port.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 用 adapters-1688 的 search fixture（= 真页取证形态的最小复刻）回放页面 JS */
function replay(fixture: string): Array<Record<string, unknown>> {
  const html = readFileSync(`${PACKAGE_ROOT}packages/adapters-1688/${fixture}`, 'utf8');
  const { document } = parseHTML(html);
  const window = { document };
  // 页面源是无模块 IIFE 表达式，returnByValue 语义 = eval 取值
  const src = extractOfferCardsSource();
  return new Function('document', `return ${src}`)(window.document) as Array<Record<string, unknown>>;
}

describe('sourcing-port 提取源（2026-10-18 登录态校准）', () => {
  const cards = replay('fixtures/search.html');

  it('卡片按 offer 锚抽取，同卡去重', () => {
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.offerId)).toEqual(['880000000001', '880000000002']);
  });

  it('title 取 titleText 干净标题（不含公司名/找相似/服务分噪声）', () => {
    expect(cards[0].title).toBe('冰丝防晒帽女夏季UPF50+渔夫帽大头围');
    expect(cards[1].title).toBe('防晒帽男透气薄款空顶帽户外遮阳');
    for (const c of cards) {
      expect(String(c.title)).not.toContain('找相似');
      expect(String(c.title)).not.toContain('有限公司');
    }
  });

  it('price 为纯主价块（parsePriceRange 语义：不掺数量区间数字）', () => {
    expect(cards[0].priceText).toBe('¥3.5');
    expect(cards[1].priceText).toBe('¥2.8');
  });

  it('sales 取以「件」结尾的 descText（排除营销语与起批量）', () => {
    expect(cards[0].salesText).toBe('3.4万+件');
    expect(cards[1].salesText).toBe('1.0万+件');
  });

  it('supplier 取 shopRow 内 title 属性公司名', () => {
    expect(cards[0].supplierName).toBe('台州市椒江顺新鞋帽厂');
    expect(cards[1].supplierName).toBe('义乌市沐原服装有限公司');
  });

  it('sourceUrl 为 canonical 详情页链接（M2 门禁：卡片含原始链接）', () => {
    expect(cards[0].sourceUrl).toBe('https://detail.1688.com/offer/880000000001.html');
  });

  it('与 agents 侧解析器联动：priceText/salesText 可被确定性解析（回归 pilot-5 双 null 缺陷）', async () => {
    const { parsePriceRange, parseMonthlySales } = await import('@xinglian/agents');
    const price = parsePriceRange(cards[0].priceText as string);
    expect(price).toEqual({ min: 3.5, max: 3.5 });
    expect(parseMonthlySales(cards[0].salesText as string)).toBe(34_000);
    expect(parseMonthlySales(cards[1].salesText as string)).toBe(10_000);
  });
});

import { describe, expect, it } from 'vitest';
import {
  SELECTION_DIMENSIONS,
  generateSelection,
  parseMonthlySales,
  parsePriceRange,
  type SourcingCandidate,
  type SourcingSearchPort,
} from './selection-agent.js';

/* ------------------------------ 确定性解析器 ------------------------------ */

describe('parsePriceRange / parseMonthlySales（确定性解析）', () => {
  it('价格：单值 / 区间 / 带起批量后缀 / 无效输入', () => {
    expect(parsePriceRange('¥8.50')).toEqual({ min: 8.5, max: 8.5 });
    expect(parsePriceRange('8.50 ~ 12.00')).toEqual({ min: 8.5, max: 12 });
    // 「¥3.30≥2支」：起批量 2 支不是价格；取最小/最大数字 → 3.3/3.3
    expect(parsePriceRange('¥3.30≥2支')).toEqual({ min: 2, max: 3.3 });
    expect(parsePriceRange('面议')).toBeNull();
    expect(parsePriceRange(null)).toBeNull();
    expect(parsePriceRange('')).toBeNull();
  });

  it('销量：月销/已售/万单位/无匹配', () => {
    expect(parseMonthlySales('月销1000+')).toBe(1000);
    expect(parseMonthlySales('已售10万+')).toBe(100_000);
    expect(parseMonthlySales('销量3.5万+')).toBe(35_000);
    expect(parseMonthlySales('成交2千+笔')).toBe(2_000);
    expect(parseMonthlySales('新品')).toBeNull();
    expect(parseMonthlySales(null)).toBeNull();
  });
});

/* ------------------------------ 编排与评分 ------------------------------ */

/** 造候选的简写（默认给足字段，测试里按需覆盖） */
function cand(offerId: string, title: string, over: Partial<SourcingCandidate> = {}): SourcingCandidate {
  return {
    offerId,
    title,
    priceText: '¥10.00',
    salesText: '月销100+',
    supplierName: '义乌市某某服饰有限公司',
    supplierAddress: '浙江 金华 义乌市',
    galleryCount: 5,
    sourceUrl: `https://detail.1688.com/offer/${offerId}.html`,
    ...over,
  };
}

/** 假检索端口：关键词 → 固定候选集（确定性） */
function fakePort(byKeyword: Record<string, SourcingCandidate[]>): SourcingSearchPort {
  return {
    async search(keyword, limit) {
      return (byKeyword[keyword] ?? []).slice(0, limit);
    },
  };
}

describe('generateSelection（选品 Agent v1）', () => {
  it('五维齐备 + 加权总分：维度名/权重与 SELECTION_DIMENSIONS 一致，理由为中文', async () => {
    const result = await generateSelection(
      { keywords: [{ term: '冰丝防晒衣' }] },
      { search: fakePort({ 冰丝防晒衣: [cand('8801', '冰丝防晒衣女夏季UPF50+')] }) },
    );
    expect(result.top).toHaveLength(1);
    const dims = result.top[0].dimensions;
    expect(dims.map((d) => d.name)).toEqual(['relevance', 'price', 'sales', 'supplier', 'gallery']);
    for (const d of dims) {
      expect(d.weight).toBe(SELECTION_DIMENSIONS[d.name].weight);
      expect(d.reason.length).toBeGreaterThan(2);
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(100);
    }
    const total = dims.reduce((s, d) => s + d.score * d.weight, 0);
    expect(result.top[0].total).toBeCloseTo(Math.round(total * 100) / 100, 2);
  });

  it('推荐流防御：标题与关键词零重叠的候选整条剔除（入 excludedJunk 统计，不入 Top）', async () => {
    const result = await generateSelection(
      { keywords: [{ term: '冰丝防晒衣' }] },
      {
        search: fakePort({
          冰丝防晒衣: [
            cand('8801', '冰丝防晒衣女夏季UPF50+'),
            cand('junk1', '手持松土两齿叉种花种菜专用工具'),
            cand('junk2', '不锈钢豆芽叉子米漏套装'),
          ],
        }),
      },
    );
    expect(result.top.map((t) => t.offerId)).toEqual(['8801']);
    expect(result.stats.keywords[0]).toMatchObject({ candidates: 3, retained: 1, excludedJunk: 2 });
    expect(result.stats.totalScored).toBe(1);
  });

  it('相关性分档：完整含词 100 > 部分命中（bigram 折算）> 零重叠剔除', async () => {
    const result = await generateSelection(
      { keywords: [{ term: '防晒冰袖' }] },
      {
        search: fakePort({
          防晒冰袖: [
            cand('full', '防晒冰袖男女夏季透气'),
            cand('part', '夏季冰袖胳膊套防晒防紫外线'),
          ],
        }),
      },
    );
    const full = result.top.find((t) => t.offerId === 'full');
    const part = result.top.find((t) => t.offerId === 'part');
    expect(full?.dimensions[0].score).toBe(100);
    expect(part!.dimensions[0].score).toBeGreaterThan(0);
    expect(part!.dimensions[0].score).toBeLessThan(100);
  });

  it('价格分位 inverted：同词队列内最低价得分最高；无价格 → 40「无价格信号」', async () => {
    const result = await generateSelection(
      { keywords: [{ term: '防晒帽' }] },
      {
        search: fakePort({
          防晒帽: [
            cand('cheap', '防晒帽男女款', { priceText: '¥5.00' }),
            cand('mid', '防晒帽大檐', { priceText: '¥12.00' }),
            cand('exp', '防晒帽折叠', { priceText: '¥30.00' }),
            cand('noprice', '防晒帽空顶', { priceText: null }),
          ],
        }),
      },
    );
    const dim = (id: string) => result.top.find((t) => t.offerId === id)!.dimensions[1];
    expect(dim('cheap').score).toBe(100);
    expect(dim('exp').score).toBe(30);
    expect(dim('noprice').score).toBe(40);
    expect(dim('noprice').reason).toContain('无价格');
  });

  it('销量分位：同词队列内高销量高分；无销量 → 25', async () => {
    const result = await generateSelection(
      { keywords: [{ term: '防晒裙' }] },
      {
        search: fakePort({
          防晒裙: [
            cand('hot', '防晒裙夏季薄款', { salesText: '已售10万+' }),
            cand('cold', '防晒裙长款', { salesText: '月销3+' }),
            cand('nosales', '防晒裙通勤', { salesText: null }),
          ],
        }),
      },
    );
    const dim = (id: string) => result.top.find((t) => t.offerId === id)!.dimensions[2];
    expect(dim('hot').score).toBe(100);
    expect(dim('cold').score).toBe(30);
    expect(dim('nosales').score).toBe(25);
  });

  it('供应商资质：厂 > 有限公司 > 个体；双信息 > 单信息 > 无信息', async () => {
    const result = await generateSelection(
      { keywords: [{ term: '防晒衣' }] },
      {
        search: fakePort({
          防晒衣: [
            cand('fac', '防晒衣工厂直销', { supplierName: '东莞市某某服饰厂', supplierAddress: '广东 东莞市' }),
            cand('ltd', '防晒衣现货批发', { supplierName: '义乌市某某服饰有限公司' }),
            cand('solo', '防晒衣低价', { supplierName: '某某经营部' }),
            cand('none', '防晒衣新款', { supplierName: null, supplierAddress: null }),
          ],
        }),
      },
    );
    const dim = (id: string) => result.top.find((t) => t.offerId === id)!.dimensions[3];
    expect(dim('fac').score).toBe(85);
    expect(dim('ltd').score).toBe(80);
    expect(dim('solo').score).toBeLessThan(dim('ltd').score);
    expect(dim('none').score).toBe(10);
  });

  it('跨词去重：同一 offerId 归属首次出现的关键词，计入 dedupedAcrossKeywords', async () => {
    const shared = cand('dup1', '冰丝防晒衣女UPF50+含防晒帽赠品');
    const result = await generateSelection(
      { keywords: [{ term: '冰丝防晒衣' }, { term: '防晒帽' }] },
      {
        search: fakePort({
          冰丝防晒衣: [shared, cand('only1', '冰丝防晒衣男款')],
          防晒帽: [cand('dup1', '防晒帽'), cand('only2', '防晒帽空顶大檐')],
        }),
      },
    );
    expect(result.stats.dedupedAcrossKeywords).toBe(1);
    const dup = result.top.find((t) => t.offerId === 'dup1');
    // 首现词归属（冰丝防晒衣先检索）；标题按归属词计相关性
    expect(dup?.keyword).toBe('冰丝防晒衣');
    expect(dup?.dimensions[0].score).toBe(100);
    expect(result.stats.keywords[1].candidates).toBe(2);
  });

  it('TopN 截断 + 排序：总分降序，rank 从 1 起；并列按 offerId 稳定定序', async () => {
    const pool = Array.from({ length: 40 }, (_, i) =>
      cand(`o${String(i).padStart(3, '0')}`, `冰丝防晒衣款型${i}`),
    );
    // perKeywordLimit 放宽到 40+：让 TopN 成为唯一截断约束（默认 30 会先截队列）
    const result = await generateSelection(
      { keywords: [{ term: '冰丝防晒衣' }], topN: 30, perKeywordLimit: 40 },
      { search: fakePort({ 冰丝防晒衣: pool }) },
    );
    expect(result.top).toHaveLength(30);
    expect(result.top[0].rank).toBe(1);
    for (let i = 1; i < result.top.length; i += 1) {
      const prev = result.top[i - 1];
      const cur = result.top[i];
      expect(prev.total).toBeGreaterThanOrEqual(cur.total);
      if (prev.total === cur.total) expect(prev.offerId < cur.offerId).toBe(true);
    }
    expect(result.stats.totalScored).toBe(40);
  });

  it('确定性：同输入两次运行结果 deep-equal（selectionId/时间戳外）', async () => {
    const pool = [
      cand('a1', '冰丝防晒衣女款', { priceText: '¥8.00', salesText: '月销500+' }),
      cand('b2', '冰丝防晒衣男款', { priceText: '¥15.00', salesText: '已售2万+' }),
      cand('c3', '冰丝防晒衣儿童', { priceText: '¥12.00', galleryCount: 2 }),
    ];
    const input = { keywords: [{ term: '冰丝防晒衣' }], topN: 2 };
    const run = () =>
      generateSelection(input, { search: fakePort({ 冰丝防晒衣: pool }), now: () => new Date('2026-10-16T00:00:00Z') });
    const r1 = await run();
    const r2 = await run();
    // selectionId 是每次运行的 UUID，确定性对比剔除之；其余字段（含排序/分值/理由）必须逐位相等
    const { selectionId: _id1, ...rest1 } = r1;
    const { selectionId: _id2, ...rest2 } = r2;
    expect(rest1).toEqual(rest2);
  });

  it('空输入/空结果口径：零关键词抛错；端口空返回 → 空 Top + 统计归零', async () => {
    await expect(generateSelection({ keywords: [] }, { search: fakePort({}) })).rejects.toThrow(/E-SELECTION-NO-KEYWORD/);
    const empty = await generateSelection({ keywords: [{ term: '无结果词' }] }, { search: fakePort({}) });
    expect(empty.top).toEqual([]);
    expect(empty.stats.keywords[0]).toMatchObject({ candidates: 0, retained: 0, excludedJunk: 0 });
  });
});

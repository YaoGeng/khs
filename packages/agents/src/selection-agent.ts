/**
 * selection-agent v1（T-M2-02，05 M2：报告关键词 → 1688 候选 → 确定性评分 → Top30）。
 *
 * 边界与口径：
 * - **确定性评分，无 LLM**（任务卡原文「确定性评分（维度分+理由）」）：同输入恒同输出，
 *   五维加权（相关性/价格/销量/供应商/素材），每维 0~100 + 中文理由，权重常量可审计。
 * - **检索经注入 Port**（SourcingSearchPort）：本包不持有浏览器/CDP——执行侧由组合根
 *   注入（真实实现 = CdpAutomation + adapters-1688 DSL，随 selection-service 卡接线；
 *   单测/fixture 注入假实现）。Agent 只负责编排：多词扇出 → 跨词去重 → 分词队列评分
 *   → 推荐流防御 → Top30。
 * - **推荐流防御（2026-10-16 取证）**：1688 匿名检索返回与关键词无关的推荐卡片——
 *   相关性维度按标题/关键词覆盖绝对计分，0 分候选整条剔除（不入 Top 池、计入统计），
 *   不依赖站点是否登录。
 * - 合规口径：Agent 产出永不直接执行（02:394 同款红线）——无收藏/询盘/下单出口；
 *   Top30 只是建议清单，执行链归 T-M2-04（含人工确认弹窗）。
 */
import { randomUUID } from 'node:crypto';

/* ------------------------------ 原始候选与解析 ------------------------------ */

/** 检索层产出的原始候选（字段即 adapters-1688 detail DSL 六位点的直读形状） */
export interface SourcingCandidate {
  offerId: string;
  title: string;
  /** 价格文本原样（如「¥8.50」「8.50 ~ 12.00」「¥3.30≥2支」）；解析交给 parsePriceRange */
  priceText?: string | null;
  /** 销量文本原样（如「月销1000+」「已售10万+」）；解析交给 parseMonthlySales */
  salesText?: string | null;
  supplierName?: string | null;
  supplierAddress?: string | null;
  galleryCount?: number | null;
  sourceUrl?: string | null;
}

/** 检索端口：单关键词 → 原始候选（真实实现 = CDP + adapters-1688；测试注入假实现） */
export interface SourcingSearchPort {
  search(keyword: string, limit: number): Promise<SourcingCandidate[]>;
}

export interface PriceRange {
  min: number;
  max: number;
}

/** 价格区间解析（确定性）：取文本中最小的两个数字为 min/max（单数字则 min=max）。
 *  「¥8.50」→ 8.5/8.5；「8.50 ~ 12.00」→ 8.5/12；「¥3.30≥2支」→ 3.3/3.3（起批量不进价格）。
 *  无数字/解析失败 → null（上层按「无价格」维度口径计分，不臆造）。 */
export function parsePriceRange(text: string | null | undefined): PriceRange | null {
  if (!text) return null;
  const nums = Array.from(text.matchAll(/(\d+(?:\.\d+)?)/g), (m) => Number(m[1])).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  return { min: sorted[0], max: sorted[sorted.length - 1] };
}

/** 月销量解析（确定性）：「月销1000+」「已售10万+」「成交30+笔」→ 数值；支持万/千单位。
 *  无匹配 → null。 */
export function parseMonthlySales(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /(\d+(?:\.\d+)?)(万|w|k|千)?/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  const mult = unit === '万' || unit === 'w' ? 10_000 : unit === 'k' || unit === '千' ? 1_000 : 1;
  return Math.round(n * mult);
}

/* ------------------------------ 评分维度 ------------------------------ */

export const SELECTION_DIMENSIONS = {
  relevance: { weight: 0.3, title: '关键词相关性' },
  price: { weight: 0.2, title: '价格竞争力' },
  sales: { weight: 0.2, title: '销量信号' },
  supplier: { weight: 0.15, title: '供应商资质' },
  gallery: { weight: 0.15, title: '素材完备度' },
} as const;

export interface DimensionScore {
  name: keyof typeof SELECTION_DIMENSIONS;
  title: string;
  score: number;
  weight: number;
  reason: string;
}

/** 内部评分载体：候选 + 归属关键词 + 维度分与总分 */
interface Scored {
  offerId: string;
  keyword: string;
  candidate: SourcingCandidate;
  dimensions: DimensionScore[];
  total: number;
}

/** 相关性（绝对计分，推荐流防御的唯一闸）：标题完整含词 → 100；否则按关键词
 *  二元词组（bigram）覆盖率线性折算；零覆盖 → 0（整条剔除）。 */
function scoreRelevance(title: string, keyword: string): { score: number; reason: string } {
  if (keyword.length <= 1) {
    const hit = title.includes(keyword);
    return hit
      ? { score: 100, reason: `标题完整含词「${keyword}」` }
      : { score: 0, reason: '标题不含关键词（疑似推荐流卡片）' };
  }
  if (title.includes(keyword)) return { score: 100, reason: `标题完整含词「${keyword}」` };
  const bigrams: string[] = [];
  for (let i = 0; i < keyword.length - 1; i += 1) bigrams.push(keyword.slice(i, i + 2));
  const hits = bigrams.filter((bg) => title.includes(bg)).length;
  if (hits === 0) return { score: 0, reason: '标题与关键词无重叠（疑似推荐流卡片）' };
  const score = Math.round((hits / bigrams.length) * 70);
  return { score, reason: `标题部分命中（${hits}/${bigrams.length} 词组）` };
}

/** 同词队列内分位计分通用器：ascending=值越高分越高（销量）；inverted=值越低分越高
 *  （价格）。队列仅 1 条 → 中性 60（无对照不下结论）；并列值稳定同分。区间 [30,100]。 */
function percentileScore(
  values: Array<{ key: string; value: number }>,
  key: string,
  opts: { inverted: boolean },
): { score: number; reason: string } {
  if (values.length <= 1) return { score: 60, reason: '同词无对照（中性分）' };
  const me = values.find((v) => v.key === key);
  if (!me) return { score: 60, reason: '同词无对照（中性分）' };
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const rank = sorted.findIndex((v) => v.key === key);
  const pct = rank / (sorted.length - 1); // 0..1（升序位次）
  const score = Math.round(opts.inverted ? 100 - pct * 70 : 30 + pct * 70);
  return { score, reason: opts.inverted ? '同词队列内价格分位（越低越优）' : '同词队列内数值分位' };
}

/** 供应商资质：信息完备度（名称+地址）为主体分，主体类型加成（厂 > 有限公司 > 个体）。 */
function scoreSupplier(candidate: SourcingCandidate): { score: number; reason: string } {
  const name = candidate.supplierName ?? '';
  const address = candidate.supplierAddress ?? '';
  let base: number;
  let reason: string;
  if (name && address) {
    base = 70;
    reason = '供应商名称与地址完备';
  } else if (name || address) {
    base = 45;
    reason = name ? '仅供应商名称（缺地址）' : '仅地址（缺供应商名称）';
  } else {
    return { score: 10, reason: '无供应商信息' };
  }
  let bonus = 0;
  let type = '未识别主体类型';
  if (/厂$|厂（|厂\(/.test(name)) {
    bonus = 15;
    type = '工厂主体';
  } else if (name.includes('有限公司')) {
    bonus = 10;
    type = '公司主体';
  } else if (/经营部|商行|门市|工作室/.test(name)) {
    bonus = 0;
    type = '个体经营';
  }
  return { score: Math.min(100, base + bonus), reason: `${reason}；${type}` };
}

/** 素材完备度：图集数量分档（0/1-2/3-5/6+ → 0/40/70/100）。 */
function scoreGallery(count: number | null | undefined): { score: number; reason: string } {
  const n = count ?? 0;
  if (n <= 0) return { score: 0, reason: '无图集素材' };
  if (n <= 2) return { score: 40, reason: `图集 ${n} 张（偏少）` };
  if (n <= 5) return { score: 70, reason: `图集 ${n} 张` };
  return { score: 100, reason: `图集 ${n} 张（充足）` };
}

/* ------------------------------ 编排与产出 ------------------------------ */

export interface SelectionKeywordInput {
  term: string;
  /** 报告侧给出该词的理由（⑦章关键词建议透传，展示用，不参与评分） */
  rationale?: string;
}

export interface SelectionInput {
  keywords: SelectionKeywordInput[];
  /** 保留上限（任务卡口径 30） */
  topN?: number;
  /** 每词检索候选上限（执行侧翻页/停取口径） */
  perKeywordLimit?: number;
}

export interface ScoredSelectionCandidate {
  offerId: string;
  keyword: string;
  rank: number;
  total: number;
  dimensions: DimensionScore[];
  candidate: SourcingCandidate;
}

export interface SelectionResult {
  selectionId: string;
  generatedAt: string;
  topN: number;
  stats: {
    keywords: Array<{ term: string; candidates: number; retained: number; excludedJunk: number }>;
    dedupedAcrossKeywords: number;
    totalScored: number;
  };
  top: ScoredSelectionCandidate[];
}

export interface SelectionAgentDeps {
  search: SourcingSearchPort;
  now?: () => Date;
}

/**
 * 选品 Agent 主入口：多词扇出检索 → 跨词去重（offerId 首现词归属）→ 按词队列
 * 五维评分 → 相关性 0 分剔除（推荐流防御）→ 加权总分排序取 TopN（并列按 offerId
 * 稳定定序，保证确定性）。
 */
export async function generateSelection(
  input: SelectionInput,
  deps: SelectionAgentDeps,
): Promise<SelectionResult> {
  if (input.keywords.length === 0) throw new Error('E-SELECTION-NO-KEYWORD: 选品输入至少一个关键词');
  const topN = input.topN ?? 30;
  const perKeywordLimit = input.perKeywordLimit ?? 30;
  const now = deps.now ?? (() => new Date());

  // 1) 扇出检索 + 跨词去重（同一 offerId 归属首次出现的关键词）
  const byOffer = new Map<string, { keyword: string; candidate: SourcingCandidate }>();
  const perKeyword = new Map<string, SourcingCandidate[]>();
  const rawCountByKeyword = new Map<string, number>();
  let dedupedAcrossKeywords = 0;
  for (const kw of input.keywords) {
    const raw = await deps.search.search(kw.term, perKeywordLimit);
    rawCountByKeyword.set(kw.term, raw.length);
    const kept: SourcingCandidate[] = [];
    for (const c of raw) {
      if (!c.offerId || !c.title) continue;
      if (byOffer.has(c.offerId)) {
        dedupedAcrossKeywords += 1;
        continue;
      }
      byOffer.set(c.offerId, { keyword: kw.term, candidate: c });
      kept.push(c);
    }
    perKeyword.set(kw.term, kept);
  }

  // 2) 分词队列评分（价格/销量分位需同词对照）
  const scored: Scored[] = [];
  const statsKeywords: SelectionResult['stats']['keywords'] = [];
  for (const [term, cohort] of perKeyword) {
    const priced = cohort
      .map((c) => ({ key: c.offerId, price: parsePriceRange(c.priceText) }))
      .filter((x): x is { key: string; price: PriceRange } => x.price !== null);
    const salesed = cohort
      .map((c) => ({ key: c.offerId, sales: parseMonthlySales(c.salesText) }))
      .filter((x): x is { key: string; sales: number } => x.sales !== null);

    let retained = 0;
    let excludedJunk = 0;    for (const c of cohort) {
      const relevance = scoreRelevance(c.title, term);
      if (relevance.score === 0) {
        excludedJunk += 1;
        continue;
      }
      const price = parsePriceRange(c.priceText);
      const sales = parseMonthlySales(c.salesText);
      const priceScore = price
        ? percentileScore(priced.map((p) => ({ key: p.key, value: p.price.min })), c.offerId, { inverted: true })
        : { score: 40, reason: '无价格信号' };
      const salesScore = sales
        ? percentileScore(salesed.map((s) => ({ key: s.key, value: s.sales })), c.offerId, { inverted: false })
        : { score: 25, reason: '无销量信号' };
      const supplier = scoreSupplier(c);
      const gallery = scoreGallery(c.galleryCount);
      const dimensions: DimensionScore[] = [
        { name: 'relevance', ...SELECTION_DIMENSIONS.relevance, ...relevance },
        { name: 'price', ...SELECTION_DIMENSIONS.price, ...priceScore },
        { name: 'sales', ...SELECTION_DIMENSIONS.sales, ...salesScore },
        { name: 'supplier', ...SELECTION_DIMENSIONS.supplier, ...supplier },
        { name: 'gallery', ...SELECTION_DIMENSIONS.gallery, ...gallery },
      ];
      const total = Math.round(
        dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) * 100,
      ) / 100;
      scored.push({ offerId: c.offerId, keyword: term, candidate: c, dimensions, total });
      retained += 1;
    }
    statsKeywords.push({ term, candidates: rawCountByKeyword.get(term) ?? cohort.length, retained, excludedJunk });
  }

  // 3) 排序取 TopN：总分降序，并列按 offerId 升序（确定性定序）
  scored.sort((a, b) => b.total - a.total || (a.offerId < b.offerId ? -1 : 1));
  const top: ScoredSelectionCandidate[] = scored.slice(0, topN).map((s, i) => ({
    offerId: s.offerId,
    keyword: s.keyword,
    rank: i + 1,
    total: s.total,
    dimensions: s.dimensions,
    candidate: s.candidate,
  }));

  return {
    selectionId: randomUUID(),
    generatedAt: now().toISOString(),
    topN,
    stats: {
      keywords: statsKeywords,
      dedupedAcrossKeywords,
      totalScored: scored.length,
    },
    top,
  };
}

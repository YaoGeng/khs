/**
 * 八章节报告 schema 与提示词（FR-5.2 枚举；02 §8.2 report-agent 产出定义）。
 * ①需求场景聚类与热度 ②用户痛点 TopN ③购买决策因素 ④价格带分布
 * ⑤竞品内容打法 ⑥内容机会点 ⑦1688 选品关键词建议 ⑧数据来源与方法说明
 * （⑧章四字段=各章样本量/数据窗口/清洗规则/置信度——01:161、03:192 验收硬约束）
 */
import { z } from 'zod';

export const CHAPTER_IDS = [
  'scenarios',
  'painPoints',
  'decisionFactors',
  'priceBands',
  'competitorPlaybook',
  'contentOpportunities',
  'selectionKeywords',
  'methodology',
] as const;

export type ChapterId = (typeof CHAPTER_IDS)[number];

export const CHAPTER_TITLES: Record<ChapterId, string> = {
  scenarios: '① 需求场景聚类与热度',
  painPoints: '② 用户痛点 TopN',
  decisionFactors: '③ 购买决策因素',
  priceBands: '④ 价格带分布',
  competitorPlaybook: '⑤ 竞品内容打法',
  contentOpportunities: '⑥ 内容机会点',
  selectionKeywords: '⑦ 1688 选品关键词建议',
  methodology: '⑧ 数据来源与方法说明',
};

/** ①–⑦ 章通用结构（全章非空是 zod 硬校验面） */
export const ChapterSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  bullets: z.array(z.string().min(1)).min(1),
});

/** ⑧ 章四字段（各章样本量/数据窗口/清洗规则/置信度） */
export const MethodologyChapterSchema = ChapterSchema.extend({
  chapterSampleSizes: z.record(z.string(), z.number().int().nonnegative()),
  dataWindow: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  cleaningRules: z.array(z.string().min(1)).min(1),
  confidence: z.string().min(1),
});

/** LLM 只产 ⑧ 章叙述（title/summary），四字段由本地确定性计算后合并（数字不被模型改写） */
export const MethodologyLlmPartSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
});

export const ReportSchema = z.object({
  topic: z.string().min(1),
  generatedAt: z.string().min(1),
  clusterRoute: z.enum(['vector', 'statistical']),
  clusterK: z.number().int().nonnegative(),
  chapters: z.object({
    scenarios: ChapterSchema,
    painPoints: ChapterSchema,
    decisionFactors: ChapterSchema,
    priceBands: ChapterSchema,
    competitorPlaybook: ChapterSchema,
    contentOpportunities: ChapterSchema,
    selectionKeywords: ChapterSchema,
    methodology: MethodologyChapterSchema,
  }),
});

export type Chapter = z.infer<typeof ChapterSchema>;
export type MethodologyChapter = z.infer<typeof MethodologyChapterSchema>;
export type ReportJson = z.infer<typeof ReportSchema>;

export const CHAPTER_INSTRUCTIONS: Record<ChapterId, string> = {
  scenarios: '基于聚类结果归纳主要需求场景簇：每簇给出场景名、热度（样本量与互动水平）与典型诉求。bullets 每条对应一个场景簇。',
  painPoints: '从笔记文本中提炼高频痛点（按出现频次/强度排序 TopN），每条注明依据场景。bullets 每条一个痛点。',
  decisionFactors: '归纳用户购买决策因素（成分/功效/价格/口碑/品牌等）及其相对权重观察。bullets 每条一个因素。',
  priceBands: '基于价格信号统计价格带分布与主流接受区间，指出空档价格带（若有）。bullets 每条一个价格带观察。',
  competitorPlaybook: '总结竞品/头部笔记的内容打法（选题角度、结构、钩子、互动引导），bullets 每条一个打法。',
  contentOpportunities: '给出差异化内容机会点（未被充分覆盖的场景/角度/人群），bullets 每条一个机会点并附理由。',
  selectionKeywords: '给出 1688 选品关键词建议（采购视角词根+组合），仅建议不执行选品。bullets 每条一个关键词建议并附一句理由。注意合规：不得包含医疗功效断言词。',
  methodology: '用一段话概括数据来源与方法（样本、聚类路线、LLM 分章分析、去标识化处理）。四项结构化字段由系统生成，不需模型输出。',
};

export interface ChapterPromptContext {
  topic: string;
  /** 去标识化后的摘要统计（本地确定性计算，禁止 LLM 编造数字的锚点） */
  digest: string;
  /** 去标识化笔记 payload 的精简 JSON 行（标题+正文截断+假名+互动数） */
  notesPayload: string;
  /** 该章节目标 JSON Schema（prompt-embedded 档内嵌） */
  schema: Record<string, unknown>;
}

export function chapterSystemPrompt(): string {
  return '你是小红书需求洞察分析引擎。只依据给定的统计数据与笔记样本输出结论，不编造未给出的数字；涉及医疗、功效表述必须使用合规措辞（改善/呵护，禁止治疗断言）。';
}

export function chapterUserPrompt(chapterId: ChapterId, ctx: ChapterPromptContext): string {
  return [
    `主题：${ctx.topic}`,
    `章节任务：${CHAPTER_TITLES[chapterId]}——${CHAPTER_INSTRUCTIONS[chapterId]}`,
    '【统计数据】',
    ctx.digest,
    '【笔记样本（已去标识化）】',
    ctx.notesPayload,
    '【输出】只输出符合以下 JSON Schema 的单个 JSON 对象（无其他文字）：',
    JSON.stringify(ctx.schema),
  ].join('\n');
}

export interface ReportMeta {
  model: string;
  tokensIn: number;
  tokensOut: number;
  llmRequestCount: number;
  clusterReason?: string;
}

/** 报告 Markdown 渲染（八章节+token 消耗行；reports.contentMd 与导出 MD 同源） */
export function renderReportMd(report: ReportJson, meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push(`# ${report.topic} · 需求洞察报告`);
  lines.push('');
  lines.push(`> 生成时间：${report.generatedAt} · 模型：${meta.model} · 聚类路线：${report.clusterRoute === 'vector' ? '向量嵌入+KMeans' : '统计聚类（char-3gram TF-IDF+KMeans）'}（K=${report.clusterK}）`);
  lines.push('');
  for (const id of CHAPTER_IDS) {
    const chapter = report.chapters[id];
    lines.push(`## ${chapter.title}`);
    lines.push('');
    lines.push(chapter.summary);
    lines.push('');
    for (const bullet of chapter.bullets) lines.push(`- ${bullet}`);
    lines.push('');
  }
  const methodology = report.chapters.methodology;
  lines.push('### 方法说明四要素');
  lines.push('');
  lines.push(`- 各章样本量：${Object.entries(methodology.chapterSampleSizes).map(([k, v]) => `${k}=${v}`).join('，')}`);
  lines.push(`- 数据窗口：${methodology.dataWindow.from} ~ ${methodology.dataWindow.to}`);
  lines.push(`- 清洗规则：${methodology.cleaningRules.join('；')}`);
  lines.push(`- 置信度：${methodology.confidence}`);
  lines.push('');
  lines.push(`---`);
  lines.push('');
  lines.push(`Token 消耗：输入 ${meta.tokensIn} tokens / 输出 ${meta.tokensOut} tokens（${meta.llmRequestCount} 次 LLM 请求，模型 ${meta.model}）`);
  return lines.join('\n');
}

/** 置信度启发式（写死口径：样本量分档；<8 低，8-19 中低，20-49 中，≥50 较高） */
export function confidenceForSampleSize(n: number): string {
  if (n >= 50) return '较高（样本≥50）';
  if (n >= 20) return '中（样本 20-49）';
  if (n >= 8) return '中低（样本 8-19）';
  return '低（样本<8，结论仅供探索参考）';
}

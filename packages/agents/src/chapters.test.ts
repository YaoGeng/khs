import { describe, it, expect } from 'vitest';
import {
  CHAPTER_IDS,
  CHAPTER_TITLES,
  ChapterSchema,
  MethodologyChapterSchema,
  ReportSchema,
  renderReportMd,
  confidenceForSampleSize,
} from './chapters.js';

const chapter = { title: '① 需求场景聚类与热度', summary: '四个主要场景簇', bullets: ['换季泛红（样本 8，热度高）'] };

const methodology = {
  title: '⑧ 数据来源与方法说明',
  summary: '基于 20 条去标识化笔记的统计聚类与分章 LLM 分析。',
  bullets: ['数据来源：本地采集笔记 20 条'],
  chapterSampleSizes: { scenarios: 20, methodology: 20 },
  dataWindow: { from: '2026-09-01T00:00:00Z', to: '2026-10-11T00:00:00Z' },
  cleaningRules: ['昵称/ID 假名化', '粉丝分桶'],
  confidence: '中（样本 20-49）',
};

const fullReport = {
  topic: '敏感肌修护护肤品',
  generatedAt: '2026-10-14T00:00:00.000Z',
  clusterRoute: 'statistical',
  clusterK: 4,
  chapters: {
    scenarios: { ...chapter, title: CHAPTER_TITLES.scenarios },
    painPoints: { ...chapter, title: CHAPTER_TITLES.painPoints },
    decisionFactors: { ...chapter, title: CHAPTER_TITLES.decisionFactors },
    priceBands: { ...chapter, title: CHAPTER_TITLES.priceBands },
    competitorPlaybook: { ...chapter, title: CHAPTER_TITLES.competitorPlaybook },
    contentOpportunities: { ...chapter, title: CHAPTER_TITLES.contentOpportunities },
    selectionKeywords: { ...chapter, title: CHAPTER_TITLES.selectionKeywords },
    methodology,
  },
};

describe('章节 schema（zod 校验面）', () => {
  it('①-⑦ 章通用结构通过；空 bullets/空 title 拒绝', () => {
    expect(ChapterSchema.safeParse(chapter).success).toBe(true);
    expect(ChapterSchema.safeParse({ ...chapter, bullets: [] }).success).toBe(false);
    expect(ChapterSchema.safeParse({ ...chapter, title: '' }).success).toBe(false);
    expect(ChapterSchema.safeParse({ ...chapter, summary: 42 }).success).toBe(false);
  });

  it('⑧ 章四字段齐全通过；缺任一字段拒绝', () => {
    expect(MethodologyChapterSchema.safeParse(methodology).success).toBe(true);
    for (const key of ['chapterSampleSizes', 'dataWindow', 'cleaningRules', 'confidence']) {
      const broken = { ...methodology } as Record<string, unknown>;
      delete broken[key];
      expect(MethodologyChapterSchema.safeParse(broken).success).toBe(false);
    }
  });

  it('整报告 schema：八章齐全通过；缺章拒绝；clusterRoute 枚举校验', () => {
    expect(ReportSchema.safeParse(fullReport).success).toBe(true);
    const missing = { ...fullReport, chapters: { ...fullReport.chapters } } as typeof fullReport;
    delete (missing.chapters as Record<string, unknown>).priceBands;
    expect(ReportSchema.safeParse(missing).success).toBe(false);
    expect(ReportSchema.safeParse({ ...fullReport, clusterRoute: 'psychic' }).success).toBe(false);
  });

  it('章节枚举与 FR-5.2 八章对齐', () => {
    expect(CHAPTER_IDS).toEqual([
      'scenarios',
      'painPoints',
      'decisionFactors',
      'priceBands',
      'competitorPlaybook',
      'contentOpportunities',
      'selectionKeywords',
      'methodology',
    ]);
    expect(CHAPTER_TITLES.methodology).toContain('数据来源与方法说明');
  });
});

describe('renderReportMd（八章节 + token 消耗行）', () => {
  const parsed = ReportSchema.parse(fullReport);
  const md = renderReportMd(parsed, { model: 'mock-model', tokensIn: 1234, tokensOut: 567, llmRequestCount: 8 });

  it('八章标题全部出现', () => {
    for (const id of CHAPTER_IDS) {
      expect(md).toContain(CHAPTER_TITLES[id]);
    }
  });

  it('含方法说明四要素与 token 消耗行', () => {
    expect(md).toContain('各章样本量');
    expect(md).toContain('数据窗口');
    expect(md).toContain('清洗规则');
    expect(md).toContain('置信度');
    expect(md).toContain('Token 消耗：输入 1234 tokens / 输出 567 tokens（8 次 LLM 请求，模型 mock-model）');
  });
});

describe('confidenceForSampleSize（写死口径）', () => {
  it('样本量分档', () => {
    expect(confidenceForSampleSize(5)).toContain('低');
    expect(confidenceForSampleSize(10)).toContain('中低');
    expect(confidenceForSampleSize(20)).toContain('中');
    expect(confidenceForSampleSize(60)).toContain('较高');
  });
});

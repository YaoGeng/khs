/**
 * @xinglian/agents 公共出口（todo 8 / T-M1-05：stub 变实——report-agent v1）。
 * M1 仅确定性流水线；AgentRuntime planner/reflect/多 Agent 归 M2（05 边界）。
 */
export const PACKAGE_NAME = 'agents';

export { generateReport, extractPrices, KV_FIRST_REPORT_GENERATED } from './report-agent.js';
export type { AgentNote, ReportAgentPorts, ReportAgentConfig, ReportOutcome } from './report-agent.js';
export {
  SELECTION_DIMENSIONS,
  generateSelection,
  parseMonthlySales,
  parsePriceRange,
} from './selection-agent.js';
export type {
  DimensionScore,
  PriceRange,
  ScoredSelectionCandidate,
  SelectionAgentDeps,
  SelectionInput,
  SelectionKeywordInput,
  SelectionResult,
  SourcingCandidate,
  SourcingSearchPort,
} from './selection-agent.js';
export {
  CHAPTER_IDS,
  CHAPTER_TITLES,
  CHAPTER_INSTRUCTIONS,
  ChapterSchema,
  MethodologyChapterSchema,
  MethodologyLlmPartSchema,
  ReportSchema,
  chapterSystemPrompt,
  chapterUserPrompt,
  renderReportMd,
  confidenceForSampleSize,
} from './chapters.js';
export type { Chapter, ChapterId, MethodologyChapter, ReportJson, ChapterPromptContext, ReportMeta } from './chapters.js';
export {
  mulberry32,
  char3grams,
  fitTfIdf,
  dotSparse,
  chooseK,
  clusterTexts,
  clusterVectors,
  topTermsPerCluster,
  l2Normalize,
} from './clustering.js';
export type { TfIdfModel, TfIdfVector, StatisticalClusterResult, VectorClusterResult } from './clustering.js';
export { M1_FIXTURE_NOTES, M1_FIXTURE_TOPIC } from './fixtures.js';

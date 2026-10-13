/**
 * report-agent v1（todo 8 / T-M1-05 ②，02 §8.2）：确定性流水线，无 planner/reflect 工具环（M2 才需要）。
 *
 * 输入 topic + 清洗后笔记集 → 去标识化 → 聚类（探针 ok=向量+KMeans；否则 char-3gram TF-IDF+KMeans，ADR-7 降级链）
 * → 分章 LLM 分析（八章独立 prompt + 章节 JSON）→ 合并八章节 JSON（⑧章四字段本地确定性计算）
 * → zod 校验失败纠偏重试 ≤2 → reports 落库 + first_report_generated 遥测（kv 幂等位）。
 *
 * 合规红线（02:394）：Agent 产出永不直接执行——本模块没有任何工具执行/采集/发布出口，
 * 唯一的副作用是经注入 Port 写 reports 表与遥测事件；⑦章关键词仅建议，选品执行归 M2。
 */
import { randomUUID } from 'node:crypto';
import {
  deidentifyNotesForPayload,
  type DeidentifyOptions,
  type KvPort,
  type SchemaInjectionStrategy,
} from '@xinglian/llm-gateway';
import {
  CHAPTER_IDS,
  CHAPTER_TITLES,
  ChapterSchema,
  MethodologyLlmPartSchema,
  ReportSchema,
  chapterSystemPrompt,
  chapterUserPrompt,
  confidenceForSampleSize,
  renderReportMd,
  type ChapterId,
  type MethodologyChapter,
  type ReportJson,
} from './chapters.js';
import { clusterTexts, clusterVectors } from './clustering.js';

export interface AgentNote {
  noteId: string;
  title?: string | null;
  content?: string | null;
  author?: unknown;
  likes?: number;
  collects?: number;
  comments?: number;
  tags?: unknown;
  publishedAt?: string | null;
  collectedAt?: string;
}

/** 组合根注入的端口面：store client（reports 落库）、kv（幂等位）、遥测发射器 */
export interface ReportAgentPorts {
  /** 结构化输出通道（LlmGateway.structured 的窄类型视图） */
  structured: <T>(req: {
    system?: string;
    user: string;
    name: string;
    schema: Record<string, unknown>;
    parse: (value: unknown) => T;
    strategies?: readonly SchemaInjectionStrategy[];
    traceId?: string;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<{ value: T; strategy: string; requestCount: number; tokensIn: number; tokensOut: number }>;
  store: {
    insertReport(input: { topic: string; report: unknown; contentMd: string; model: string; tokenCost: number }): Promise<{ id: number }>;
  };
  kv: KvPort;
  telemetry: {
    emit(kind: string, payload?: unknown): void;
  };
}

export interface ReportAgentConfig {
  topic: string;
  notes: AgentNote[];
  model: string;
  /** 去标识化本地盐（组合根持久化；同盐可重放假名） */
  salt: string;
  strategies?: readonly SchemaInjectionStrategy[];
  /** 向量路线（组合根先跑探针；提供即启用嵌入+KMeans，调用失败自动落统计聚类并记录原因） */
  embedTexts?: (texts: string[]) => Promise<Float32Array[]>;
  seed?: number;
  /** 纠偏重试次数上限（默认 2：初试 + 2 次纠偏 = 每章最多 3 次 LLM 请求） */
  maxCorrectionRetries?: number;
  now?: () => Date;
}

export type ReportOutcome =
  | {
      status: 'completed';
      reportId: number;
      report: ReportJson;
      contentMd: string;
      tokensIn: number;
      tokensOut: number;
      llmRequestCount: number;
      llmCallRecords: { chapter: ChapterId; strategy: string }[];
      clusterRoute: 'vector' | 'statistical';
      clusterK: number;
      clusterReason?: string;
      firstReportTelemetryEmitted: boolean;
    }
  | {
      status: 'failed';
      reason: string;
      chapter: ChapterId;
      llmRequestCount: number;
      tokensIn: number;
      tokensOut: number;
      llmCallRecords: { chapter: ChapterId; strategy: string }[];
    };

/** kv 幂等位键（first_report_generated 只发一次——todo 9 遥测契约） */
export const KV_FIRST_REPORT_GENERATED = 'report-agent.first_report_generated';

const DIGEST_MAX_NOTES_IN_PAYLOAD = 20;
const NOTE_CONTENT_TRUNCATE = 160;

interface ClusterAnalysis {
  route: 'vector' | 'statistical';
  k: number;
  assignments: number[];
  clusterSummaries: { label: string; size: number; topTerms: string[] }[];
  reason?: string;
}

interface ClusterRouteInput {
  texts: string[];
  embedTexts?: (texts: string[]) => Promise<Float32Array[]>;
  seed?: number;
}

async function analyzeClusters(input: ClusterRouteInput): Promise<ClusterAnalysis> {
  const { texts } = input;
  const statistical = (reason?: string): ClusterAnalysis => {
    const result = clusterTexts(texts, { seed: input.seed });
    const clusterSummaries = result.topTerms.map((terms, i) => ({
      label: `场景簇${i + 1}`,
      size: result.assignments.filter((a) => a === i).length,
      topTerms: terms,
    }));
    return { route: 'statistical', k: result.k, assignments: result.assignments, clusterSummaries, reason };
  };
  if (input.embedTexts) {
    try {
      const vectors = await input.embedTexts(texts);
      const result = clusterVectors(vectors, { seed: input.seed });
      const clusterSummaries = Array.from({ length: result.k }, (_, i) => ({
        label: `场景簇${i + 1}`,
        size: result.assignments.filter((a) => a === i).length,
        topTerms: [] as string[],
      }));
      return { route: 'vector', k: result.k, assignments: result.assignments, clusterSummaries, reason: 'embedding-probe-ok' };
    } catch (err) {
      return statistical(`向量路线失败回落统计聚类：${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
    }
  }
  return statistical('统计聚类（默认主路线：无可用 embeddings 端点，ADR-7 §4）');
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 价格信号提取（¥/￥/「XX 元」；区间取下限）——供④章 prompt 的确定性锚点 */
export function extractPrices(text: string): number[] {
  const prices: number[] = [];
  const patterns = [/[¥￥]\s*(\d+(?:\.\d+)?)/g, /(\d+(?:\.\d+)?)\s*元/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 100000) prices.push(value);
    }
  }
  return prices;
}

function buildDigest(
  topic: string,
  payloadNotes: AgentNote[],
  clusters: ClusterAnalysis,
): { digest: string; notesWithPrice: number } {
  const total = payloadNotes.length;
  const likes = payloadNotes.map((n) => n.likes ?? 0);
  const collects = payloadNotes.map((n) => n.collects ?? 0);
  const comments = payloadNotes.map((n) => n.comments ?? 0);
  const prices = payloadNotes.flatMap((n) => extractPrices(`${n.title ?? ''} ${n.content ?? ''}`));
  const notesWithPrice = payloadNotes.filter((n) => extractPrices(`${n.title ?? ''} ${n.content ?? ''}`).length > 0).length;
  const priceBuckets = { '<100': 0, '100-200': 0, '200-300': 0, '300+': 0 };
  for (const p of prices) {
    if (p < 100) priceBuckets['<100'] += 1;
    else if (p < 200) priceBuckets['100-200'] += 1;
    else if (p < 300) priceBuckets['200-300'] += 1;
    else priceBuckets['300+'] += 1;
  }
  const clusterLines = clusters.clusterSummaries
    .map((c) => `  ${c.label}: ${c.size} 条${c.topTerms.length > 0 ? `，特征=${c.topTerms.slice(0, 5).join('/')}` : ''}`)
    .join('\n');
  const digest = [
    `主题=${topic}`,
    `样本量=${total}`,
    `互动中位数: likes=${median(likes)}, collects=${median(collects)}, comments=${median(comments)}；likes 最大值=${Math.max(...likes, 0)}`,
    `聚类路线=${clusters.route}（K=${clusters.k}${clusters.reason ? `，${clusters.reason}` : ''}）`,
    '簇分布:',
    clusterLines,
    `价格信号: ${notesWithPrice} 条笔记含价格，共 ${prices.length} 个价格点，分桶=${JSON.stringify(priceBuckets)}，区间 ${prices.length > 0 ? `${Math.min(...prices)}-${Math.max(...prices)} 元` : '未提取到'}`,
  ].join('\n');
  return { digest, notesWithPrice };
}

function buildNotesPayload(payloadNotes: AgentNote[]): string {
  return JSON.stringify(
    payloadNotes.slice(0, DIGEST_MAX_NOTES_IN_PAYLOAD).map((n) => ({
      noteId: n.noteId,
      title: n.title ?? '',
      content: (n.content ?? '').slice(0, NOTE_CONTENT_TRUNCATE),
      author: n.author,
      likes: n.likes ?? 0,
      collects: n.collects ?? 0,
      comments: n.comments ?? 0,
      tags: Array.isArray(n.tags) ? n.tags.slice(0, 5) : [],
    })),
  );
}

function dataWindowOf(notes: AgentNote[], now: Date): { from: string; to: string } {
  const times = notes
    .map((n) => Date.parse(n.publishedAt ?? n.collectedAt ?? ''))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) {
    const day = 24 * 60 * 60 * 1000;
    return { from: new Date(now.getTime() - 30 * day).toISOString(), to: now.toISOString() };
  }
  return { from: new Date(Math.min(...times)).toISOString(), to: new Date(Math.max(...times)).toISOString() };
}

/**
 * 主入口：生成八章节报告。任何一章纠偏重试耗尽 → 整体 failed（fail-fast，不落 reports）。
 */
export async function generateReport(ports: ReportAgentPorts, config: ReportAgentConfig): Promise<ReportOutcome> {
  const now = config.now ?? (() => new Date());
  const traceId = `report-${randomUUID()}`;
  const maxCorrectionRetries = config.maxCorrectionRetries ?? 2;
  const deidOptions: DeidentifyOptions = { salt: config.salt };
  const llmCallRecords: { chapter: ChapterId; strategy: string }[] = [];
  let llmRequestCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  // 1) 仅清洗发往 LLM 的 payload；本地 notes 原文零改动（fixtures/notes 表数据不入此路径）
  const payloadNotes = deidentifyNotesForPayload(config.notes, deidOptions);

  // 2) 聚类（向量探针通过=向量+KMeans；否则统计聚类，ADR-7 降级链）
  const texts = payloadNotes.map((n) => `${n.title ?? ''}\n${n.content ?? ''}`);
  const clusters = await analyzeClusters({ texts, embedTexts: config.embedTexts, seed: config.seed });

  const { digest, notesWithPrice } = buildDigest(config.topic, payloadNotes, clusters);
  const notesPayload = buildNotesPayload(payloadNotes);
  const window = dataWindowOf(config.notes, now());
  const total = config.notes.length;

  // 3) 分章 LLM 分析（独立 prompt + 章节 JSON；zod 校验失败纠偏重试 ≤2，fail-fast）
  const chapterValues = new Map<ChapterId, unknown>();
  for (const chapterId of CHAPTER_IDS) {
    const schema = chapterId === 'methodology' ? { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title', 'summary'], additionalProperties: false } : { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } }, required: ['title', 'summary', 'bullets'], additionalProperties: false };
    const baseUser = chapterUserPrompt(chapterId, {
      topic: config.topic,
      digest,
      notesPayload,
      schema,
    });
    let attempt = 0;
    let user = baseUser;
    for (;;) {
      let value: unknown;
      try {
        const result = await ports.structured({
          system: chapterSystemPrompt(),
          user,
          name: `report-chapter-${chapterId}`,
          schema,
          parse: (v) => v,
          strategies: config.strategies,
          traceId,
        });
        value = result.value;
        llmCallRecords.push({ chapter: chapterId, strategy: result.strategy });
        llmRequestCount += result.requestCount;
        tokensIn += result.tokensIn;
        tokensOut += result.tokensOut;
      } catch (err) {
        // 降级链全段耗尽（HTTP/解析层失败）→ 直接失败（该章已无可用输出）；失败段请求也计入计量对账
        const structuredErr = err as { requestCount?: number; tokensIn?: number; tokensOut?: number };
        llmRequestCount += structuredErr.requestCount ?? 0;
        tokensIn += structuredErr.tokensIn ?? 0;
        tokensOut += structuredErr.tokensOut ?? 0;
        return {
          status: 'failed',
          reason: `第 ${chapterId} 章结构化输出失败：${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
          chapter: chapterId,
          llmRequestCount,
          tokensIn,
          tokensOut,
          llmCallRecords,
        };
      }
      try {
        if (chapterId === 'methodology') {
          const merged = mergeMethodology(MethodologyLlmPartSchema.parse(value), {
            total,
            window,
            clusters,
            notesWithPrice,
          });
          chapterValues.set(chapterId, merged);
        } else {
          chapterValues.set(chapterId, ChapterSchema.parse(value));
        }
        break;
      } catch (err) {
        const validationError = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
        attempt += 1;
        if (attempt > maxCorrectionRetries) {
          return {
            status: 'failed',
            reason: `第 ${chapterId} 章输出连续 ${maxCorrectionRetries + 1} 次未通过 schema 校验：${validationError}`,
            chapter: chapterId,
            llmRequestCount,
            tokensIn,
            tokensOut,
            llmCallRecords,
          };
        }
        // 纠偏重试：携带上一次违例输出与校验错误重发
        user = `${baseUser}\n\n【纠偏重试 ${attempt}/${maxCorrectionRetries}】你上一次的输出未通过校验：${validationError}\n请严格按 JSON Schema 重新输出（所有字段非空、bullets 至少 1 条）。`;
      }
    }
  }

  // 4) 合并 + 整报告 zod 校验（防漂移兜底）
  const report = ReportSchema.parse({
    topic: config.topic,
    generatedAt: now().toISOString(),
    clusterRoute: clusters.route,
    clusterK: clusters.k,
    chapters: Object.fromEntries(CHAPTER_IDS.map((id) => [id, chapterValues.get(id)])),
  });

  // 5) 落库（Agent 产出永不直接执行：唯一出口是 reports 表）
  const meta = { model: config.model, tokensIn, tokensOut, llmRequestCount };
  const contentMd = renderReportMd(report, meta);
  const { id } = await ports.store.insertReport({
    topic: config.topic,
    report,
    contentMd,
    model: config.model,
    tokenCost: tokensIn + tokensOut,
  });

  // 6) first_report_generated 遥测（kv 幂等位防重）
  let firstReportTelemetryEmitted = false;
  const flag = await ports.kv.get(KV_FIRST_REPORT_GENERATED);
  if (!flag) {
    ports.telemetry.emit('first_report_generated', { topic: config.topic, reportId: id });
    await ports.kv.set(KV_FIRST_REPORT_GENERATED, now().toISOString());
    firstReportTelemetryEmitted = true;
  }

  return {
    status: 'completed',
    reportId: id,
    report,
    contentMd,
    tokensIn,
    tokensOut,
    llmRequestCount,
    llmCallRecords,
    clusterRoute: clusters.route,
    clusterK: clusters.k,
    clusterReason: clusters.reason,
    firstReportTelemetryEmitted,
  };
}

/** ⑧ 章四字段合并（LLM 只产 title/summary；数字全部本地确定性生成） */
function mergeMethodology(
  llmPart: { title: string; summary: string },
  ctx: { total: number; window: { from: string; to: string }; clusters: ClusterAnalysis; notesWithPrice: number },
): MethodologyChapter {
  const chapterSampleSizes: Record<string, number> = {};
  for (const id of CHAPTER_IDS) chapterSampleSizes[CHAPTER_TITLES[id]] = ctx.total;
  const cleaningRules = [
    '第三方身份字段去标识化：作者昵称/ID → 本地盐 sha256 前 8 hex 假名（author_xxxxxxxx），映射不上传',
    '粉丝数 → 量级分桶（<100 / 100-1k / 1k-1w / 1w+）',
    '仅清洗发往 LLM 的 payload；本地笔记原文零改动',
    `聚类：${ctx.clusters.route === 'vector' ? '向量嵌入+KMeans' : '统计聚类 char-3gram TF-IDF+KMeans'}（K=${ctx.clusters.k}，ADR-7 降级链）`,
    '分章 LLM 分析：八章独立 prompt+章节 JSON，zod 校验失败纠偏重试 ≤2',
    `价格信号提取：含价格笔记 ${ctx.notesWithPrice} 条（④章）`,
  ];
  return {
    title: llmPart.title,
    summary: llmPart.summary,    bullets: [
      `数据来源：本地采集笔记 ${ctx.total} 条（已去标识化后送 LLM）`,
      `数据窗口：${ctx.window.from.slice(0, 10)} ~ ${ctx.window.to.slice(0, 10)}`,
      `聚类路线：${ctx.clusters.route === 'vector' ? '向量嵌入' : '统计聚类'}${ctx.clusters.reason ? `（${ctx.clusters.reason}）` : ''}`,
      '分析方法：语义聚类 + 八章独立 LLM 分析 + zod schema 校验（纠偏重试 ≤2）',
    ],
    chapterSampleSizes,
    dataWindow: ctx.window,
    cleaningRules,
    confidence: confidenceForSampleSize(ctx.total),
  };
}

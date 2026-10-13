/**
 * report-agent 端到端单测（todo 8 验收②）：
 * 20 条 fixture 笔记 + mock JSON 端点（注入 fetch，OpenAI 兼容响应）→ 真实 LlmGateway 调用链
 * → 八章节 JSON 全章非空 + ⑧章四字段 + zod 通过；mock 恒返 schema 违例 → 纠偏重试 2 次后 failed
 * 且 llm_calls 计量恰 3 条。落库/遥测经内存 Port 断言（Agent 产出永不直接执行——只落 reports）。
 */
import { describe, it, expect } from 'vitest';
import { LlmGateway } from '@xinglian/llm-gateway';
import { generateReport, KV_FIRST_REPORT_GENERATED } from './report-agent.js';
import { ReportSchema, CHAPTER_IDS, CHAPTER_TITLES, type ChapterId } from './chapters.js';
import { M1_FIXTURE_NOTES, M1_FIXTURE_TOPIC } from './fixtures.js';
import type { LlmCallRecord } from '@xinglian/llm-gateway';

const SALT = 'agents-test-salt';

interface CapturedRequest {
  chapter: ChapterId | 'unknown';
  body: string;
}

function chapterFromPrompt(prompt: string): ChapterId | 'unknown' {
  for (const id of CHAPTER_IDS) {
    if (prompt.includes(CHAPTER_TITLES[id])) return id;
  }
  return 'unknown';
}

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 0,
      model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 21, completion_tokens: 13, total_tokens: 34 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeHarness(respond: (chapter: ChapterId | 'unknown') => string) {
  const captured: CapturedRequest[] = [];
  const llmCallRecords: LlmCallRecord[] = [];
  const gateway = new LlmGateway({
    provider: 'mock-endpoint',
    baseUrl: 'http://mock.local/v1',
    apiKey: 'sk-test',
    model: 'mock-model',
    strategies: ['prompt-embedded-schema'],
    fetchImpl: (async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ?? '';
      const parsed = JSON.parse(body) as { messages?: { content: string }[] };
      const prompt = (parsed.messages ?? []).map((m) => m.content).join('\n');
      captured.push({ chapter: chapterFromPrompt(prompt), body });
      return completion(respond(chapterFromPrompt(prompt)));
    }) as unknown as typeof fetch,
    sink: async (record) => {
      llmCallRecords.push(record);
    },
  });

  const insertedReports: { topic: string; report: unknown; contentMd: string; model: string; tokenCost: number }[] = [];
  const kv = new Map<string, unknown>();
  const emitted: { kind: string; payload?: unknown }[] = [];
  const ports = {
    structured: gateway.structured.bind(gateway),
    store: {
      insertReport: async (input: { topic: string; report: unknown; contentMd: string; model: string; tokenCost: number }) => {
        insertedReports.push(input);
        return { id: insertedReports.length };
      },
    },
    kv: {
      get: async (key: string) => kv.get(key) ?? null,
      set: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
    },
    telemetry: {
      emit: (kind: string, payload?: unknown) => {
        emitted.push({ kind, payload });
      },
    },
  };
  return { ports, captured, llmCallRecords, insertedReports, kv, emitted };
}

function validChapterJson(chapterInput: ChapterId | 'unknown'): string {
  const chapter: ChapterId = chapterInput === 'unknown' ? 'scenarios' : chapterInput;
  if (chapter === 'methodology') {
    return JSON.stringify({ title: CHAPTER_TITLES.methodology, summary: '本地 20 条去标识化笔记，统计聚类后分章 LLM 分析。' });
  }
  return JSON.stringify({
    title: CHAPTER_TITLES[chapter],
    summary: `本章小结（${chapter}）：基于 20 条去标识化样本的确定性统计与 LLM 分析。`,
    bullets: ['要点一：样本内互动中位数稳定，价格信号集中在 100-300 元', '要点二：换季修护与医美术后为最高频场景'],
  });
}

describe('generateReport happy path（20 fixture + mock JSON 端点 + 真实网关链）', () => {
  const harness = makeHarness((chapter) => validChapterJson(chapter));

  it('八章节 JSON 全章非空 + ⑧章四字段 + zod 通过 + 落库/遥测', async () => {
    const snapshot = JSON.parse(JSON.stringify(M1_FIXTURE_NOTES)) as unknown;
    const outcome = await generateReport(harness.ports, {
      topic: M1_FIXTURE_TOPIC,
      notes: M1_FIXTURE_NOTES,
      model: 'mock-model',
      salt: SALT,
      seed: 20261013,
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.clusterRoute).toBe('statistical');
    expect(outcome.llmRequestCount).toBe(8);
    expect(harness.llmCallRecords).toHaveLength(8);
    // 计量断言：每条 llm_calls 有 provider/model/tokens/latency
    for (const record of harness.llmCallRecords) {
      expect(record.provider).toBe('mock-endpoint');
      expect(record.model).toBe('mock-model');
      expect(record.tokensIn).toBe(21);
      expect(record.tokensOut).toBe(13);
      expect(typeof record.latencyMs).toBe('number');
    }

    const report = outcome.report;
    expect(() => ReportSchema.parse(report)).not.toThrow();
    for (const id of CHAPTER_IDS) {
      const chapter = report.chapters[id];
      expect(chapter.title.length).toBeGreaterThan(0);
      expect(chapter.summary.length).toBeGreaterThan(0);
      expect(chapter.bullets.length).toBeGreaterThan(0);
    }
    // ⑧章四字段
    expect(Object.keys(report.chapters.methodology.chapterSampleSizes)).toHaveLength(8);
    expect(report.chapters.methodology.dataWindow.from).toBeTruthy();
    expect(report.chapters.methodology.cleaningRules.length).toBeGreaterThan(0);
    expect(report.chapters.methodology.confidence).toContain('中');
    // contentMd 八章节 + token 行
    expect(outcome.contentMd).toContain('Token 消耗：输入 168 tokens / 输出 104 tokens');

    // 落库（唯一执行出口）
    expect(harness.insertedReports).toHaveLength(1);
    expect(harness.insertedReports[0].topic).toBe(M1_FIXTURE_TOPIC);
    expect(harness.insertedReports[0].model).toBe('mock-model');
    expect(harness.insertedReports[0].tokenCost).toBe(272);
    // 遥测幂等位
    expect(outcome.firstReportTelemetryEmitted).toBe(true);
    expect(harness.emitted).toEqual([{ kind: 'first_report_generated', payload: { topic: M1_FIXTURE_TOPIC, reportId: 1 } }]);
    expect(harness.kv.get(KV_FIRST_REPORT_GENERATED)).toBeTruthy();
    // 本地原文零改动
    expect(M1_FIXTURE_NOTES).toEqual(snapshot);
  });

  it('去标识化前置：prompt 含假名不含原始昵称/头像/粉丝原值', async () => {
    const allBodies = harness.captured.map((c) => c.body).join('\n');
    expect(allBodies).not.toContain('栗子拿铁不加糖');
    expect(allBodies).not.toContain('xhs-user-88321');
    expect(allBodies).not.toContain('example.com');
    expect(allBodies).toMatch(/author_[0-9a-f]{8}/);
  });

  it('第二次生成不重复发 first_report_generated（kv 幂等位）', async () => {
    const second = await generateReport(harness.ports, {
      topic: M1_FIXTURE_TOPIC,
      notes: M1_FIXTURE_NOTES,
      model: 'mock-model',
      salt: SALT,
      seed: 20261013,
    });
    expect(second.status).toBe('completed');
    if (second.status !== 'completed') return;
    expect(second.firstReportTelemetryEmitted).toBe(false);
    expect(harness.emitted).toHaveLength(1);
  });
});

describe('generateReport failure path（mock 恒返 schema 违例 JSON）', () => {
  it('纠偏重试 2 次后 failed；llm_calls 恰 3 条；不落 reports、不发遥测', async () => {
    const harness = makeHarness(() => JSON.stringify({ title: '', summary: '', bullets: [] }));
    const outcome = await generateReport(harness.ports, {
      topic: M1_FIXTURE_TOPIC,
      notes: M1_FIXTURE_NOTES.slice(0, 8),
      model: 'mock-model',
      salt: SALT,
      seed: 1,
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.chapter).toBe('scenarios');
    expect(outcome.reason).toContain('未通过 schema 校验');
    expect(outcome.llmRequestCount).toBe(3);
    expect(harness.llmCallRecords).toHaveLength(3);
    expect(harness.insertedReports).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);
  });
});

describe('聚类路线路由（ADR-7 降级链）', () => {
  it('探针通过（embedTexts 可用）→ 向量路线；⑧章如实标注', async () => {
    const harness = makeHarness((chapter) => validChapterJson(chapter));
    const outcome = await generateReport(harness.ports, {
      topic: M1_FIXTURE_TOPIC,
      notes: M1_FIXTURE_NOTES.slice(0, 8),
      model: 'mock-model',
      salt: SALT,
      embedTexts: async (texts) =>
        texts.map((_, i) => Float32Array.from([i < 4 ? 0 : 10, i < 4 ? 0 : 10, i % 3])),
    });
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.clusterRoute).toBe('vector');
    expect(outcome.report.chapters.methodology.cleaningRules.join('；')).toContain('向量嵌入+KMeans');
  });

  it('embedTexts 中途抛错 → 回落统计聚类并记录原因', async () => {
    const harness = makeHarness((chapter) => validChapterJson(chapter));
    const outcome = await generateReport(harness.ports, {
      topic: M1_FIXTURE_TOPIC,
      notes: M1_FIXTURE_NOTES.slice(0, 8),
      model: 'mock-model',
      salt: SALT,
      embedTexts: async () => {
        throw new Error('embeddings 429');
      },
    });
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.clusterRoute).toBe('statistical');
    expect(outcome.clusterReason).toContain('embeddings 429');
  });
});

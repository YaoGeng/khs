/**
 * 嵌入探针单测（ADR-7：探针成功→kv 记录；失败→24h 冷却；缓存命中省调用）。
 */
import { describe, it, expect } from 'vitest';
import {
  EmbeddingEndpoint,
  CachedEmbedder,
  resolveEmbeddingRoute,
  canRetryProbe,
  sha256Hex,
  KV_EMBEDDING_PROBE_OK,
  KV_EMBEDDING_PROBE_FAIL,
  PROBE_RETRY_COOLDOWN_MS,
} from './embeddings.js';

class MemoryKv {
  private map = new Map<string, unknown>();
  async get(key: string): Promise<unknown | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  dump(): Map<string, unknown> {
    return this.map;
  }
}

function endpointWith(fetchImpl: unknown, provider = 'mock-embedder'): EmbeddingEndpoint {
  return new EmbeddingEndpoint({
    provider,
    baseUrl: 'https://mock.local/v1',
    apiKey: 'sk-test',
    model: 'mock-embedding',
    fetchImpl: fetchImpl as typeof fetch,
  });
}

function embeddingResponse(dim = 4, rows = 1): Response {
  const data = Array.from({ length: rows }, (_, row) => ({
    object: 'embedding',
    index: row,
    embedding: Array.from({ length: dim }, (_, i) => Number((((i + row * 3) % 20) / 10).toFixed(4))),
  }));
  return new Response(
    JSON.stringify({
      object: 'list',
      data,
      model: 'mock-embedding',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('resolveEmbeddingRoute（ADR-7 §3 决策树）', () => {
  it('探针成功：/embeddings 一次调用，kv 记 {provider,dim,probed_at}，route=vector', async () => {
    let calls = 0;
    const kv = new MemoryKv();
    const outcome = await resolveEmbeddingRoute({
      endpoint: endpointWith(async () => {
        calls += 1;
        return embeddingResponse(2048);
      }),
      kv,
    });
    expect(outcome).toMatchObject({ route: 'vector', dim: 2048 });
    expect(calls).toBe(1);
    const okRecord = kv.dump().get(KV_EMBEDDING_PROBE_OK) as Record<string, unknown>;
    expect(okRecord.provider).toBe('mock-embedder');
    expect(okRecord.dim).toBe(2048);
    expect(new Date(String(okRecord.probedAt)).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('kv 已有同 provider 成功记录：不再发请求，route=vector（probe-ok-cached）', async () => {
    const kv = new MemoryKv();
    await kv.set(KV_EMBEDDING_PROBE_OK, { provider: 'mock-embedder', dim: 1024, probedAt: new Date().toISOString() });
    let calls = 0;
    const outcome = await resolveEmbeddingRoute({
      endpoint: endpointWith(async () => {
        calls += 1;
        return embeddingResponse();
      }),
      kv,
    });
    expect(outcome.route).toBe('vector');
    expect(outcome.dim).toBe(1024);
    expect(calls).toBe(0);
  });

  it('探针失败：route=statistical 且 kv 记失败；24h 内第二次不再发请求（不重试探针）', async () => {
    let calls = 0;
    const kv = new MemoryKv();
    const deps = {
      endpoint: endpointWith(async () => {
        calls += 1;
        return new Response('{"error":{"message":"no money"}}', { status: 429, headers: { 'content-type': 'application/json' } });
      }),
      kv,
    };
    const first = await resolveEmbeddingRoute(deps);
    expect(first.route).toBe('statistical');
    expect(first.reason).toContain('probe-failed');
    expect(calls).toBe(1);
    const failRecord = kv.dump().get(KV_EMBEDDING_PROBE_FAIL) as Record<string, unknown>;
    expect(failRecord.provider).toBe('mock-embedder');

    const second = await resolveEmbeddingRoute(deps);
    expect(second).toMatchObject({ route: 'statistical', reason: 'probe-cooldown-24h' });
    expect(calls).toBe(1);
  });

  it('注入时钟跨过 24h：允许重试探针（覆盖「充值/换 Key」场景）', async () => {
    let calls = 0;
    const kv = new MemoryKv();
    let nowMs = 1_700_000_000_000;
    const deps = {
      endpoint: endpointWith(async () => {
        calls += 1;
        return calls === 1
          ? new Response('{"error":{"code":"1113"}}', { status: 429, headers: { 'content-type': 'application/json' } })
          : embeddingResponse(2048);
      }),
      kv,
      now: () => nowMs,
    };
    expect((await resolveEmbeddingRoute(deps)).route).toBe('statistical');
    nowMs += PROBE_RETRY_COOLDOWN_MS - 1_000;
    expect((await resolveEmbeddingRoute(deps)).reason).toBe('probe-cooldown-24h');
    nowMs += 2_000;
    const after = await resolveEmbeddingRoute(deps);
    expect(after).toMatchObject({ route: 'vector', dim: 2048 });
    expect(calls).toBe(2);
  });

  it('canRetryProbe：不同 provider 不受冷却牵连', () => {
    const fail = { provider: 'a', failedAt: new Date().toISOString(), reason: 'x' };
    expect(canRetryProbe(fail, 'b', Date.now())).toBe(true);
    expect(canRetryProbe(fail, 'a', Date.now())).toBe(false);
    expect(canRetryProbe(null, 'a', Date.now())).toBe(true);
  });
});

describe('CachedEmbedder（embeddings_cache 命中优先）', () => {
  const cacheBase = () => {
    const store = new Map<string, { dim: number; vector: Float32Array }>();
    return {
      store,
      cache: {
        async get(provider: string, model: string, sha: string) {
          return store.get(`${provider}|${model}|${sha}`) ?? null;
        },
        async put(provider: string, model: string, sha: string, dim: number, vector: Float32Array) {
          store.set(`${provider}|${model}|${sha}`, { dim, vector });
        },
      },
    };
  };

  it('第二次同文本调用命中缓存，端点零请求', async () => {
    let calls = 0;
    const endpoint = endpointWith(async (_url: unknown, init?: { body?: string }) => {
      calls += 1;
      const body = init?.body ? (JSON.parse(init.body) as { input?: string[] }) : {};
      return embeddingResponse(4, Array.isArray(body.input) ? body.input.length : 1);
    });
    const { store, cache } = cacheBase();
    const embedder = new CachedEmbedder(endpoint, cache);
    const first = await embedder.embedWithCache(['文本甲', '文本乙']);
    expect(calls).toBe(1);
    expect(first).toHaveLength(2);
    const second = await embedder.embedWithCache(['文本甲', '文本乙']);
    expect(calls).toBe(1);
    expect(Array.from(second[0])).toEqual(Array.from(first[0]));
    expect(store.size).toBe(2);
    expect([...store.keys()][0]).toBe(`mock-embedder|mock-embedding|${sha256Hex('文本甲')}`);
  });

  it('部分命中：仅未命中文本进入端点调用', async () => {
    let calls = 0;
    const endpoint = endpointWith(async (_url: unknown, init?: { body?: string }) => {
      calls += 1;
      const body = init?.body ? (JSON.parse(init.body) as { input?: string[] }) : {};
      return embeddingResponse(4, Array.isArray(body.input) ? body.input.length : 1);
    });
    const { store, cache } = cacheBase();
    const embedder = new CachedEmbedder(endpoint, cache);
    await embedder.embedWithCache(['旧文本']);
    await embedder.embedWithCache(['旧文本', '新文本']);
    expect(calls).toBe(2);
    expect(store.size).toBe(2);
  });
});

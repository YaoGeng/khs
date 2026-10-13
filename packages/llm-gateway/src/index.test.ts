import { describe, it, expect } from 'vitest';
import {
  PACKAGE_NAME,
  LlmGateway,
  schemaInjectionForTier,
  followerBucket,
  pseudonymizeAuthor,
  resolveEmbeddingRoute,
  assertGatewayConfig,
} from './index.js';
import type { LlmCallRecord } from './index.js';

describe('llm-gateway 出口（todo 8：stub 变实）', () => {
  it('保留 PACKAGE_NAME 导出（既有消费面不回退）', () => {
    expect(PACKAGE_NAME).toBe('llm-gateway');
  });

  it('调用链与 Port 面具名齐全（组合根接线所需）', () => {
    expect(typeof LlmGateway).toBe('function');
    expect(typeof resolveEmbeddingRoute).toBe('function');
    expect(typeof followerBucket).toBe('function');
    expect(typeof pseudonymizeAuthor).toBe('function');
    expect(schemaInjectionForTier('B')).toEqual(['prompt-embedded-schema', 'regex-extraction-fallback']);
  });

  it('assertGatewayConfig 对缺失字段逐个抛错（Key 缺失不进裸 401）', () => {
    expect(() => assertGatewayConfig({ provider: 'p', baseUrl: 'https://x/v1', apiKey: '', model: 'm' } as never)).toThrow(/apiKey/);
    expect(() => assertGatewayConfig({ provider: 'p', baseUrl: '', apiKey: 'k', model: 'm' } as never)).toThrow(/baseUrl/);
    expect(() => assertGatewayConfig({ provider: 'p', baseUrl: 'https://x/v1', apiKey: 'k', model: '' } as never)).toThrow(/model/);
  });
});

describe('LlmGateway 传输层重试与计量（llm_calls 写入断言）', () => {
  const config = {
    provider: 'mock-provider',
    baseUrl: 'https://mock.local/v1',
    apiKey: 'sk-test',
    model: 'mock-model',
  };

  function chatCompletion(content: string): unknown {
    return {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 0,
      model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    };
  }

  function mockFetchOnce(responder: () => Response, calls: { count: number }): typeof fetch {
    return (async () => {
      calls.count += 1;
      return responder();
    }) as unknown as typeof fetch;
  }

  it('500×2 后成功：3 次请求、退避 400/800ms、sink 记录 3 条（成功条含 tokens/latency）', async () => {
    const calls = { count: 0 };
    const sleeps: number[] = [];
    const records: LlmCallRecord[] = [];
    let n = 0;
    const gateway = new LlmGateway({
      ...config,
      fetchImpl: mockFetchOnce(
        () => {
          n += 1;
          return n <= 2
            ? new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } })
            : new Response(JSON.stringify(chatCompletion('你好')), { status: 200, headers: { 'content-type': 'application/json' } });
        },
        calls,
      ),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      sink: async (record) => {
        records.push(record);
      },
    });
    const result = await gateway.chat({ user: 'hi', traceId: 'trace-1' });
    expect(result.content).toBe('你好');
    expect(result.requestCount).toBe(3);
    expect(calls.count).toBe(3);
    expect(sleeps).toEqual([400, 800]);
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({ traceId: 'trace-1', provider: 'mock-provider', model: 'mock-model', tokensIn: 11, tokensOut: 7 });
    expect(typeof records[2].latencyMs).toBe('number');
    expect(typeof records[2].at).toBe('string');
    // 失败条只计 latency（无 usage）
    expect(records[0].tokensIn).toBeUndefined();
    expect(records[0].latencyMs).toBeTypeOf('number');
  });

  it('400 参数错不重试：1 次请求即抛（llm_calls 也留痕 1 条）', async () => {
    const calls = { count: 0 };
    const records: LlmCallRecord[] = [];
    const gateway = new LlmGateway({
      ...config,
      fetchImpl: mockFetchOnce(
        () => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
        calls,
      ),
      sleep: async () => {
        throw new Error('不应触发退避');
      },
      sink: async (record) => {
        records.push(record);
      },
    });
    await expect(gateway.chat({ user: 'hi' })).rejects.toThrow();
    expect(calls.count).toBe(1);
    expect(records).toHaveLength(1);
  });

  it('定价注入时 cost 按 tokens 计量（BYOK 可选面）', async () => {
    const records: LlmCallRecord[] = [];
    const gateway = new LlmGateway({
      ...config,
      pricing: { inputPer1k: 0.001, outputPer1k: 0.002 },
      fetchImpl: mockFetchOnce(() => new Response(JSON.stringify(chatCompletion('ok')), { status: 200, headers: { 'content-type': 'application/json' } }), { count: 0 }),
      sink: async (record) => {
        records.push(record);
      },
    });
    await gateway.chat({ user: 'hi' });
    expect(records[0].cost).toBeCloseTo((11 / 1000) * 0.001 + (7 / 1000) * 0.002, 8);
  });

  it('sink 抛错不中断调用，计入 sinkErrorCount（组合根巡检面）', async () => {
    const gateway = new LlmGateway({
      ...config,
      fetchImpl: mockFetchOnce(() => new Response(JSON.stringify(chatCompletion('ok')), { status: 200, headers: { 'content-type': 'application/json' } }), { count: 0 }),
      sink: async () => {
        throw new Error('store down');
      },
    });
    const result = await gateway.chat({ user: 'hi' });
    expect(result.content).toBe('ok');
    expect(gateway.sinkErrorCount).toBe(1);
  });
});

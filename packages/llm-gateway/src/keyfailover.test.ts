/**
 * FR-2.4 多 Key 故障转移单测（todo 12；01:129）：
 * 主 Key 401 → 同轮自动切备用（单次逻辑调用成功）；全部 Key 失败 → 每 Key 恰试一次无死循环；
 * onFailover 遥测信息脱敏且逐次递进；403 同触发；退避预算不被鉴权轮换消耗。
 */
import { describe, it, expect } from 'vitest';
import { LlmGateway } from './gateway.js';
import type { GatewayKeyFailoverInfo, GatewayKeyProvider, LlmCallRecord } from './index.js';

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

function authFail(status: number): Response {
  return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status, headers: { 'content-type': 'application/json' } });
}

/** 按请求序号返回脚本化响应；记录每次请求的 Authorization 供断言轮换次序 */
function scriptedFetch(script: Array<{ status: number; body?: unknown }>, seen: string[]): typeof fetch {
  let n = 0;
  return (async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization') ?? '');
    const step = script[Math.min(n, script.length - 1)];
    n += 1;
    if (step.status === 200) {
      return new Response(JSON.stringify(chatCompletion((step.body as string) ?? 'ok')), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return authFail(step.status);
  }) as unknown as typeof fetch;
}

function keyProviderOf(keys: string[], failovers: GatewayKeyFailoverInfo[]): GatewayKeyProvider {
  return {
    list: async () => keys,
    onFailover: (info) => failovers.push(info),
  };
}

describe('FR-2.4 多 Key 故障转移', () => {
  const base = { provider: 'mock-provider', baseUrl: 'https://mock.local/v1', model: 'mock-model' };

  it('主 Key 401 → 同轮自动切备用 Key 成功（单次逻辑调用，请求序 auth=主→备）', async () => {
    const seen: string[] = [];
    const failovers: GatewayKeyFailoverInfo[] = [];
    const gateway = new LlmGateway({
      ...base,
      apiKey: 'sk-primary-aaaa',
      keyProvider: keyProviderOf(['sk-primary-aaaa', 'sk-backup-bbbb'], failovers),
      fetchImpl: scriptedFetch([{ status: 401 }, { status: 200, body: '经备用 Key 成功' }], seen),
      sleep: async () => {
        throw new Error('鉴权轮换不应消耗退避预算');
      },
    });
    const result = await gateway.chat({ user: 'hi', traceId: 't-failover-1' });
    expect(result.content).toBe('经备用 Key 成功');
    expect(result.requestCount).toBe(2);
    expect(seen).toEqual(['Bearer sk-primary-aaaa', 'Bearer sk-backup-bbbb']);
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({
      provider: 'mock-provider',
      failedKeyMasked: 'sk-****aaaa',
      nextKeyMasked: 'sk-****bbbb',
      failedIndex: 0,
      nextIndex: 1,
      total: 2,
    });
    expect(failovers[0].at).toEqual(expect.any(String));
  });

  it('全部 Key 401 → 抛错且每 Key 恰试一次（无死循环；不退避）', async () => {
    const seen: string[] = [];
    const failovers: GatewayKeyFailoverInfo[] = [];
    const gateway = new LlmGateway({
      ...base,
      apiKey: 'sk-primary-aaaa',
      keyProvider: keyProviderOf(['sk-primary-aaaa', 'sk-backup-bbbb', 'sk-backup-cccc'], failovers),
      maxRetries: 2,
      fetchImpl: scriptedFetch([{ status: 401 }], seen),
      sleep: async () => {
        throw new Error('鉴权链不应触发退避');
      },
    });
    await expect(gateway.chat({ user: 'hi' })).rejects.toThrow();
    expect(seen).toHaveLength(3);
    expect(seen).toEqual(['Bearer sk-primary-aaaa', 'Bearer sk-backup-bbbb', 'Bearer sk-backup-cccc']);
    expect(failovers).toHaveLength(2);
    expect(failovers[1]).toMatchObject({ failedIndex: 1, nextIndex: 2, total: 3 });
  });

  it('403 同触发轮换；401 备用也 401 → 主 Key 恰试一次后备Key也恰试一次', async () => {
    const seen: string[] = [];
    const gateway = new LlmGateway({
      ...base,
      apiKey: 'sk-primary-aaaa',
      keyProvider: keyProviderOf(['sk-primary-aaaa', 'sk-backup-bbbb'], []),
      fetchImpl: scriptedFetch([{ status: 403 }, { status: 401 }], seen),
      maxRetries: 2,
      sleep: async () => {
        throw new Error('鉴权链不应触发退避');
      },
    });
    await expect(gateway.chat({ user: 'hi' })).rejects.toThrow();
    expect(seen).toEqual(['Bearer sk-primary-aaaa', 'Bearer sk-backup-bbbb']);
  });

  it('无 keyProvider 时维持单 Key 行为：401 直接抛（不重试不轮换）', async () => {
    const seen: string[] = [];
    const gateway = new LlmGateway({
      ...base,
      apiKey: 'sk-solo-aaaa',
      fetchImpl: scriptedFetch([{ status: 401 }], seen),
      maxRetries: 2,
      sleep: async () => {
        throw new Error('401 非 5xx/429 不应退避');
      },
    });
    await expect(gateway.chat({ user: 'hi' })).rejects.toThrow();
    expect(seen).toEqual(['Bearer sk-solo-aaaa']);
  });

  it('鉴权轮换与传输层重试可叠加：备用 Key 429 一次后成功（退避预算在轮换后重新计）', async () => {
    const seen: string[] = [];
    const sleeps: number[] = [];
    let n = 0;
    const gateway = new LlmGateway({
      ...base,
      apiKey: 'sk-primary-aaaa',
      keyProvider: keyProviderOf(['sk-primary-aaaa', 'sk-backup-bbbb'], []),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '');
        n += 1;
        if (n === 1) return authFail(401);
        if (n === 2) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify(chatCompletion('ok')), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await gateway.chat({ user: 'hi' });
    expect(result.content).toBe('ok');
    expect(seen).toEqual(['Bearer sk-primary-aaaa', 'Bearer sk-backup-bbbb', 'Bearer sk-backup-bbbb']);
    expect(sleeps).toEqual([400]);
  });

  it('structured 走同一轮换链：401→备用后成功且计量进 llm_calls（sink 逐请求留痕）', async () => {
    const seen: string[] = [];
    const records: LlmCallRecord[] = [];
    const gateway = new LlmGateway({
      ...base,
      apiKey: 'sk-primary-aaaa',
      keyProvider: keyProviderOf(['sk-primary-aaaa', 'sk-backup-bbbb'], []),
      strategies: ['prompt-embedded-schema'],
      fetchImpl: scriptedFetch([{ status: 401 }, { status: 200, body: '{"title":"t","summary":"s","bullets":["b"]}' }], seen),
      sink: async (record) => {
        records.push(record);
      },
    });
    const result = await gateway.structured({
      name: 'chapter',
      schema: { type: 'object' },
      user: 'hi',
      parse: (v) => v as { title: string },
    });
    expect(result.value).toEqual({ title: 't', summary: 's', bullets: ['b'] });
    expect(result.requestCount).toBe(2);
    expect(records).toHaveLength(2);
    expect(records[1].tokensIn).toBe(11);
  });
});

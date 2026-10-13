/**
 * 结构化输出三段降级链单测（todo 8 验收①：mock tier 切换；zhipu 档直接跳过 native）。
 * 通过注入 fetch 模拟 OpenAI 兼容端点，断言各档实际发出的请求形态与切换次序。
 */
import { describe, it, expect } from 'vitest';
import { LlmGateway } from './gateway.js';
import { GatewayStructuredError } from './types.js';
import { SCHEMA_INJECTION_DEGRADATION_CHAIN, schemaInjectionForTier } from './presets.js';
import type { LlmCallRecord, GatewayConfig } from './types.js';

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, label: { type: 'string' } },
  required: ['ok', 'label'],
  additionalProperties: false,
} as const;

interface MockCall {
  body: {
    messages?: { role: string; content: string }[];
    response_format?: unknown;
  };
}

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-x',
      object: 'chat.completion',
      created: 0,
      model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeGateway(calls: MockCall[], respond: (call: MockCall, index: number) => Response, extra: Partial<GatewayConfig> = {}): LlmGateway {
  let index = 0;
  return new LlmGateway({
    provider: 'mock',
    baseUrl: 'https://mock.local/v1',
    apiKey: 'sk-test',
    model: 'mock-model',
    sleep: async () => {},
    fetchImpl: (async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as MockCall['body']) : {};
      const call: MockCall = { body };
      calls.push(call);
      return respond(call, index++);
    }) as unknown as typeof fetch,
    ...extra,
  });
}

describe('降级链档位路由（schemaInjectionForTier 实测档驱动）', () => {
  it('A 档：native 段一次成功（请求带 response_format json_schema strict）', async () => {
    const calls: MockCall[] = [];
    const gateway = makeGateway(calls, () => completion('{"ok":true,"label":"原生"}'), { tier: 'A' });
    const result = await gateway.structured({
      user: '给个结论',
      name: 'probe',
      schema: SCHEMA,
      parse: (v) => v as { ok: boolean; label: string },
    });
    expect(result.strategy).toBe('native-json_schema');
    expect(result.requestCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'probe', strict: true, schema: SCHEMA },
    });
  });

  it('A 档 native 返回坏 JSON → 落 prompt-embedded 段成功（第二段请求不含 response_format、含内嵌 schema）', async () => {
    const calls: MockCall[] = [];
    const gateway = makeGateway(
      calls,
      (call) => {
        if (call.body.response_format) return completion('这不是 JSON');
        return completion('{"ok":true,"label":"内嵌段"}');
      },
      { tier: 'A' },
    );
    const result = await gateway.structured({
      user: '给个结论',
      name: 'probe',
      schema: SCHEMA,
      parse: (v) => v as { ok: boolean; label: string },
    });
    expect(result.strategy).toBe('prompt-embedded-schema');
    expect(result.attempts).toEqual([
      { strategy: 'native-json_schema', ok: false, reason: expect.stringContaining('未找到可解析的 JSON'), requestCount: 1 },
      { strategy: 'prompt-embedded-schema', ok: true, requestCount: 1 },
    ]);
    expect(calls[1].body.response_format).toBeUndefined();
    const embeddedPrompt = (calls[1].body.messages ?? []).map((m) => m.content).join('\n');
    expect(embeddedPrompt).toContain('JSON Schema');
    expect(embeddedPrompt).toContain('"ok"');
  });

  it('B 档（zhipu 档语义）：native 直接跳过——全程无 response_format 请求', async () => {
    const calls: MockCall[] = [];
    const gateway = makeGateway(calls, () => completion('{"ok":true,"label":"B档"}'), { tier: 'B' });
    const result = await gateway.structured({
      user: '给个结论',
      name: 'probe',
      schema: SCHEMA,
      parse: (v) => v as { ok: boolean; label: string },
    });
    expect(result.strategy).toBe('prompt-embedded-schema');
    for (const call of calls) {
      expect(call.body.response_format).toBeUndefined();
    }
    expect(calls).toHaveLength(1);
  });

  it('B 档 prompt-embedded 返回噪声 + 围栏 JSON → regex 段提取成功', async () => {
    const calls: MockCall[] = [];
    const gateway = makeGateway(
      calls,
      (call) => {
        const prompt = (call.body.messages ?? []).map((m) => m.content).join('\n');
        if (prompt.includes('JSON Schema')) return completion('抱歉我无法输出 JSON');
        return completion('结论：```json\n{"ok":true,"label":"regex段"}\n```以上');
      },
      { tier: 'B' },
    );
    const result = await gateway.structured({
      user: '给个结论',
      name: 'probe',
      schema: SCHEMA,
      parse: (v) => v as { ok: boolean; label: string },
    });
    expect(result.strategy).toBe('regex-extraction-fallback');
    expect(result.value.label).toBe('regex段');
    expect(result.requestCount).toBe(2);
  });

  it('C 档：仅 regex 段（一次请求）', async () => {
    const calls: MockCall[] = [];
    const gateway = makeGateway(calls, () => completion('前言 {"ok":false,"label":"C档"} 后记'), { tier: 'C' });
    const result = await gateway.structured({
      user: '给个结论',
      name: 'probe',
      schema: SCHEMA,
      parse: (v) => v as { ok: boolean; label: string },
    });
    expect(result.strategy).toBe('regex-extraction-fallback');
    expect(calls).toHaveLength(1);
    expect(result.requestCount).toBe(1);
  });

  it('显式 strategies 覆盖档位（自定义网关实测通道）', async () => {
    const calls: MockCall[] = [];
    const gateway = makeGateway(calls, () => completion('{"ok":true,"label":"覆盖"}'), {
      strategies: ['regex-extraction-fallback'],
    });
    const result = await gateway.structured({
      user: '给个结论',
      name: 'probe',
      schema: SCHEMA,
      parse: (v) => v as { ok: boolean; label: string },
    });
    expect(result.strategy).toBe('regex-extraction-fallback');
    expect(calls).toHaveLength(1);
  });

  it('全段耗尽：抛 GatewayStructuredError 并携带逐段审计（段失败也计量 llm_calls）', async () => {
    const calls: MockCall[] = [];
    const records: LlmCallRecord[] = [];
    const gateway = makeGateway(calls, () => completion('无法输出'), { tier: 'C', sink: async (r) => void records.push(r) });
    await expect(
      gateway.structured({ user: 'x', name: 'probe', schema: SCHEMA, parse: (v) => v as unknown }),
    ).rejects.toBeInstanceOf(GatewayStructuredError);
    expect(calls).toHaveLength(1);
    expect(records).toHaveLength(1);
  });

  it('业务校验（parse 抛错）也触发下一段：A 档 native 段 schema 违例 → prompt-embedded 段接管', async () => {
    const calls: MockCall[] = [];
    const gateway = makeGateway(
      calls,
      (call) => (call.body.response_format ? completion('{"ok":"应为布尔违例","label":""}') : completion('{"ok":true,"label":"校验通过"}')),
      { tier: 'A' },
    );
    const result = await gateway.structured({
      user: 'x',
      name: 'probe',
      schema: SCHEMA,
      parse: (v) => {
        const rec = v as { ok: unknown; label: string };
        if (typeof rec.ok !== 'boolean' || rec.label.length === 0) throw new Error('schema 违例');
        return rec;
      },
    });
    expect(result.strategy).toBe('prompt-embedded-schema');
    expect(result.attempts[0].ok).toBe(false);
    expect(result.attempts[0].reason).toContain('schema 违例');
  });
});

describe('降级链常量防漂移（presets 互链不回退）', () => {
  it('三段顺序与档位映射保持 S4 语义', () => {
    expect(schemaInjectionForTier('A')).toEqual([...SCHEMA_INJECTION_DEGRADATION_CHAIN]);
    expect(schemaInjectionForTier('B')).toEqual(['prompt-embedded-schema', 'regex-extraction-fallback']);
    expect(schemaInjectionForTier('C')).toEqual(['regex-extraction-fallback']);
  });
});

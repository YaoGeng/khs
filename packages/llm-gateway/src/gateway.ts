/**
 * OpenAI 兼容调用链（todo 8 / T-M1-05 ①：openai SDK 指向自定义 base_url，02:153）。
 *
 * - chat：传输层重试/退避（默认含首试 ≤3 次请求；仅网络错误/408/429/5xx 重试，4xx 参数错不重试）；
 * - FR-2.4 多 Key：keyProvider 提供同 provider 候选 Key 时，401/403 单调前进轮换
 *   （每 Key 对鉴权失败恰试一次、不消耗退避预算），经 onFailover 通知组合根发 key_failover 遥测；
 * - FR-2.6 限流：limiter 注入时每次 HTTP 请求前 acquire（超限=排队等待非报错，01:131）；
 * - 每次完成（含失败）请求经注入 sink 计量（trace_id/provider/model/tokens_in/out/cost/latency_ms），
 *   组合根把 sink 接到 store client.insertLlmCall 落 llm_calls；
 * - structured：JSON Schema 三段降级链，按 schemaInjectionForTier 实测档驱动
 *   （A=native→prompt-embedded→regex；B 跳过 native；C 仅 regex），全段耗尽抛 GatewayStructuredError。
 */
import OpenAI from 'openai';
import { APIError } from 'openai';
import { schemaInjectionForTier, type SchemaInjectionStrategy } from './presets.js';
import { parseJsonLoose } from './json.js';
import { GatewayStructuredError, type ChatRequest, type ChatResult, type GatewayConfig, type GatewayKeyFailoverInfo, type LlmCallRecord, type StrategyAttempt, type StructuredRequest, type StructuredResult } from './types.js';

const DEFAULTS = {
  maxRetries: 2,
  timeoutMs: 60_000,
  temperature: 0.2,
  maxTokens: 2048,
  backoffBaseMs: 400,
} as const;

export class LlmGateway {
  /** 按 Key 缓存的 SDK 客户端（FR-2.4 轮换时免重建；Key 全值仅主进程内存） */
  private readonly clients = new Map<string, OpenAI>();
  private readonly config: Required<Pick<GatewayConfig, 'provider' | 'baseUrl' | 'model'>> & GatewayConfig;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** sink 注入方异常计数（llm_calls 写入失败不中断 LLM 调用，但不静默——组合根可巡检） */
  public sinkErrorCount = 0;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.maxRetries = Math.max(0, config.maxRetries ?? DEFAULTS.maxRetries);
    this.sleep = config.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  private clientFor(apiKey: string): OpenAI {
    let client = this.clients.get(apiKey);
    if (!client) {
      client = new OpenAI({
        apiKey,
        baseURL: this.config.baseUrl,
        maxRetries: 0,
        timeout: this.config.timeoutMs ?? DEFAULTS.timeoutMs,
        defaultHeaders: this.config.headers,
        fetch: this.config.fetchImpl,
      });
      this.clients.set(apiKey, client);
    }
    return client;
  }

  private async meter(record: LlmCallRecord): Promise<void> {
    if (!this.config.sink) return;
    try {
      await this.config.sink(record);
    } catch {
      this.sinkErrorCount += 1;
    }
  }

  private costOf(tokensIn: number | undefined, tokensOut: number | undefined): number | undefined {
    const pricing = this.config.pricing;
    if (!pricing || (pricing.inputPer1k == null && pricing.outputPer1k == null)) return undefined;
    const inCost = pricing.inputPer1k != null ? ((tokensIn ?? 0) / 1000) * pricing.inputPer1k : 0;
    const outCost = pricing.outputPer1k != null ? ((tokensOut ?? 0) / 1000) * pricing.outputPer1k : 0;
    return Number((inCost + outCost).toFixed(6));
  }

  /** 传输层退避计划：400ms × 2^attempt（无抖动，保测试确定性） */
  backoffMs(attempt: number): number {
    return DEFAULTS.backoffBaseMs * 2 ** attempt;
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof APIError) {
      if (err.status == null) return true; // APIConnectionError / 超时等网络类
      return err.status === 408 || err.status === 429 || err.status >= 500;
    }
    return true; // 非 SDK 错误（如注入 fetch 抛出的原生网络错误）按可重试处理
  }

  /** FR-2.4 鉴权失败（Key 失效/无权限）——轮换触发条件；403 兼容部分网关的配额拒绝形态 */
  private isAuthError(err: unknown): boolean {
    return err instanceof APIError && (err.status === 401 || err.status === 403);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.user });

    // FR-2.4：候选 Key 每次 chat 拉取一次；keyProvider 缺席/空列表回退单 Key
    const keys = (await this.config.keyProvider?.list()) ?? [];
    if (keys.length === 0) keys.push(this.config.apiKey);
    let keyIndex = 0;

    let requestCount = 0;
    let attempt = 0;
    for (;;) {
      await this.config.limiter?.acquire(); // FR-2.6：超限=排队等待（01:131），非报错
      const started = Date.now();
      requestCount += 1;
      try {
        const completion = await this.clientFor(keys[keyIndex] ?? this.config.apiKey).chat.completions.create(
          {
            model: this.config.model,
            messages,
            temperature: req.temperature ?? this.config.temperature ?? DEFAULTS.temperature,
            max_tokens: req.maxTokens ?? this.config.maxTokens ?? DEFAULTS.maxTokens,
            ...(req.responseFormat !== undefined ? { response_format: req.responseFormat as never } : {}),
          },
          req.headers ? { headers: req.headers } : undefined,
        );
        const latencyMs = Date.now() - started;
        const tokensIn = completion.usage?.prompt_tokens;
        const tokensOut = completion.usage?.completion_tokens;
        await this.meter({
          traceId: req.traceId,
          provider: this.config.provider,
          model: this.config.model,
          tokensIn,
          tokensOut,
          cost: this.costOf(tokensIn, tokensOut),
          latencyMs,
          at: new Date().toISOString(),
        });
        return {
          content: completion.choices[0]?.message?.content ?? '',
          provider: this.config.provider,
          model: this.config.model,
          tokensIn: tokensIn ?? 0,
          tokensOut: tokensOut ?? 0,
          latencyMs,
          requestCount,
        };
      } catch (err) {
        const latencyMs = Date.now() - started;
        await this.meter({
          traceId: req.traceId,
          provider: this.config.provider,
          model: this.config.model,
          latencyMs,
          at: new Date().toISOString(),
        });
        // 审计面：把本次 chat 实际发出的请求数挂到错误对象上（structured attempts 计数用）
        (err as { requestCount?: number }).requestCount = requestCount;
        // FR-2.4：鉴权失败且还有候选 → 单调前进轮换；不消耗退避预算（每 Key 对 401/403 恰试一次）
        if (this.isAuthError(err) && keyIndex + 1 < keys.length) {
          const failover: GatewayKeyFailoverInfo = {
            provider: this.config.provider,
            failedKeyMasked: maskKeyTail(keys[keyIndex] ?? ''),
            nextKeyMasked: maskKeyTail(keys[keyIndex + 1] ?? ''),
            failedIndex: keyIndex,
            nextIndex: keyIndex + 1,
            total: keys.length,
            at: new Date().toISOString(),
          };
          keyIndex += 1;
          this.config.keyProvider?.onFailover?.(failover);
          continue; // 不改 attempt：鉴权轮换不消耗退避预算（每 Key 对 401/403 恰试一次）
        }
        if (attempt >= this.maxRetries || !this.isRetryable(err)) throw err;
        await this.sleep(this.backoffMs(attempt));
        attempt += 1;
      }
    }
  }

  private strategies(): readonly SchemaInjectionStrategy[] {
    return this.config.strategies ?? schemaInjectionForTier(this.config.tier ?? 'B');
  }

  private async chatJson(req: ChatRequest): Promise<{ value: unknown; requestCount: number; tokensIn: number; tokensOut: number }> {
    const result = await this.chat(req);
    return { value: parseJsonLoose(result.content), requestCount: result.requestCount, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
  }

  /**
   * 结构化输出：按降级链逐段尝试，每段一次独立 LLM 调用（各自经 chat 计量/重试）。
   * 段内解析失败或 parse() 抛错（业务校验）→ 记录失败原因进入下一段；全段耗尽抛 GatewayStructuredError。
   */
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const strategies = req.strategies ?? this.strategies();
    const attempts: StrategyAttempt[] = [];
    let totalRequests = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const strategy of strategies) {
      let segmentRequests = 1;
      try {
        let parsed: { value: unknown; requestCount: number; tokensIn: number; tokensOut: number };
        if (strategy === 'native-json_schema') {
          parsed = await this.chatJson({
            system: req.system,
            user: req.user,
            traceId: req.traceId,
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            responseFormat: {
              type: 'json_schema',
              json_schema: { name: req.name, strict: true, schema: req.schema },
            },
          });
        } else if (strategy === 'prompt-embedded-schema') {
          parsed = await this.chatJson({
            system: req.system,
            user: [
              req.user,
              '【输出格式要求】严格只输出一个符合以下 JSON Schema 的 JSON 对象：不要输出解释、前后缀或 Markdown 代码围栏；所有必填字段必须非空。',
              JSON.stringify(req.schema),
            ].join('\n'),
            traceId: req.traceId,
            temperature: req.temperature,
            maxTokens: req.maxTokens,
          });
        } else {
          // regex-extraction-fallback：正文自由生成，客户端花括号配平提取（json.ts）
          parsed = await this.chatJson({
            system: req.system,
            user: `${req.user}\n\n【输出格式要求】在回答中给出一个 JSON 对象（可附带说明文字，但必须包含完整 JSON）。\nSchema 概要：${JSON.stringify(req.schema)}`,
            traceId: req.traceId,
            temperature: req.temperature,
            maxTokens: req.maxTokens,
          });
        }
        totalRequests += parsed.requestCount;
        segmentRequests = parsed.requestCount;
        tokensIn += parsed.tokensIn;
        tokensOut += parsed.tokensOut;
        const value = req.parse(parsed.value);
        attempts.push({ strategy, ok: true, requestCount: parsed.requestCount });
        return { value, strategy, attempts, requestCount: totalRequests, tokensIn, tokensOut };
      } catch (err) {
        const requestCount = (err as { requestCount?: number }).requestCount ?? segmentRequests;
        totalRequests += requestCount;
        attempts.push({ strategy, ok: false, reason: errMessage(err), requestCount });
      }
    }
    throw new GatewayStructuredError(`结构化输出降级链全部失败（${strategies.join('→')}）`, attempts, tokensIn, tokensOut);
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

/** Key 脱敏（与 desktop key-service.maskKey 同形镜像：sk- 前缀保留 + **** + 后 4 位） */
function maskKeyTail(key: string): string {
  if (!key) return '(empty)';
  const last4 = key.slice(-4);
  const prefix = key.startsWith('sk-') ? 'sk-' : '';
  return `${prefix}****${last4}`;
}

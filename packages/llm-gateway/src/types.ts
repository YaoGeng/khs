/**
 * llm-gateway 共享类型（todo 8 / T-M1-05：调用链从 stub 变实）。
 *
 * 边界纪律：本包不 import desktop store——token 计量落 llm_calls、嵌入缓存、探针 kv 位
 * 一律经本文件定义的 Port 接口（LlmCallSink / KvPort / EmbeddingCachePort）由组合根注入
 * （eslint.boundaries.mjs 规则二：业务引擎包只能在主进程组合根装配）。
 */
import type { CapabilityTier, SchemaInjectionStrategy } from './presets.js';

/** llm_calls 单次请求计量记录（字段与 store protocol LlmCallInput 同形，组合根直传 insertLlmCall） */
export interface LlmCallRecord {
  traceId?: string;
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  /** BYOK 各家定价不统一：仅在 GatewayConfig.pricing 显式提供时计算，缺省不下发 */
  cost?: number;
  latencyMs?: number;
  at?: string;
}

/** token 计量出口（组合根接 store client.insertLlmCall；测试接内存收集器） */
export type LlmCallSink = (record: LlmCallRecord) => void | Promise<void>;

/** BYOK 定价（可选）：无定价数据时 cost 不落值（不做成本优化调度——M1 边界） */
export interface GatewayPricing {
  inputPer1k?: number;
  outputPer1k?: number;
}

export interface GatewayConfig {
  /** 计量与 llm_calls 落库用 provider 标识；BYOK 自定义网关可为任意稳定 id（ADR-7 §4 附注：不新增第六预设，矩阵五预设不动） */
  provider: string;
  /** OpenAI 兼容 base_url（02:153「openai SDK 指向自定义 base_url」；FR-2.1 用户可覆盖） */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 能力分档（驱动结构化输出降级链）；自定义网关建议显式传 strategies 覆盖 */
  tier?: CapabilityTier;
  /** 结构化输出降级链覆盖（实测档驱动：schemaInjectionForTier(tier) 的结果或自定义序列） */
  strategies?: readonly SchemaInjectionStrategy[];
  /** 传输层重试次数上限（默认 2，即含首试共 ≤3 次请求；仅网络错误/408/429/5xx 重试） */
  maxRetries?: number;
  /** 单请求超时（默认 60s） */
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  /** 额外请求头（如 coding-agent 网关要求的自定义 User-Agent / x-opencode-session） */
  headers?: Record<string, string>;
  pricing?: GatewayPricing;
  /** 每次完成（含失败）请求的计量落点；默认 no-op。sink 自身异常不中断 LLM 调用，计入 sinkErrorCount */
  sink?: LlmCallSink;
  /** 测试注入的 sleep（退避计数值），默认真实 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** 测试注入 fetch（默认全局 fetch） */
  fetchImpl?: typeof fetch;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system?: string;
  user: string;
  /** 原样透传给 SDK 的 response_format（native-json_schema 档专用；调用方自行保证档位匹配） */
  responseFormat?: unknown;
  traceId?: string;
  temperature?: number;
  maxTokens?: number;
  /** 本次调用附加请求头（叠加在 GatewayConfig.headers 之上） */
  headers?: Record<string, string>;
}

export interface ChatResult {
  content: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** 本方法实际发出的 HTTP 请求数（含传输层重试） */
  requestCount: number;
}

/** 结构化输出单段尝试记录（降级链审计面） */
export interface StrategyAttempt {
  strategy: SchemaInjectionStrategy;
  ok: boolean;
  /** 失败原因（解析失败/校验失败/HTTP 错误类） */
  reason?: string;
  /** 该段实际发出的请求数（含传输层重试） */
  requestCount: number;
}

export interface StructuredRequest<T> {
  system?: string;
  user: string;
  /** JSON Schema 名称（native 档 response_format.json_schema.name 使用） */
  name: string;
  /** 目标 JSON Schema（同时用于 prompt-embedded 档内嵌） */
  schema: Record<string, unknown>;
  /** 把已解析的 unknown 值收敛为业务类型（抛错=本段失败，进入下一段） */
  parse: (value: unknown) => T;
  strategies?: readonly SchemaInjectionStrategy[];
  traceId?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface StructuredResult<T> {
  value: T;
  /** 实际成功的降级段 */
  strategy: SchemaInjectionStrategy;
  /** 全部段尝试记录（含失败段） */
  attempts: StrategyAttempt[];
  /** 实际发出的 HTTP 请求总数（各段含传输层重试） */
  requestCount: number;
  /** 全段累计 token 计量（llm_calls 已逐请求落库，这里是报告级汇总） */
  tokensIn: number;
  tokensOut: number;
}

/** 全部降级段耗尽（或不可恢复错误）时抛出 */
export class GatewayStructuredError extends Error {
  readonly attempts: StrategyAttempt[];
  /** 各失败段累计请求/token（供调用方失败路径统计与计量对账） */
  readonly requestCount: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  constructor(message: string, attempts: StrategyAttempt[], tokensIn = 0, tokensOut = 0) {
    super(message);
    this.name = 'GatewayStructuredError';
    this.attempts = attempts;
    this.requestCount = attempts.reduce((sum, a) => sum + a.requestCount, 0);
    this.tokensIn = tokensIn;
    this.tokensOut = tokensOut;
  }
}

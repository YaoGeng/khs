/**
 * @xinglian/llm-gateway 公共出口（todo 8 / T-M1-05：stub 变实）。
 * presets 常量保留互链并从此处统一再导出（能力矩阵单一事实源不变）。
 */
import type { GatewayConfig, LlmCallRecord } from './types.js';

export const PACKAGE_NAME = 'llm-gateway';

export * from './presets.js';
export { LlmGateway } from './gateway.js';
export { parseJsonLoose, balancedJsonObjects } from './json.js';
export {
  followerBucket,
  pseudonymizeAuthor,
  deidentifyAuthor,
  deidentifyNoteForPayload,
  deidentifyNotesForPayload,
} from './deidentify.js';
export type { DeidentifyOptions, DeidentifiedAuthor, FollowerBucket } from './deidentify.js';
export {
  EmbeddingEndpoint,
  CachedEmbedder,
  resolveEmbeddingRoute,
  canRetryProbe,
  sha256Hex,
  KV_EMBEDDING_PROBE_OK,
  KV_EMBEDDING_PROBE_FAIL,
  PROBE_RETRY_COOLDOWN_MS,
} from './embeddings.js';
export type {
  KvPort,
  EmbeddingCachePort,
  EmbeddingEndpointConfig,
  ProbeOkRecord,
  ProbeFailRecord,
  ProbeDeps,
  EmbeddingProbeOutcome,
  EmbeddingRoute,
} from './embeddings.js';
export { GatewayStructuredError } from './types.js';
export type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  GatewayConfig,
  GatewayPricing,
  GatewayKeyFailoverInfo,
  GatewayKeyProvider,
  GatewayRateLimiter,
  LlmCallRecord,
  LlmCallSink,
  StrategyAttempt,
  StructuredRequest,
  StructuredResult,
} from './types.js';
export { TokenBucketLimiter, composeLimiters } from './ratelimit.js';
export type { TokenBucketOptions } from './ratelimit.js';

/** 便捷构造：内存收集 sink（单测/组合根调试用；生产组合根应接 store client.insertLlmCall） */
export function createMemoryLlmCallSink(): { records: LlmCallRecord[]; sink: (record: LlmCallRecord) => Promise<void> } {
  const records: LlmCallRecord[] = [];
  return {
    records,
    sink: async (record) => {
      records.push(record);
    },
  };
}

/** 组合根装配前的最小配置断言（Key 缺失即抛，防裸 401 泄漏到 UI；keyProvider 候选可替代 apiKey） */
export function assertGatewayConfig(config: GatewayConfig): void {
  if (!config.apiKey && !config.keyProvider) throw new Error('GatewayConfig.apiKey 缺失（BYOK Key 只经内存传入，不入库不入日志）');
  if (!config.baseUrl) throw new Error('GatewayConfig.baseUrl 缺失');
  if (!config.model) throw new Error('GatewayConfig.model 缺失');
}

/**
 * 嵌入接口（ADR-7：运行态一次性探针 + embeddings_cache + 24h 失败冷却）。
 *
 * 本包不直接 import desktop store：kv 位、缓存命中/写入均经下方 Port 接口由组合根注入
 * （kv ↔ store kv_config；EmbeddingCachePort ↔ store upsertEmbedding/knnTopK）。
 * M1 主路线 = 统计聚类（当前无 [实测通过] embeddings 端点）；向量路线仅在探针通过后启用。
 */
import OpenAI from 'openai';
import { createHash } from 'node:crypto';

/** kv_config 键（组合根接 store client kvGet/kvSet） */
export const KV_EMBEDDING_PROBE_OK = 'llm-gateway.embedding.probe.ok';
export const KV_EMBEDDING_PROBE_FAIL = 'llm-gateway.embedding.probe.lastFail';

/** ADR-7 §2-1：探针失败后同一 provider 24h 内不重试（覆盖「用户充值/换 Key」场景靠窗口过期） */
export const PROBE_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface ProbeOkRecord {
  provider: string;
  dim: number;
  probedAt: string;
}

export interface ProbeFailRecord {
  provider: string;
  failedAt: string;
  reason: string;
}

export interface KvPort {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
}

/** 嵌入缓存（组合根接 store：get→按 (provider,model,input_sha256) 查 embeddings_cache；put→upsertEmbedding+vec 索引） */
export interface EmbeddingCachePort {
  get(provider: string, model: string, inputSha256: string): Promise<{ dim: number; vector: Float32Array } | null>;
  put(provider: string, model: string, inputSha256: string, dim: number, vector: Float32Array): Promise<void>;
}

export interface EmbeddingEndpointConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** OpenAI 兼容 /embeddings 端点封装 */
export class EmbeddingEndpoint {
  readonly provider: string;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(config: EmbeddingEndpointConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: 0,
      timeout: config.timeoutMs ?? 30_000,
      defaultHeaders: config.headers,
      fetch: config.fetchImpl,
    });
  }

  async embed(inputs: string[]): Promise<{ vectors: Float32Array[]; dim: number; tokensIn?: number }> {
    const res = await this.client.embeddings.create({ model: this.model, input: inputs });
    const vectors = res.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((row) => Float32Array.from(row.embedding));
    if (vectors.length !== inputs.length) throw new Error(`embeddings 返回行数不匹配（期望 ${inputs.length}，实际 ${vectors.length}）`);
    return { vectors, dim: vectors[0]?.length ?? 0, tokensIn: res.usage?.prompt_tokens };
  }
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 冷却判定：无失败记录 / provider 不同 / 已过 24h → 允许重试探针 */
export function canRetryProbe(lastFail: unknown, provider: string, nowMs: number): boolean {
  const record = asRecord(lastFail);
  if (!record || record.provider !== provider) return true;
  const failedAtMs = Date.parse(String(record.failedAt ?? ''));
  if (!Number.isFinite(failedAtMs)) return true;
  return nowMs - failedAtMs >= PROBE_RETRY_COOLDOWN_MS;
}

export type EmbeddingRoute = 'vector' | 'statistical';

export interface EmbeddingProbeOutcome {
  route: EmbeddingRoute;
  /** 探针成功时回填实测 dim */
  dim?: number;
  /** 走统计聚类的原因（probe-ok-cached / probe-cooldown-24h / probe-failed:<msg>） */
  reason?: string;
}

export interface ProbeDeps {
  endpoint: EmbeddingEndpoint;
  kv: KvPort;
  /** 可注入时钟（测试 24h 边界） */
  now?: () => number;
}

/**
 * ADR-7 §3 决策树：kv 已有该 provider 成功记录 → 向量路线；
 * 24h 内失败过 → 统计聚类不重试；否则实测一次 /embeddings 并回写 kv 成败记录。
 */
export async function resolveEmbeddingRoute(deps: ProbeDeps): Promise<EmbeddingProbeOutcome> {
  const now = deps.now ?? Date.now;
  const okRecord = asRecord(await deps.kv.get(KV_EMBEDDING_PROBE_OK));
  if (okRecord && okRecord.provider === deps.endpoint.provider) {
    return { route: 'vector', dim: Number(okRecord.dim), reason: 'probe-ok-cached' };
  }
  const failRecord = await deps.kv.get(KV_EMBEDDING_PROBE_FAIL);
  if (!canRetryProbe(failRecord, deps.endpoint.provider, now())) {
    return { route: 'statistical', reason: 'probe-cooldown-24h' };
  }
  try {
    const res = await deps.endpoint.embed(['khs embedding probe']);
    await deps.kv.set(KV_EMBEDDING_PROBE_OK, {
      provider: deps.endpoint.provider,
      dim: res.dim,
      probedAt: new Date(now()).toISOString(),
    } satisfies ProbeOkRecord);
    return { route: 'vector', dim: res.dim };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
    await deps.kv.set(KV_EMBEDDING_PROBE_FAIL, {
      provider: deps.endpoint.provider,
      failedAt: new Date(now()).toISOString(),
      reason,
    } satisfies ProbeFailRecord);
    return { route: 'statistical', reason: `probe-failed:${reason}` };
  }
}

/**
 * 带本地缓存的嵌入器：命中 (provider,model,sha256) 直接复用向量；未命中的批量调用后逐条回写缓存。
 * 缓存口异常不阻断嵌入本身（缓存尽力而为；组合根可选择让 put 失败上抛）。
 */
export class CachedEmbedder {
  constructor(
    private readonly endpoint: EmbeddingEndpoint,
    private readonly cache: EmbeddingCachePort,
  ) {}

  async embedWithCache(texts: string[]): Promise<Float32Array[]> {
    const keys = texts.map((t) => sha256Hex(t));
    const results = new Array<Float32Array | null>(texts.length).fill(null);
    const misses: number[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      try {
        const hit = await this.cache.get(this.endpoint.provider, this.endpoint.model, keys[i]);
        if (hit) {
          results[i] = hit.vector;
          continue;
        }
      } catch {
        /* 缓存读失败按未命中处理 */
      }
      misses.push(i);
    }
    if (misses.length > 0) {
      const res = await this.endpoint.embed(misses.map((i) => texts[i]));
      for (let j = 0; j < misses.length; j += 1) {
        const idx = misses[j];
        results[idx] = res.vectors[j];
        try {
          await this.cache.put(this.endpoint.provider, this.endpoint.model, keys[idx], res.dim, res.vectors[j]);
        } catch {
          /* 缓存写失败不阻断 */
        }
      }
    }
    return results as Float32Array[];
  }
}

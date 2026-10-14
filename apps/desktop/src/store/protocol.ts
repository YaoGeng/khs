/**
 * store 请求/响应协议（ADR-8 §7.5 最低要求：自增 id + {id, writeMs, err} 回传 + 调用方超时）。
 * 纯类型模块：worker（utilityProcess 内）与 client（主进程）共用。
 */
import type { RetentionPolicy } from '@xinglian/logger';

export type TaskStatus = 'idle' | 'queued' | 'running' | 'awaiting_user' | 'yielded' | 'paused' | 'suspended' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'running' | 'completed' | 'failed';

/**
 * TaskStatus 值域常量（M1 扩态镜像面：tasks/machine.TASK_STATES 的 store 侧真源；
 * state-mirror.test.ts 断言两者深相等——五面任一漏改即测试红）。
 * worker 用它对 updateTaskStatus / task_events.from_state/to_state 做值域校验。
 */
export const TASK_STATUS_VALUES: readonly TaskStatus[] = [
  'idle',
  'queued',
  'running',
  'awaiting_user',
  'yielded',
  'paused',
  'suspended',
  'completed',
  'failed',
  'cancelled',
];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUS_VALUES as readonly string[]).includes(value);
}

/** 五类日志落库行（logger sink → client → worker → logs 表） */
export interface LogRowInput {
  ts: string;
  level: number;
  levelName: string;
  category: string;
  msg: string;
  traceId?: string;
  spanId?: string;
  payload?: unknown;
  shotPath?: string;
}

export interface LogQueryFilter {
  traceId?: string;
  spanId?: string;
  category?: string;
  /** 默认 100，上限 500（占位级 UI 面） */
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface LogRowView {
  id: number;
  ts: string;
  createdAt: string;
  level: number;
  levelName: string;
  category: string;
  traceId: string | null;
  spanId: string | null;
  msg: string;
  payload: unknown;
}

export interface CreateTaskInput {
  id: string;
  kind: string;
  payload?: unknown;
  priority?: number;
  idempotencyKey?: string;
}

export interface TaskRowView {
  id: string;
  kind: string;
  status: TaskStatus;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStatusInput {
  taskId: string;
  status: TaskStatus;
  at?: string;
  /** XState 快照（task_events.payload_json 携带，供 resume 恢复 actor） */
  machineSnapshot?: unknown;
}

export interface TaskEventInput {
  taskId: string;
  type: string;
  fromState?: string | null;
  toState?: string | null;
  payload?: unknown;
  at?: string;
}

export interface StepInput {
  taskId: string;
  stepId: string;
  seq: number;
  status: StepStatus;
  output?: unknown;
  checkpointAt?: string;
}

export interface StepRowView {
  id: number;
  taskId: string;
  stepId: string;
  seq: number;
  status: StepStatus;
  output: unknown;
  checkpointAt: string | null;
}

export interface TaskEventRowView {
  id: number;
  taskId: string;
  type: string;
  fromState: string | null;
  toState: string | null;
  payload: unknown;
  createdAt: string;
}

/* ------------------------------ 合规留痕（todo 9：FR-1.9 EULA 确认 / FR-12.6 遥测 opt-in） ------------------------------ */

export type ConsentSubject = 'eula' | 'telemetry';

/** 一次同意动作（追加式留痕；确认记录含 eula_version + created_at（=confirmed_at）+ telemetry_consent） */
export interface ConsentInput {
  subject: ConsentSubject;
  /** 'accepted' | 'rejected'（EULA）；'enabled' | 'disabled'（遥测开关） */
  action: string;
  /** EULA 动作必带；遥测动作为空 */
  eulaVersion?: string;
  /** 遥测选择（eula accepted / telemetry 开关行为必带；rejected 为空） */
  telemetryConsent?: boolean;
  /** 留痕时间（ISO；缺省取 worker 当前时间） */
  at?: string;
}

export interface ConsentRowView {
  id: number;
  subject: string;
  action: string;
  eulaVersion: string | null;
  telemetryConsent: boolean | null;
  createdAt: string;
}

/* ------------------------------ M1 store v3（todo 6：notes/reports/llm_calls/circuit/hits/kv/run_stats/embeddings） ------------------------------ */

/** 笔记行 upsert 输入（author/tags/imageUrls 为 JSON 序列化字段；本地最小化保留原文）。
 * 冲突路径按列 COALESCE：缺省字段保留库内现值（部分更新安全，显式清空需传 null 以外不可行——M1 无此场景） */
export interface NoteInput {
  noteId: string;
  title?: string | null;
  content?: string | null;
  author?: unknown;
  likes?: number;
  collects?: number;
  comments?: number;
  tags?: unknown;
  coverUrl?: string | null;
  imageUrls?: unknown;
  publishedAt?: string | null;
  /** 缺省取 worker 当前时间；ON CONFLICT 不覆盖（首采时间语义） */
  collectedAt?: string;
  /** 提供则同步登记 topic_notes（UNIQUE 冲突 DO NOTHING，保留首见 seen_at） */
  topicId?: string;
}

export interface NoteRowView {
  id: number;
  noteId: string;
  title: string | null;
  content: string | null;
  author: unknown;
  likes: number;
  collects: number;
  comments: number;
  tags: unknown;
  coverUrl: string | null;
  imageUrls: unknown;
  publishedAt: string | null;
  collectedAt: string;
}

export interface NoteQueryFilter {
  /** 提供则 JOIN topic_notes 过滤该主题下的笔记 */
  topicId?: string;
  /** 默认 100，上限 500 */
  limit?: number;
  order?: 'asc' | 'desc';
}

/** 报告落库输入（report 为八章节 JSON；gate_state 由 todo 11 闸门推进） */
export interface ReportInput {
  topic: string;
  report: unknown;
  contentMd?: string;
  model?: string;
  tokenCost?: number;
  gateState?: string;
  createdAt?: string;
}

export interface ReportRowView {
  id: number;
  topic: string;
  report: unknown;
  contentMd: string | null;
  model: string | null;
  tokenCost: number | null;
  gateState: string | null;
  createdAt: string;
}

export interface LlmCallInput {
  traceId?: string;
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  latencyMs?: number;
  at?: string;
}

/** llm_calls 行视图（FR-2.5 用量面板聚合数据源；无内容字段——只有计量元数据） */
export interface LlmCallRowView {
  id: number;
  traceId: string | null;
  provider: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
  latencyMs: number | null;
  at: string;
}

export interface LlmCallFilter {
  /** ISO 时间下界（含）；缺省不限 */
  since?: string;
  /** 默认 500，上限 2000 */
  limit?: number;
}

/** 熔断/配额/自检失败事件（只记事件元数据，禁带笔记内容字段——02:354） */
export interface CircuitEventInput {
  kind: string;
  meta?: unknown;
  at?: string;
}

export interface CircuitEventRowView {
  id: number;
  kind: string;
  meta: unknown;
  at: string;
}

export interface CircuitEventFilter {
  kind?: string;
  /** 默认 100，上限 500 */
  limit?: number;
}

export interface KeywordHitInput {
  wordlistVersion: string;
  term: string;
  category?: string;
  topicId?: string;
  at?: string;
}

export interface KeywordHitRowView {
  id: number;
  wordlistVersion: string;
  term: string;
  category: string | null;
  topicId: string | null;
  at: string;
}

export interface KeywordHitFilter {
  topicId?: string;
  term?: string;
  /** 默认 100，上限 500 */
  limit?: number;
}

/** kv 值：字符串（JSON/明文）或 Buffer（safeStorage 密文）；加密与降级审计策略归消费方（todo 10 装配） */
export type KvValue = string | Buffer;

/** 采集 run 计数器输入：增量语义（worker 侧累加，见 upsertCollectRunStats case 注释） */
export interface CollectRunStatsInput {
  runId: string;
  completedUnique?: number;
  duplicate?: number;
  noResult?: number;
  rateLimited?: number;
  captchaConsumed?: number;
}

export interface CollectRunStatsView {
  runId: string;
  completedUnique: number;
  duplicate: number;
  noResult: number;
  rateLimited: number;
  captchaConsumed: number;
}

/** embeddings_cache 行写入（不存原文，只有 sha256）；rowid 由 worker 分配并与 vec 表共享 */
export interface EmbeddingUpsertInput {
  provider: string;
  model: string;
  inputSha256: string;
  /** 须与 embeddings_vec 锁定 dim 一致（单表单 dim，ADR-7 §2-4）；不符由 vec0 拒收报错 */
  dim: number;
  /** float32 向量；Buffer 或 Float32Array（写入前统一转 Buffer 小端字节） */
  vector: Buffer | Float32Array;
  createdAt?: string;
  lastUsedAt?: string;
}

export interface EmbeddingUpsertResult {
  upserted: boolean;
  /** embeddings_cache.id = embeddings_vec.rowid（BigInt，ADR 铁律） */
  rowid: bigint;
}

export interface KnnQuery {
  vector: Buffer | Float32Array;
  /** 默认 5，上限 100 */
  k?: number;
}

export interface KnnHit {
  rowid: bigint;
  /** vec0 KNN 返回欧氏距离 L2 本身（非平方；§7.3 实测注记） */
  distance: number;
  provider: string;
  model: string;
  inputSha256: string;
  dim: number;
}

/** FR-10.3 本地保留口径（provider-matrix §4.2 注记「N 由 M1 定」→ M1 定 N=180 天） */
export const EMBEDDINGS_RETENTION_DAYS = 180;

/* ------------------------------ 请求 ------------------------------ */

interface RequestBase {
  id: number;
}

export type StoreRequest =
  | (RequestBase & { type: 'ping' })
  | (RequestBase & { type: 'insertLogs'; rows: LogRowInput[] })
  | (RequestBase & { type: 'createTask'; task: CreateTaskInput })
  | (RequestBase & { type: 'updateTaskStatus'; update: TaskStatusInput })
  | (RequestBase & { type: 'writeTaskEvent'; event: TaskEventInput })
  | (RequestBase & { type: 'upsertStep'; step: StepInput })
  | (RequestBase & { type: 'getTask'; taskId: string })
  | (RequestBase & { type: 'listTasks'; status?: TaskStatus })
  | (RequestBase & { type: 'listSteps'; taskId: string })
  | (RequestBase & { type: 'listTaskEvents'; taskId: string })
  | (RequestBase & { type: 'queryLogs'; filter: LogQueryFilter })
  | (RequestBase & { type: 'pruneLogs'; policy: RetentionPolicy })
  | (RequestBase & { type: 'putConsent'; consent: ConsentInput })
  | (RequestBase & { type: 'getLatestConsents' })
  | (RequestBase & { type: 'upsertNote'; note: NoteInput })
  | (RequestBase & { type: 'listNotes'; filter: NoteQueryFilter })
  | (RequestBase & { type: 'countNoteSnapshots'; topicId?: string })
  | (RequestBase & { type: 'insertReport'; report: ReportInput })
  | (RequestBase & { type: 'getReport'; reportId: number })
  | (RequestBase & { type: 'insertLlmCall'; call: LlmCallInput })
  | (RequestBase & { type: 'listLlmCalls'; filter: LlmCallFilter })
  | (RequestBase & { type: 'appendCircuitEvent'; event: CircuitEventInput })
  | (RequestBase & { type: 'listCircuitEvents'; filter: CircuitEventFilter })
  | (RequestBase & { type: 'insertKeywordHit'; hit: KeywordHitInput })
  | (RequestBase & { type: 'listKeywordHits'; filter: KeywordHitFilter })
  | (RequestBase & { type: 'kvSet'; key: string; value: KvValue })
  | (RequestBase & { type: 'kvGet'; key: string })
  | (RequestBase & { type: 'kvDel'; key: string })
  | (RequestBase & { type: 'upsertCollectRunStats'; stats: CollectRunStatsInput })
  | (RequestBase & { type: 'getCollectRunStats'; runId: string })
  | (RequestBase & { type: 'upsertEmbedding'; embedding: EmbeddingUpsertInput })
  | (RequestBase & { type: 'knnTopK'; query: KnnQuery })
  | (RequestBase & { type: 'pruneEmbeddingsCache' });

export type StoreRequestType = StoreRequest['type'];

/* ------------------------------ 响应 ------------------------------ */

export interface StoreOkResponse {
  id: number;
  ok: true;
  data: unknown;
  /** worker 侧实写耗时（ADR-8 §7.5 协议字段） */
  writeMs?: number;
}

export interface StoreErrorResponse {
  id: number;
  ok: false;
  /** 稳定错误码：E-STORE-XXX */
  code: string;
  err: string;
  writeMs?: number;
}

export type StoreResponse = StoreOkResponse | StoreErrorResponse;

/** 保留策略形状复用（logger 是类型源；本模块仅类型级依赖） */
export type { RetentionPolicy };

export const STORE_ERROR_CODES = {
  TIMEOUT: 'E-STORE-TIMEOUT',
  WORKER_CRASH: 'E-STORE-WORKER-CRASH',
  WORKER_FAILED: 'E-STORE-WORKER-FAILED',
  BACKPRESSURE: 'E-STORE-BACKPRESSURE',
  HANDSHAKE: 'E-STORE-HANDSHAKE',
  BAD_REQUEST: 'E-STORE-BAD-REQUEST',
  DB: 'E-STORE-DB',
} as const;

/** 控制消息（非 StoreRequest：握手与关闭） */
export type StoreWorkerControl =
  | { type: '__init'; dbFile: string }
  | { type: '__close' };

export interface StoreWorkerInitOk {
  type: '__ready';
  dbFile: string;
  schemaVersion: number;
}

export interface StoreWorkerInitFail {
  type: '__init_fail';
  code: string;
  err: string;
}

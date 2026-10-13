/**
 * store 请求/响应协议（ADR-8 §7.5 最低要求：自增 id + {id, writeMs, err} 回传 + 调用方超时）。
 * 纯类型模块：worker（utilityProcess 内）与 client（主进程）共用。
 */
import type { RetentionPolicy } from '@xinglian/logger';

export type TaskStatus = 'idle' | 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'running' | 'completed' | 'failed';

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
  | (RequestBase & { type: 'getLatestConsents' });

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

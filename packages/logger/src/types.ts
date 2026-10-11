/**
 * 日志类型契约（FR-10.1 五类日志 / 02-系统架构设计.md §10.1-§10.2）。
 *
 * 包边界（docs/dev/工程规范.md）：本包不依赖任何 app；落库等外部去处一律经
 * LogSink 接口注入（desktop 组装时把 store 写入注册为 sink）。
 */

/** FR-10.1 五类日志分类（02 §10.1 表：user_action/automation_step/llm_call/network_meta/system_error） */
export const LOG_CATEGORIES = [
  'user-action',
  'automation-step',
  'llm-call',
  'network-meta',
  'system-error',
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 保留策略（FR-10.3：本地默认 90 天；网络请求元数据 30 天例外，02 §10.1） */
export interface RetentionPolicy {
  localDays: number;
  networkMetaDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { localDays: 90, networkMetaDays: 30 };

/** 结构化日志条目（sink 收到的统一形态；NDJSON 行经 parseLogLine 得到） */
export interface LogEntry {
  ts: string;
  level: number;
  levelName: LogLevel;
  category: LogCategory;
  msg: string;
  traceId?: string;
  spanId?: string;
  /** 业务载荷（llm_call 的 token/成本、automation_step 的截图路径等，02 §10.1 落点列） */
  payload?: unknown;
}

/**
 * 日志去处接口。实现方约定：
 * - write 必须同步且不得抛出（管线 fan-out 对 sink 异常隔离）；
 * - flush/prune/close 可异步；prune 返回删除行数（未知则 -1）。
 */
export interface LogSink {
  readonly name: string;
  write(entry: LogEntry): void;
  flush?(): void | Promise<void>;
  /** 按保留策略清理（store sink → DELETE logs；文件 sink → 删过期 NDJSON） */
  prune?(policy: RetentionPolicy, now?: Date): number | Promise<number>;
  close?(): void | Promise<void>;
}

export interface PruneReport {
  filesDeleted: number;
  sinkRowsDeleted: Record<string, number>;
}

/** trace/span 上下文（02 §10.2：每任务一个 trace_id，步骤级 span_id） */
export interface TraceContext {
  traceId?: string;
  spanId?: string;
}

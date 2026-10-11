/**
 * @xinglian/logger —— pino NDJSON 日志管线（FR-10.1 五类 / 02 §10.1-§10.2 / FR-10.3 保留）。
 *
 * 设计：
 * - pino 是唯一序列化引擎：所有记录经 pino level 过滤 + NDJSON 序列化，写入一个
 *   扇出 Writable（文件按日分档 / 内存环形缓冲 / 外部 sink 由宿主注入）；
 * - 包边界：本包不依赖任何 app；落库等去处经 LogSink 注入（desktop 把 store 写入注册进来）；
 * - trace 贯穿：child({traceId, spanId}) 绑定上下文；span 简化口径 = 入口开 span、出口闭合
 *   （automation-step 两条记录 span:start/span:end + durationMs，02 §10.2）。
 */
import { Writable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { pino, type Logger as PinoLogger } from 'pino';
import { newSpanId, newTraceId } from './ids.js';
import { parseLogLine } from './ndjson.js';
import { enforceRetention } from './retention.js';
import { DEFAULT_RETENTION, LOG_CATEGORIES, type LogCategory, type LogEntry, type LogLevel, type LogSink, type PruneReport, type RetentionPolicy, type TraceContext } from './types.js';

export { LOG_CATEGORIES, DEFAULT_RETENTION } from './types.js';
export type { LogCategory, LogEntry, LogLevel, LogSink, PruneReport, RetentionPolicy, TraceContext } from './types.js';
export { newTraceId, newSpanId } from './ids.js';
export { parseLogLine } from './ndjson.js';
export { enforceRetention, pruneLogFiles } from './retention.js';

export interface LoggerOptions {
  /** NDJSON 文件目录（desktop：userData/logs/）；缺省则仅内存/sink 输出 */
  logsDir?: string;
  /** 注入的外部去处（store sink 等）；文件 sink 由本包按 logsDir 自建 */
  sinks?: LogSink[];
  level?: LogLevel;
  /** 内存环形缓冲上限；0 = 关闭（默认 500） */
  memoryBufferSize?: number;
  retention?: RetentionPolicy;
  /** NDJSON 文件名前缀（app-YYYY-MM-DD.ndjson / network-...；network-meta 走 30 天档） */
  filePrefix?: { local: string; network: string };
}

export interface SpanHandle {
  readonly spanId: string;
  /** span 作用域内的记录出口：携 trace_id+span_id（02 §10.2 瀑布图聚合单位） */
  readonly logger: Logger;
  /** 出口闭合：spanEvent=end + durationMs（status: ok/error/cancelled） */
  end(status?: 'ok' | 'error' | 'cancelled', payload?: unknown): void;
}

export interface Logger {
  readonly categories: typeof LOG_CATEGORIES;
  log(category: LogCategory, level: LogLevel, msg: string, payload?: unknown): void;
  userAction(msg: string, payload?: unknown): void;
  automationStep(msg: string, payload?: unknown): void;
  llmCall(msg: string, payload?: unknown): void;
  networkMeta(msg: string, payload?: unknown): void;
  systemError(msg: string, payload?: unknown): void;
  /** 绑定 trace/span 上下文（字段贯穿后续所有记录） */
  child(ctx: TraceContext): Logger;
  /** 入口开 span、出口闭合（02 §10.2 简化口径） */
  startSpan(name: string, payload?: unknown): SpanHandle;
  /** 最近 N 条内存缓冲（memoryBufferSize>0 时） */
  getBuffer(): LogEntry[];
  /** 保留清理（文件 + sinks.prune 扇出）；宿主负责启动/定时触发 */
  enforceRetention(now?: Date): Promise<PruneReport>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** 按日期分档的追加写：local/network 两类前缀（对应 90/30 天保留档） */
class DailyFileWriter {
  private targets = new Map<string, number>();

  constructor(
    private readonly logsDir: string,
    private readonly prefixes: { local: string; network: string },
  ) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  append(networkClass: boolean, day: string, line: string): void {
    const key = `${networkClass ? 'network' : 'local'}:${day}`;
    let fd = this.targets.get(key);
    if (fd === undefined) {
      const prefix = networkClass ? this.prefixes.network : this.prefixes.local;
      const file = path.join(this.logsDir, `${prefix}-${day}.ndjson`);
      fd = fs.openSync(file, 'a');
      this.targets.set(key, fd);
    }
    fs.writeSync(fd, line);
  }

  close(): void {
    for (const fd of this.targets.values()) {
      try {
        fs.closeSync(fd);
      } catch {
        // 已关闭则忽略
      }
    }
    this.targets.clear();
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const retention = options.retention ?? DEFAULT_RETENTION;
  const level = options.level ?? 'info';
  const bufferSize = options.memoryBufferSize ?? 500;
  const externalSinks = [...(options.sinks ?? [])];
  const memoryBuffer: LogEntry[] = [];
  const prefixes = options.filePrefix ?? { local: 'app', network: 'network' };

  const fileWriter = options.logsDir ? new DailyFileWriter(options.logsDir, prefixes) : null;

  let closed = false;

  // 扇出目标：pino NDJSON 行 → 解析一次 → 文件（按类别路由日期档）/ 内存 / 外部 sinks
  const fanout = new Writable({
    write(chunk: unknown, _encoding, callback) {
      try {
        const line = String(chunk);
        const entry = parseLogLine(line);
        if (entry) {
          if (fileWriter) {
            fileWriter.append(entry.category === 'network-meta', entry.ts.slice(0, 10), line);
          }
          if (bufferSize > 0) {
            memoryBuffer.push(entry);
            if (memoryBuffer.length > bufferSize) memoryBuffer.shift();
          }
          for (const sink of externalSinks) {
            try {
              sink.write(entry);
            } catch {
              // sink 异常隔离：单 sink 故障不阻断日志管线（write 契约）
            }
          }
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });

  const root: PinoLogger = pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: pino.levels.values[label as LogLevel] ?? 30, levelName: label };
      },
    },
  }, fanout);

  /** 构造门面：ctx 绑定到 pino child 链（NDJSON 顶层 trace_id/span_id），五类便捷方法走固定 category */
  function makeFacade(ctx: TraceContext, base: PinoLogger): Logger {
    const bindings: Record<string, string> = {};
    if (ctx.traceId) bindings.trace_id = ctx.traceId;
    if (ctx.spanId) bindings.span_id = ctx.spanId;
    const bound = Object.keys(bindings).length > 0 ? base.child(bindings) : base;

    const emit = (category: LogCategory, logLevel: LogLevel, msg: string, payload?: unknown): void => {
      if (closed) return;
      if (payload !== undefined) {
        bound[logLevel]({ category, payload }, msg);
      } else {
        bound[logLevel]({ category }, msg);
      }
    };

    return {
      categories: LOG_CATEGORIES,
      log: emit,
      userAction: (msg, payload) => emit('user-action', 'info', msg, payload),
      automationStep: (msg, payload) => emit('automation-step', 'info', msg, payload),
      llmCall: (msg, payload) => emit('llm-call', 'info', msg, payload),
      networkMeta: (msg, payload) => emit('network-meta', 'info', msg, payload),
      systemError: (msg, payload) => emit('system-error', 'error', msg, payload),
      child(childCtx) {
        return makeFacade({ ...ctx, ...childCtx }, bound);
      },
      startSpan(name, payload) {
        const spanId = newSpanId();
        const spanLogger = makeFacade({ ...ctx, spanId }, bound);
        spanLogger.automationStep(`span:start:${name}`, {
          spanEvent: 'start',
          spanName: name,
          ...(payload as Record<string, unknown> | undefined),
        });
        const startedAt = Date.now();
        return {
          spanId,
          logger: spanLogger,
          end(status = 'ok', endPayload) {
            spanLogger.automationStep(`span:end:${name}`, {
              spanEvent: 'end',
              spanName: name,
              status,
              durationMs: Date.now() - startedAt,
              ...(endPayload as Record<string, unknown> | undefined),
            });
          },
        };
      },
      getBuffer() {
        return [...memoryBuffer];
      },
      async enforceRetention(now = new Date()) {
        return enforceRetention(options.logsDir ?? '.', retention, externalSinks, now);
      },
      async flush() {
        for (const sink of externalSinks) {
          try {
            await sink.flush?.();
          } catch {
            // flush 失败不阻断 close
          }
        }
      },
      async close() {
        closed = true;
        for (const sink of externalSinks) {
          try {
            await sink.close?.();
          } catch {
            // close 幂等
          }
        }
        fileWriter?.close();
      },
    };
  }

  return makeFacade({}, root);
}

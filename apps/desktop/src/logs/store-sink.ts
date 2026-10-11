/**
 * store 日志落库 sink（组装点）：把 @xinglian/logger 的 LogSink 接口接到 store client。
 * 包边界（工程规范.md）：logger 不依赖 desktop——方向是 desktop 注入 sink。
 * 本文件是 apps/desktop 对 @xinglian/logger 的唯一运行时 import 点（基础设施装配层，
 * 边界规则的例外已与任务卡对齐：todo 11 明确要求 desktop 组装 store 写入为 sink）。
 */
// eslint-disable-next-line no-restricted-imports -- todo 11 指定装配：logger 暴露 sink 接口，desktop 注入 store 写入（基础设施包，非业务包）
import { type LogEntry, type RetentionPolicy } from '@xinglian/logger';
import type { StoreClient, LogRowInput } from '../store';

export interface StoreSinkOptions {
  /** 批次行数上限（≤100，与 worker 单事务上限一致，ADR-8 §7.2） */
  readonly batchRows?: number;
  /** 定时冲刷间隔 ms（默认 1000；日志量小以定时聚合为主） */
  readonly flushIntervalMs?: number;
}

export interface StoreSink {
  readonly name: string;
  /** 本 sink 累计丢批数（超时/崩溃路径；日志类可丢，ADR-8 §7.6） */
  readonly droppedBatches: number;
  readonly pendingCount: number;
  write(entry: LogEntry): void;
  flush(): Promise<void>;
  prune(policy: RetentionPolicy): Promise<number>;
  close(): Promise<void>;
}

/**
 * 批量落库 sink：攒批（≤100 行）+ 定时冲刷；写失败静默计数（日志类可丢，ADR-8 §7.6）。
 * 丢批语义：writeMs 超时/崩溃造成的 reject 不反压日志管线（占位级 UI 以文件/内存为兜底）。
 */
export function createStoreLogSink(store: StoreClient, options: StoreSinkOptions = {}): StoreSink {
  const batchRows = options.batchRows ?? 100;
  const flushIntervalMs = options.flushIntervalMs ?? 1000;
  let pending: LogRowInput[] = [];
  let droppedBatches = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      const result = await store.insertLogs(batch);
      if ('dropped' in result) droppedBatches += 1;
    } catch {
      droppedBatches += 1; // 写失败如实丢批（文件 NDJSON 已留档，不丢日志本体）
    }
  };

  const startTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  };

  const sink: StoreSink = {
    name: 'store',
    droppedBatches: 0,
    pendingCount: 0,
    write(entry: LogEntry): void {
      pending.push({
        ts: entry.ts,
        level: entry.level,
        levelName: entry.levelName,
        category: entry.category,
        msg: entry.msg,
        traceId: entry.traceId,
        spanId: entry.spanId,
        payload: entry.payload,
      });
      if (pending.length >= batchRows) void flush();
      else startTimer();
    },
    async flush(): Promise<void> {
      await flush();
    },
    async prune(policy: RetentionPolicy): Promise<number> {
      const result = await store.pruneLogs(policy);
      return result.localDeleted + result.networkDeleted;
    },
    async close(): Promise<void> {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await flush();
    },
  };
  Object.defineProperty(sink, 'droppedBatches', { get: () => droppedBatches });
  Object.defineProperty(sink, 'pendingCount', { get: () => pending.length });
  return sink;
}

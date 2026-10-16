/**
 * store client（主进程侧异步代理；ADR-8 §6：主进程只持异步代理，不持常驻写连接）。
 *
 * 职责（ADR-8 §7.5/§7.6）：
 * - 请求-应答：自增 id、5s 超时、错误回传（稳定 E-STORE-* 码）；
 * - 背压：in-flight ≤1000——日志类批次超限即丢（可丢），任务/事件类排队（禁止丢）；
 * - worker 崩溃恢复（ADR-8 §8 留给 T11 定义，此处固化）：拒绝全部 in-flight（如实上抛）
 *   → 自动重启 worker 重握手；窗口内连续崩溃超限进入终态失败（防崩溃循环）；
 *   当前批不重放（replay）——丢失面与 ADR-8「日志类可丢、任务类以事件流水可重建」口径一致。
 * 本模块 electron-free（transport 注入），vitest 以内存 transport + 真实 worker 内核直测。
 */
import { STORE_ERROR_CODES, type CircuitEventFilter, type CircuitEventInput, type CircuitEventRowView, type CollectRunStatsInput, type CollectRunStatsView, type ConsentInput, type ConsentRowView, type CreateTaskInput, type EmbeddingUpsertInput, type EmbeddingUpsertResult, type KeywordHitFilter, type KeywordHitInput, type KeywordHitRowView, type KnnHit, type KnnQuery, type LogQueryFilter, type LogRowInput, type LogRowView, type LlmCallFilter, type LlmCallInput, type LlmCallRowView, type NoteInput, type NoteQueryFilter, type NoteRowView, type ReportInput, type ReportRowView, type SourcingCandidateFilter, type SourcingCandidateInput, type SourcingCandidateRowView, type StepInput, type StepRowView, type StoreRequest, type StoreResponse, type TaskEventInput, type TaskEventRowView, type TaskRowView, type TaskStatus, type TaskStatusInput, type KvValue } from './protocol';
import type { RetentionPolicy } from '@xinglian/logger';

export interface StoreTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onExit(handler: (info: { code: number | null }) => void): void;
  kill(): void;
}

export interface StoreClientOptions {
  createTransport: () => StoreTransport;
  dbFile: string;
  requestTimeoutMs?: number;
  maxInFlight?: number;
  /** 崩溃重启策略：窗口内重启次数上限；backoff 从第二次起线性增长 */
  restart?: { maxRestarts: number; windowMs: number; backoffMs: number };
}

export interface StoreStats {
  restarted: number;
  droppedLogBatches: number;
  queuedDurable: number;
}

interface PendingCall {
  readonly id: number;
  readonly message: StoreRequest;
  resolve(value: { data: unknown; writeMs?: number }): void;
  reject(error: StoreClientError): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class StoreClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreClientError';
    this.code = code;
  }
}

const DEFAULTS = {
  requestTimeoutMs: 5000,
  maxInFlight: 1000,
  restart: { maxRestarts: 5, windowMs: 60_000, backoffMs: 250 },
};

export interface StoreClient {
  /** worker 握手完成（返回 schema 版本）；重启重握手后仍为已 resolve 的同一 promise */
  whenReady(): Promise<number>;
  ping(): Promise<{ pong: boolean; version: number }>;
  /** 日志批量写（可丢通道：背压超限返回 { dropped: true }，ADR-8 §7.6 日志类可丢） */
  insertLogs(rows: LogRowInput[]): Promise<{ inserted: number } | { dropped: true }>;
  createTask(task: CreateTaskInput): Promise<{ created: boolean; taskId: string }>;
  updateTaskStatus(update: TaskStatusInput): Promise<{ updated: boolean; taskId: string; status: TaskStatus }>;
  writeTaskEvent(event: TaskEventInput): Promise<{ written: boolean }>;
  upsertStep(step: StepInput): Promise<{ upserted: boolean }>;
  getTask(taskId: string): Promise<TaskRowView | null>;
  listTasks(status?: TaskStatus): Promise<TaskRowView[]>;
  listSteps(taskId: string): Promise<StepRowView[]>;
  listTaskEvents(taskId: string): Promise<TaskEventRowView[]>;
  queryLogs(filter: LogQueryFilter): Promise<LogRowView[]>;
  pruneLogs(policy: RetentionPolicy): Promise<{ localDeleted: number; networkDeleted: number }>;
  /** 合规留痕写（todo 9：EULA 确认/拒绝、遥测开关；durable 通道，禁止丢） */
  putConsent(consent: ConsentInput): Promise<{ written: boolean; id: number }>;
  /** 合规留痕现值（FR-1.9 门态 / FR-12.6 遥测现值的 store 查询入口） */
  getLatestConsents(): Promise<{ eula: ConsentRowView | null; telemetry: ConsentRowView | null }>;
  /* ---- M1 store v3（todo 6）：以下方法均走 durable 通道（任务/业务类禁止丢） ---- */
  /** 笔记 upsert：重复采集仅更新互动 + 追加 FR-4.4 快照；topicId 提供则登记主题（首见保留） */
  upsertNote(note: NoteInput): Promise<{ upserted: boolean; id: number }>;
  listNotes(filter?: NoteQueryFilter): Promise<NoteRowView[]>;
  /** FR-4.4 快照观测面：note_snapshots 行计数（topicId 提供则按主题范围） */
  countNoteSnapshots(topicId?: string): Promise<number>;
  insertReport(report: ReportInput): Promise<{ written: boolean; id: number }>;
  /** 不存在返回 null（getTask 同款语义，不抛） */
  getReport(reportId: number): Promise<ReportRowView | null>;
  insertLlmCall(call: LlmCallInput): Promise<{ written: boolean; id: number }>;
  /** FR-2.5 用量面板数据源（计量元数据行，无内容字段） */
  listLlmCalls(filter?: LlmCallFilter): Promise<LlmCallRowView[]>;
  appendCircuitEvent(event: CircuitEventInput): Promise<{ written: boolean; id: number }>;
  listCircuitEvents(filter?: CircuitEventFilter): Promise<CircuitEventRowView[]>;
  insertKeywordHit(hit: KeywordHitInput): Promise<{ written: boolean; id: number }>;
  listKeywordHits(filter?: KeywordHitFilter): Promise<KeywordHitRowView[]>;
  kvSet(key: string, value: KvValue): Promise<{ set: boolean }>;
  kvGet(key: string): Promise<KvValue | null>;
  kvDel(key: string): Promise<{ deleted: boolean }>;
  /** 增量语义：worker 侧按列累加（采集 DAG 逐步上报） */
  upsertCollectRunStats(stats: CollectRunStatsInput): Promise<{ upserted: boolean }>;
  getCollectRunStats(runId: string): Promise<CollectRunStatsView | null>;
  /** 幂等替换：同 task_id 旧批次先删后插（selection 任务重跑 = 全量替换） */
  insertSourcingCandidates(rows: SourcingCandidateInput[]): Promise<{ inserted: number }>;
  listSourcingCandidates(filter?: SourcingCandidateFilter): Promise<SourcingCandidateRowView[]>;
  /** 嵌入缓存 upsert：rowid 由 worker 分配并与 embeddings_vec 共享（BigInt） */
  upsertEmbedding(embedding: EmbeddingUpsertInput): Promise<EmbeddingUpsertResult>;
  knnTopK(query: KnnQuery): Promise<KnnHit[]>;
  /** last_used_at 超 180 天清理（FR-10.3 口径；调度挂接归既有 retention 模式） */
  pruneEmbeddingsCache(): Promise<{ cacheDeleted: number; vecDeleted: number }>;
  stats(): StoreStats;
  close(): Promise<void>;
}

export function createStoreClient(options: StoreClientOptions): StoreClient {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
  const maxInFlight = options.maxInFlight ?? DEFAULTS.maxInFlight;
  const restartCfg = { ...DEFAULTS.restart, ...options.restart };

  const pending = new Map<number, PendingCall>();
  const durableQueue: PendingCall[] = [];
  let outboundQueue: StoreRequest[] = [];
  let transport: StoreTransport | null = null;
  let nextId = 1;
  let handshaken = false;
  let closing = false;
  let terminallyFailed = false;
  let restartTimestamps: number[] = [];
  const statsState: StoreStats = { restarted: 0, droppedLogBatches: 0, queuedDurable: 0 };

  let readyResolve: ((schemaVersion: number) => void) | null = null;
  let readyReject: ((error: StoreClientError) => void) | null = null;
  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // 无监听者时的 settle（如 close 路径）不产生 unhandled rejection；await whenReady() 的调用方仍能捕获
  void ready.catch(() => {});

  function failAll(code: string, message: string): void {
    for (const call of pending.values()) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(new StoreClientError(code, message));
    }
    pending.clear();
    for (const call of durableQueue) {
      call.reject(new StoreClientError(code, message));
    }
    durableQueue.length = 0;
    statsState.queuedDurable = 0;
  }

  function sendNow(call: PendingCall): void {
    if (handshaken && transport) {
      transport.send(call.message);
    } else {
      outboundQueue.push(call.message);
    }
  }

  function drainDurableQueue(): void {
    while (durableQueue.length > 0 && pending.size < maxInFlight) {
      const call = durableQueue.shift() as PendingCall;
      pending.set(call.id, call);
      sendNow(call);
    }
    statsState.queuedDurable = durableQueue.length;
  }

  let readySettled = false;

  function settleReadyOk(schemaVersion: number): void {
    if (readySettled) return;
    readySettled = true;
    readyResolve?.(schemaVersion);
    readyResolve = null;
    readyReject = null;
  }

  function settleReadyFail(error: StoreClientError): void {
    if (readySettled) return;
    readySettled = true;
    readyReject?.(error);
    readyResolve = null;
    readyReject = null;
  }

  function handleMessage(message: unknown): void {
    if (message && typeof message === 'object' && (message as { type?: string }).type === '__ready') {
      handshaken = true;
      const version = (message as { schemaVersion: number }).schemaVersion;
      settleReadyOk(version);
      // 重启后重握手：冲刷排队消息（幂等——重复 __ready 只 resolve 一次）
      const queue = outboundQueue;
      outboundQueue = [];
      for (const message2 of queue) transport?.send(message2);
      return;
    }
    if (message && typeof message === 'object' && (message as { type?: string }).type === '__init_fail') {
      const fail = message as { code: string; err: string };
      handshaken = false;
      closing = true;
      failAll(fail.code, fail.err);
      settleReadyFail(new StoreClientError(fail.code, fail.err));
      return;
    }
    const response = message as StoreResponse;
    if (!response || typeof response !== 'object' || typeof response.id !== 'number') return;
    const call = pending.get(response.id);
    if (!call) return;
    pending.delete(response.id);
    if (call.timer) clearTimeout(call.timer);
    if (response.ok) {
      call.resolve({ data: response.data, writeMs: response.writeMs });
    } else {
      call.reject(new StoreClientError(response.code, response.err));
    }
    drainDurableQueue();
  }

  function spawnTransport(): void {
    const t = options.createTransport();
    transport = t;
    t.onMessage(handleMessage);
    t.onExit((info) => {
      if (closing) return;
      transport = null;
      handshaken = false;
      statsState.restarted += 1;
      failAll(
        STORE_ERROR_CODES.WORKER_CRASH,
        `store worker 意外退出（exit code=${info.code}）；当前批请求已拒绝，正在重启 worker（崩溃恢复：当前批不重放）`,
      );
      const now = Date.now();
      restartTimestamps = restartTimestamps.filter((ts) => now - ts < restartCfg.windowMs);
      restartTimestamps.push(now);
      if (restartTimestamps.length > restartCfg.maxRestarts) {
        terminallyFailed = true;
        closing = true;
        const message = `store worker 连续崩溃 ${restartTimestamps.length} 次（${restartCfg.windowMs}ms 窗口内），进入终态失败；拒绝新请求，需重启应用`;
        settleReadyFail(new StoreClientError(STORE_ERROR_CODES.WORKER_FAILED, message));
        return;
      }
      const backoff = restartTimestamps.length === 1 ? 0 : restartCfg.backoffMs * (restartTimestamps.length - 1);
      setTimeout(() => {
        if (closing) return;
        spawnTransport();
      }, backoff);
    });
    // __init 是 worker 打开 DB 的唯一信号（先于一切业务请求）
    t.send({ type: '__init', dbFile: options.dbFile });
  }

  spawnTransport();

  function dispatch(
    droppable: boolean,
    build: (id: number) => StoreRequest,
  ): Promise<{ data: unknown; writeMs?: number }> {
    if (closing || terminallyFailed) {
      return Promise.reject(
        new StoreClientError(
          STORE_ERROR_CODES.WORKER_FAILED,
          terminallyFailed ? 'store worker 终态失败，拒绝新请求' : 'store client 已关闭',
        ),
      );
    }
    const id = nextId;
    nextId += 1;
    const call: PendingCall = {
      id,
      message: build(id),
      resolve: () => {},
      reject: () => {},
      timer: undefined,
    };
    const promise = new Promise<{ data: unknown; writeMs?: number }>((resolve, reject) => {
      call.resolve = resolve;
      call.reject = reject;
    });
    call.timer = setTimeout(() => {
      if (pending.get(call.id) === call) {
        pending.delete(call.id);
        call.reject(
          new StoreClientError(
            STORE_ERROR_CODES.TIMEOUT,
            `store 请求超时（${timeoutMs}ms）：type=${call.message.type} id=${call.id}`,
          ),
        );
        drainDurableQueue(); // 超时腾出 in-flight 名额，排队中的任务类请求补位
      }
    }, timeoutMs);

    if (pending.size >= maxInFlight) {
      if (droppable) {
        // 背压：日志类可丢（ADR-8 §7.6）
        statsState.droppedLogBatches += 1;
        if (call.timer) clearTimeout(call.timer);
        return Promise.resolve({ data: { dropped: true } });
      }
      // 任务/事件类禁止丢：排队保序
      durableQueue.push(call);
      statsState.queuedDurable = durableQueue.length;
      return promise;
    }
    pending.set(call.id, call);
    sendNow(call);
    return promise;
  }

  async function unwrap<T>(promise: Promise<{ data: unknown; writeMs?: number }>): Promise<T> {
    const { data } = await promise;
    return data as T;
  }

  return {
    whenReady: () => ready,
    ping: () => unwrap(dispatch(false, (id) => ({ id, type: 'ping' }))),
    insertLogs: (rows: LogRowInput[]) => unwrap<{ inserted: number } | { dropped: true }>(dispatch(true, (id) => ({ id, type: 'insertLogs', rows }))),
    createTask: (task: CreateTaskInput) => unwrap(dispatch(false, (id) => ({ id, type: 'createTask', task }))),
    updateTaskStatus: (update: TaskStatusInput) => unwrap(dispatch(false, (id) => ({ id, type: 'updateTaskStatus', update }))),
    writeTaskEvent: (event: TaskEventInput) => unwrap(dispatch(false, (id) => ({ id, type: 'writeTaskEvent', event }))),
    upsertStep: (step: StepInput) => unwrap(dispatch(false, (id) => ({ id, type: 'upsertStep', step }))),
    getTask: async (taskId: string) => {
      const data = await unwrap<{ task: TaskRowView | null }>(dispatch(false, (id) => ({ id, type: 'getTask', taskId })));
      return data.task;
    },
    listTasks: async (status?: TaskStatus) => {
      const data = await unwrap<{ tasks: TaskRowView[] }>(dispatch(false, (id) => ({ id, type: 'listTasks', status })));
      return data.tasks;
    },
    listSteps: async (taskId: string) => {
      const data = await unwrap<{ steps: StepRowView[] }>(dispatch(false, (id) => ({ id, type: 'listSteps', taskId })));
      return data.steps;
    },
    listTaskEvents: async (taskId: string) => {
      const data = await unwrap<{ events: TaskEventRowView[] }>(dispatch(false, (id) => ({ id, type: 'listTaskEvents', taskId })));
      return data.events;
    },
    queryLogs: async (filter: LogQueryFilter) => {
      const data = await unwrap<{ rows: LogRowView[] }>(dispatch(false, (id) => ({ id, type: 'queryLogs', filter })));
      return data.rows;
    },
    pruneLogs: (policy: RetentionPolicy) => unwrap(dispatch(false, (id) => ({ id, type: 'pruneLogs', policy }))),
    putConsent: (consent: ConsentInput) => unwrap(dispatch(false, (id) => ({ id, type: 'putConsent', consent }))),
    getLatestConsents: async () => {
      const data = await unwrap<{ eula: ConsentRowView | null; telemetry: ConsentRowView | null }>(
        dispatch(false, (id) => ({ id, type: 'getLatestConsents' })),
      );
      return data;
    },
    upsertNote: (note: NoteInput) => unwrap(dispatch(false, (id) => ({ id, type: 'upsertNote', note }))),
    listNotes: async (filter: NoteQueryFilter = {}) => {
      const data = await unwrap<{ notes: NoteRowView[] }>(dispatch(false, (id) => ({ id, type: 'listNotes', filter })));
      return data.notes;
    },
    countNoteSnapshots: async (topicId?: string) => {
      const data = await unwrap<{ count: number }>(dispatch(false, (id) => ({ id, type: 'countNoteSnapshots', topicId })));
      return data.count;
    },
    insertReport: (report: ReportInput) => unwrap(dispatch(false, (id) => ({ id, type: 'insertReport', report }))),
    getReport: async (reportId: number) => {
      const data = await unwrap<{ report: ReportRowView | null }>(dispatch(false, (id) => ({ id, type: 'getReport', reportId })));
      return data.report;
    },
    insertLlmCall: (call: LlmCallInput) => unwrap(dispatch(false, (id) => ({ id, type: 'insertLlmCall', call }))),
    listLlmCalls: async (filter: LlmCallFilter = {}) => {
      const data = await unwrap<{ calls: LlmCallRowView[] }>(dispatch(false, (id) => ({ id, type: 'listLlmCalls', filter })));
      return data.calls;
    },
    appendCircuitEvent: (event: CircuitEventInput) => unwrap(dispatch(false, (id) => ({ id, type: 'appendCircuitEvent', event }))),
    listCircuitEvents: async (filter: CircuitEventFilter = {}) => {
      const data = await unwrap<{ events: CircuitEventRowView[] }>(dispatch(false, (id) => ({ id, type: 'listCircuitEvents', filter })));
      return data.events;
    },
    insertKeywordHit: (hit: KeywordHitInput) => unwrap(dispatch(false, (id) => ({ id, type: 'insertKeywordHit', hit }))),
    listKeywordHits: async (filter: KeywordHitFilter = {}) => {
      const data = await unwrap<{ hits: KeywordHitRowView[] }>(dispatch(false, (id) => ({ id, type: 'listKeywordHits', filter })));
      return data.hits;
    },
    kvSet: (key: string, value: KvValue) => unwrap(dispatch(false, (id) => ({ id, type: 'kvSet', key, value }))),
    kvGet: async (key: string) => {
      const data = await unwrap<{ value: KvValue | null }>(dispatch(false, (id) => ({ id, type: 'kvGet', key })));
      return data.value;
    },
    kvDel: (key: string) => unwrap(dispatch(false, (id) => ({ id, type: 'kvDel', key }))),
    upsertCollectRunStats: (stats: CollectRunStatsInput) => unwrap(dispatch(false, (id) => ({ id, type: 'upsertCollectRunStats', stats }))),
    getCollectRunStats: async (runId: string) => {
      const data = await unwrap<{ stats: CollectRunStatsView | null }>(dispatch(false, (id) => ({ id, type: 'getCollectRunStats', runId })));
      return data.stats;
    },
    insertSourcingCandidates: (rows: SourcingCandidateInput[]) => unwrap<{ inserted: number }>(dispatch(true, (id) => ({ id, type: 'insertSourcingCandidates', rows }))),
    listSourcingCandidates: async (filter?: SourcingCandidateFilter) => {
      const data = await unwrap<{ rows: SourcingCandidateRowView[] }>(dispatch(false, (id) => ({ id, type: 'listSourcingCandidates', filter: filter ?? {} })));
      return data.rows;
    },
    upsertEmbedding: (embedding: EmbeddingUpsertInput) => unwrap(dispatch(false, (id) => ({ id, type: 'upsertEmbedding', embedding }))),
    knnTopK: async (query: KnnQuery) => {
      const data = await unwrap<{ hits: KnnHit[] }>(dispatch(false, (id) => ({ id, type: 'knnTopK', query })));
      return data.hits;
    },
    pruneEmbeddingsCache: () => unwrap(dispatch(false, (id) => ({ id, type: 'pruneEmbeddingsCache' }))),
    stats: () => ({ ...statsState }),
    close: async () => {
      closing = true;
      failAll(STORE_ERROR_CODES.WORKER_FAILED, 'store client 已关闭');
      settleReadyFail(new StoreClientError(STORE_ERROR_CODES.WORKER_FAILED, 'store client 已关闭'));
      transport?.kill();
      transport = null;
    },
  };
}

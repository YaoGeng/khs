/**
 * store client 单测（ADR-8 §7.5/§7.6）：内存 transport 对接**真实 worker 内核**
 * （handleStoreRequest + 真实 better-sqlite3），覆盖请求应答/超时/背压/崩溃重启。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStoreClient, StoreClientError, type StoreClient, type StoreClientOptions, type StoreTransport } from './client';
import { handleStoreRequest } from './worker';
import { openAndMigrate } from './db';
import { STORE_ERROR_CODES, type StoreRequest } from './protocol';
import type { SqliteDatabase } from 'better-sqlite3';

let dir: string;
let db: SqliteDatabase | null = null;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'xinglian-store-'));
});

afterEach(() => {
  db?.close();
  db = null;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 可控假 worker：__init 真实开库迁移；业务请求走 handleStoreRequest（真实内核）。
 * 支持：响应延迟 / 注入错误 / crash()（模拟进程退出）/ reset()（重启后重新握手）。
 */
function makeHarness(): {
  createTransport: () => StoreTransport;
  crash: () => void;
  failNext: (code: string, err: string) => void;
  setDelay: (ms: number) => void;
  setAutoReady: (ready: boolean) => void;
} {
  let messageHandler: ((m: unknown) => void) | null = null;
  let exitHandler: ((info: { code: number | null }) => void) | null = null;
  let injectedError: { code: string; err: string } | null = null;
  let delayMs = 0;
  let autoReady = true;
  let stashedInit: unknown = null;

  const respond = (message: unknown): void => {
    if (delayMs > 0) {
      setTimeout(() => messageHandler?.(message), delayMs);
    } else {
      messageHandler?.(message);
    }
  };

  const processMessage = (message: unknown): void => {
    const envelope = message as { type?: string; dbFile?: string };
    if (envelope.type === '__init') {
      if (!autoReady) {
        stashedInit = message; // 测试可控：暂存握手，稍后放行
        return;
      }
      try {
        db?.close(); // 模拟"新进程"：旧进程句柄已随崩溃消失，不留泄漏句柄
        db = null;
        const opened = openAndMigrate(envelope.dbFile as string);
        db = opened.db;
        respond({ type: '__ready', dbFile: envelope.dbFile, schemaVersion: opened.migration?.toVersion ?? 0 });
      } catch (error) {
        respond({ type: '__init_fail', code: 'E-DB-CORRUPT', err: (error as Error).message });
      }
      return;
    }
    if (envelope.type === '__close') return;
    const request = message as StoreRequest;
    if (injectedError) {
      respond({ id: request.id, ok: false, code: injectedError.code, err: injectedError.err });
      injectedError = null;
      return;
    }
    try {
      const { data, writeMs } = handleStoreRequest(db as SqliteDatabase, request);
      respond({ id: request.id, ok: true, data, writeMs });
    } catch (error) {
      respond({ id: request.id, ok: false, code: STORE_ERROR_CODES.DB, err: (error as Error).message });
    }
  };

  return {
    createTransport(): StoreTransport {
      return {
        send: (message) => {
          setTimeout(() => processMessage(message), 0);
        },
        onMessage: (h) => {
          messageHandler = h;
        },
        onExit: (h) => {
          exitHandler = h;
        },
        kill: () => {},
      };
    },
    crash: () => {
      exitHandler?.({ code: 1 });
    },
    failNext: (code, err) => {
      injectedError = { code, err };
    },
    setDelay: (ms) => {
      delayMs = ms;
    },
    setAutoReady: (ready) => {
      autoReady = ready;
      if (ready && stashedInit) {
        const init = stashedInit;
        stashedInit = null;
        setTimeout(() => processMessage(init), 0);
      }
    },
  };
}

function makeClient(harness: ReturnType<typeof makeHarness>, overrides: Partial<StoreClientOptions> = {}): StoreClient {
  return createStoreClient({
    dbFile: path.join(dir, 'test.db'),
    createTransport: harness.createTransport,
    requestTimeoutMs: 300,
    ...overrides,
  });
}

describe('client 基本链路（真实 worker 内核 + 真实 SQLite）', () => {
  it('握手 + createTask/updateTaskStatus/getTask/insertLogs/queryLogs 全往返', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    const version = await client.whenReady();
    expect(version).toBe(1);

    const created = await client.createTask({ id: 't-1', kind: 'demo' });
    expect(created.created).toBe(true);
    expect((await client.getTask('t-1'))?.status).toBe('idle');
    await client.updateTaskStatus({ taskId: 't-1', status: 'running' });
    expect((await client.getTask('t-1'))?.status).toBe('running');

    await client.insertLogs([{ ts: new Date().toISOString(), level: 30, levelName: 'info', category: 'user-action', msg: 'hi' }]);
    const rows = await client.queryLogs({ category: 'user-action' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.msg).toBe('hi');

    // 步骤 upsert + 事件流水
    await client.upsertStep({ taskId: 't-1', stepId: 's1', seq: 0, status: 'completed', output: { a: 1 }, checkpointAt: 'now' });
    expect(await client.listSteps('t-1')).toHaveLength(1);
    await client.writeTaskEvent({ taskId: 't-1', type: 'TASK_START', fromState: 'idle', toState: 'running' });
    expect(await client.listTaskEvents('t-1')).toHaveLength(1);
    await client.close();
  });

  it('insertLogs 超 100 行分片提交（ADR-8 §7.2 单事务 ≤100 行）', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    await client.whenReady();
    const rows = Array.from({ length: 250 }, (_, i) => ({
      ts: new Date().toISOString(),
      level: 30,
      levelName: 'info',
      category: 'user-action',
      msg: `row-${i}`,
    }));
    const result = await client.insertLogs(rows);
    expect(result).toEqual({ inserted: 250 });
    expect(await client.queryLogs({ limit: 500 })).toHaveLength(250);
    await client.close();
  });

  it('queryLogs 按 trace_id 串联过滤（02 §10.2 查询面）', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    await client.whenReady();
    const ts = new Date().toISOString();
    await client.insertLogs([
      { ts, level: 30, levelName: 'info', category: 'automation-step', msg: 'A1', traceId: 'trace-a' },
      { ts, level: 30, levelName: 'info', category: 'automation-step', msg: 'B1', traceId: 'trace-b' },
      { ts, level: 30, levelName: 'info', category: 'automation-step', msg: 'A2', traceId: 'trace-a' },
    ]);
    const rows = await client.queryLogs({ traceId: 'trace-a' });
    expect(rows.map((r) => r.msg)).toEqual(['A2', 'A1']); // 默认 desc
    await client.close();
  });
});

describe('超时与错误回传（ADR-8 §7.5）', () => {
  it('worker 延迟响应 → E-STORE-TIMEOUT（含 type/id 信息）', async () => {
    const harness = makeHarness();
    harness.setDelay(1000);
    const client = makeClient(harness);
    await client.whenReady();
    const error = await client.ping().then(
      () => 'NO_ERROR',
      (e: StoreClientError) => e,
    );
    expect((error as StoreClientError).code).toBe(STORE_ERROR_CODES.TIMEOUT);
    expect((error as StoreClientError).message).toContain('ping');
    await client.close();
  });

  it('worker 业务错误 → 稳定错误码回传', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    await client.whenReady();
    harness.failNext('E-STORE-DB', 'task not found: ghost');
    await expect(client.getTask('ghost')).rejects.toMatchObject({ code: 'E-STORE-DB' });
    await client.close();
  });

  it('updateTaskStatus 不存在的任务 → worker 侧错误回传（不静默）', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    await client.whenReady();
    await expect(client.updateTaskStatus({ taskId: 'ghost', status: 'cancelled' })).rejects.toMatchObject({
      code: 'E-STORE-DB',
    });
    await client.close();
  });
});

describe('崩溃重启（ADR-8 §8 留给 T11 的策略固化：重启 + 丢当前批，如实上抛）', () => {
  it('exit → in-flight 拒 E-STORE-WORKER-CRASH → 重握手后恢复', async () => {
    const harness = makeHarness();
    const client = makeClient(harness, { restart: { maxRestarts: 3, windowMs: 60_000, backoffMs: 5 } });
    await client.whenReady();
    // 崩溃时有请求在飞：dispatch 后立刻 crash（fake worker 的 setTimeout(0) 响应还没跑）
    const inFlight = client.ping();
    harness.crash();
    await expect(inFlight).rejects.toMatchObject({ code: STORE_ERROR_CODES.WORKER_CRASH });
    expect(client.stats().restarted).toBe(1);
    // 重启后（重握手完成）新请求恢复正常
    await expect(client.ping()).resolves.toMatchObject({ pong: true });
    await client.close();
  });

  it('窗口内连续崩溃超限 → 终态失败 E-STORE-WORKER-FAILED（防崩溃循环）', async () => {
    const harness = makeHarness();
    const client = makeClient(harness, { restart: { maxRestarts: 2, windowMs: 60_000, backoffMs: 5 } });
    await client.whenReady();
    for (let i = 0; i < 3; i += 1) {
      harness.crash();
      await new Promise((r) => setTimeout(r, 15));
    }
    await expect(client.ping()).rejects.toMatchObject({ code: STORE_ERROR_CODES.WORKER_FAILED });
    expect(client.stats().restarted).toBe(3);
    await client.close();
  });
});

describe('背压（ADR-8 §7.6：日志类可丢、任务/事件类禁止丢）', () => {
  it('in-flight 打满：日志批丢弃计数；任务请求排队不丢', async () => {
    // transport 吞掉请求（不响应）制造积压
    const sinkTransport: StoreTransport = {
      send: () => {},
      onMessage: () => {},
      onExit: () => {},
      kill: () => {},
    };
    const client = createStoreClient({
      dbFile: path.join(dir, 'bp.db'),
      createTransport: () => sinkTransport,
      maxInFlight: 2,
      requestTimeoutMs: 300,
    });
    // 2 个 in-flight（永不响应），第 3 个日志批应被丢；a/b 的超时拒绝被捕获（预期内）
    const first = client.createTask({ id: 'a', kind: 'demo' });
    const second = client.createTask({ id: 'b', kind: 'demo' });
    first.catch(() => {});
    second.catch(() => {});
    const dropped = await client.insertLogs([]);
    expect(dropped).toEqual({ dropped: true });
    expect(client.stats().droppedLogBatches).toBe(1);
    // 任务类请求不被丢（排队；超时兜底为 E-STORE-TIMEOUT 而非 dropped）
    const third = client.createTask({ id: 'c', kind: 'demo' });
    await expect(third).rejects.toMatchObject({ code: STORE_ERROR_CODES.TIMEOUT });
    await client.close();
  });
});

describe('握手前排队', () => {
  it('worker 未就绪期间的请求排队，握手完成后补发（不丢）', async () => {
    const harness = makeHarness();
    harness.setAutoReady(false); // 吞掉首次 __init（模拟 worker 启动慢）
    const client = makeClient(harness, { requestTimeoutMs: 2000 });
    const pending = client.ping();
    await new Promise((r) => setTimeout(r, 10));
    harness.setAutoReady(true); // 放行暂存的握手 → __ready → 冲刷排队请求
    await expect(pending).resolves.toMatchObject({ pong: true });
    await client.close();
  });

  it('排队中的请求遇 worker 崩溃同样被拒（未处理即不存在恢复面——诚实语义）', async () => {
    const harness = makeHarness();
    harness.setAutoReady(false);
    const client = makeClient(harness, { requestTimeoutMs: 2000, restart: { maxRestarts: 3, windowMs: 60_000, backoffMs: 5 } });
    const pending = client.ping();
    await new Promise((r) => setTimeout(r, 10));
    harness.crash(); // 排队请求从未被 worker 处理 → 崩溃即如实拒绝
    await expect(pending).rejects.toMatchObject({ code: STORE_ERROR_CODES.WORKER_CRASH });
    await client.close();
  });
});

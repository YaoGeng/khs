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
    expect(version).toBe(3);

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

    // todo 9：consent 留痕往返（写 → 现值读回；版本号/时间戳/遥测字段齐）
    const written = await client.putConsent({
      subject: 'eula',
      action: 'accepted',
      eulaVersion: '0.1.0-draft',
      telemetryConsent: true,
      at: '2026-10-11T00:00:00.000Z',
    });
    expect(written.written).toBe(true);
    const consents = await client.getLatestConsents();
    expect(consents.eula).toMatchObject({
      subject: 'eula',
      action: 'accepted',
      eulaVersion: '0.1.0-draft',
      telemetryConsent: true,
      createdAt: '2026-10-11T00:00:00.000Z',
    });
    expect(consents.telemetry).toMatchObject({ subject: 'eula', telemetryConsent: true });

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

describe('store v3 五面同步 e2e（M1 todo 6：client 新方法逐个走通到 worker case）', () => {
  it('notes（upsert+快照+主题）/reports/llm_calls/circuit_events/keyword_hits/kv/collect_run_stats 全往返', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    await client.whenReady();

    // notes：首次 upsert + 主题登记
    const first = await client.upsertNote({
      noteId: 'n-1',
      title: '标题',
      content: '正文',
      author: { nickname: 'a1', fans: 120 },
      likes: 5,
      collects: 2,
      comments: 1,
      tags: ['护肤'],
      coverUrl: 'https://img/c.webp',
      imageUrls: ['https://img/1.webp'],
      publishedAt: '2026-10-01T00:00:00.000Z',
      topicId: 'topic-a',
    });
    expect(first.upserted).toBe(true);
    expect(typeof first.id).toBe('number');
    // 重复采集：notes 行数不增、互动更新、快照追加、第二个主题登记
    await client.upsertNote({ noteId: 'n-1', likes: 9, collects: 4, comments: 2, topicId: 'topic-b' });
    const byA = await client.listNotes({ topicId: 'topic-a' });
    const byB = await client.listNotes({ topicId: 'topic-b' });
    const all = await client.listNotes({});
    expect(byA).toHaveLength(1);
    expect(byB).toHaveLength(1);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ noteId: 'n-1', likes: 9, collects: 4, comments: 2 });
    expect(all[0]?.author).toEqual({ nickname: 'a1', fans: 120 });
    expect(all[0]?.tags).toEqual(['护肤']);
    expect(all[0]?.collectedAt).toBeTruthy();

    // reports：insert → get（JSON 保真）；不存在 → null
    const reportId = await client.insertReport({
      topic: '防晒霜',
      report: { chapters: ['①场景聚类'], meta: { sampleSize: 20 } },
      contentMd: '# 一、场景聚类',
      model: 'glm-4.7-flash',
      tokenCost: 1234,
      gateState: 'pending',
    });
    expect(reportId.written).toBe(true);
    const got = await client.getReport(reportId.id);
    expect(got).toMatchObject({ topic: '防晒霜', model: 'glm-4.7-flash', tokenCost: 1234, gateState: 'pending' });
    expect(got?.report).toEqual({ chapters: ['①场景聚类'], meta: { sampleSize: 20 } });
    expect(await client.getReport(999_999)).toBeNull();

    // llm_calls 计量
    const call = await client.insertLlmCall({
      traceId: 'tr-llm-1',
      provider: 'zhipu',
      model: 'glm-4.7-flash',
      tokensIn: 100,
      tokensOut: 50,
      cost: 0.01,
      latencyMs: 800,
    });
    expect(call.written).toBe(true);

    // circuit_events：追加 + 过滤（kind 不符的行不混入）
    await client.appendCircuitEvent({ kind: 'circuit_open', meta: { reason: 'captcha_feature' } });
    await client.appendCircuitEvent({ kind: 'quota_exhausted', meta: { used: 300 } });
    const opens = await client.listCircuitEvents({ kind: 'circuit_open' });
    expect(opens).toHaveLength(1);
    expect(opens[0]?.meta).toEqual({ reason: 'captcha_feature' });

    // keyword_hits：写入 + 按 topic 过滤
    await client.insertKeywordHit({ wordlistVersion: '0.1.0', term: '全网最低价', category: 'ad-law', topicId: 'topic-a' });
    await client.insertKeywordHit({ wordlistVersion: '0.1.0', term: '别再乱买了', topicId: 'topic-b' });
    const hitsA = await client.listKeywordHits({ topicId: 'topic-a' });
    expect(hitsA).toHaveLength(1);
    expect(hitsA[0]).toMatchObject({ term: '全网最低价', category: 'ad-law', wordlistVersion: '0.1.0' });

    // kv：string 覆盖写、Buffer（safeStorage 密文形态）往返、del 幂等语义
    await client.kvSet('probe:zhipu', JSON.stringify({ provider: 'zhipu', dim: 2048 }));
    await client.kvSet('probe:zhipu', 'v2-overwrite');
    expect(await client.kvGet('probe:zhipu')).toBe('v2-overwrite');
    await client.kvSet('key:zhipu', Buffer.from([0x01, 0x02, 0x03]));
    const cipher = await client.kvGet('key:zhipu');
    expect(Buffer.isBuffer(cipher)).toBe(true);
    expect((cipher as Buffer).equals(Buffer.from([0x01, 0x02, 0x03]))).toBe(true);
    expect((await client.kvDel('key:zhipu')).deleted).toBe(true);
    expect((await client.kvDel('key:zhipu')).deleted).toBe(false);
    expect(await client.kvGet('missing-key')).toBeNull();

    // collect_run_stats：增量累加语义（两次 upsert 同 run 求和）；未写列保持 0
    await client.upsertCollectRunStats({ runId: 'r-1', completedUnique: 10, duplicate: 1 });
    await client.upsertCollectRunStats({ runId: 'r-1', duplicate: 2, noResult: 3 });
    const stats = await client.getCollectRunStats('r-1');
    expect(stats).toEqual({
      runId: 'r-1',
      completedUnique: 10,
      duplicate: 3,
      noResult: 3,
      rateLimited: 0,
      captchaConsumed: 0,
    });
    expect(await client.getCollectRunStats('ghost-run')).toBeNull();

    await client.close();
  });

  it('embeddings upsert（BigInt rowid）+ KNN top2 + pruneEmbeddingsCache（180 天口径）', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    await client.whenReady();
    const vec = (v: number[]): Float32Array => {
      const a = new Float32Array(2048);
      a.set(v);
      return a;
    };
    const sha = (c: string): string => c.repeat(64);

    // 三条嵌入：rowid BigInt；重复 upsert 同一 sha → 同 rowid（缓存命中不换行）
    const e1 = await client.upsertEmbedding({ provider: 'zhipu', model: 'embedding-3', inputSha256: sha('a'), dim: 2048, vector: vec([1, 0]) });
    expect(typeof e1.rowid).toBe('bigint');
    const e1again = await client.upsertEmbedding({ provider: 'zhipu', model: 'embedding-3', inputSha256: sha('a'), dim: 2048, vector: vec([1, 0]) });
    expect(e1again.rowid).toBe(e1.rowid);
    await client.upsertEmbedding({ provider: 'zhipu', model: 'embedding-3', inputSha256: sha('b'), dim: 2048, vector: vec([0, 1]) });
    await client.upsertEmbedding({ provider: 'zhipu', model: 'embedding-3', inputSha256: sha('c'), dim: 2048, vector: vec([0.9, 0.1]) });

    // KNN：top2 = 自身(距离0) + 次近；元数据 JOIN 保真
    const top2 = await client.knnTopK({ vector: vec([1, 0]), k: 2 });
    expect(top2).toHaveLength(2);
    expect(top2[0]?.inputSha256).toBe(sha('a'));
    expect(top2[0]?.distance).toBe(0);
    expect(top2[0]?.provider).toBe('zhipu');
    expect(top2[0]?.dim).toBe(2048);
    expect(top2[1]?.inputSha256).toBe(sha('c'));

    // prune：把 sha('b') 的 last_used_at 拨到 180 天以前 → 清理且 vec 行同删
    const rawDb = db as SqliteDatabase;
    rawDb.prepare('UPDATE embeddings_cache SET last_used_at = ? WHERE input_sha256 = ?').run('2020-01-01T00:00:00.000Z', sha('b'));
    const pruned = await client.pruneEmbeddingsCache();
    expect(pruned).toEqual({ cacheDeleted: 1, vecDeleted: 1 });
    const afterPrune = await client.knnTopK({ vector: vec([1, 0]), k: 5 });
    expect(afterPrune.map((h) => h.inputSha256).sort()).toEqual([sha('a'), sha('c')].sort());

    await client.close();
  });
});

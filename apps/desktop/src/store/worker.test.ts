/**
 * store worker 内核 + 落库 sink 单测：五类日志落库、保留清理（30/90 天差动）、
 * sink 攒批冲刷。真实 better-sqlite3（electron-as-node ABI 130）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleStoreRequest, MAX_BATCH_ROWS } from './worker';
import { openAndMigrate } from './db';
import type { StoreRequest, LogRowInput } from './protocol';
import { createStoreLogSink } from '../logs/store-sink';
// eslint-disable-next-line no-restricted-imports -- todo 11：LogEntry 类型源=logger 基础设施包（边界例外已记录于证据文件）
import type { LogEntry } from '@xinglian/logger';
import type { SqliteDatabase } from 'better-sqlite3';

let dir: string;
let db: SqliteDatabase;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'xinglian-worker-'));
  db = openAndMigrate(path.join(dir, 'w.db')).db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(over: Partial<LogRowInput> = {}): LogRowInput {
  return { ts: new Date().toISOString(), level: 30, levelName: 'info', category: 'user-action', msg: 'm', ...over };
}

describe('worker 内核（真实 DB）', () => {
  it('insertLogs 落库 + queryLogs 回读（trace/span/payload 保真）', () => {
    const request: StoreRequest = {
      id: 1,
      type: 'insertLogs',
      rows: [row({ category: 'automation-step', traceId: 'tr-1', spanId: 'sp-1', payload: { a: 1 } })],
    };
    const { data, writeMs } = handleStoreRequest(db, request);
    expect((data as { inserted: number }).inserted).toBe(1);
    expect(writeMs).toBeGreaterThanOrEqual(0);
    const read = handleStoreRequest(db, { id: 2, type: 'queryLogs', filter: { traceId: 'tr-1' } });
    const rows = (read.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spanId).toBe('sp-1');
    expect(rows[0]?.payload).toEqual({ a: 1 });
  });

  it(`单批 ${MAX_BATCH_ROWS * 2 + 1} 行 → 分片事务（每片 ≤${MAX_BATCH_ROWS}）`, () => {
    const total = MAX_BATCH_ROWS * 2 + 1;
    const rows = Array.from({ length: total }, (_, i) => row({ msg: `r${i}` }));
    const { data } = handleStoreRequest(db, { id: 3, type: 'insertLogs', rows });
    expect((data as { inserted: number }).inserted).toBe(total);
    expect((handleStoreRequest(db, { id: 4, type: 'queryLogs', filter: { limit: 500 } }).data as { rows: unknown[] }).rows).toHaveLength(total);
  });

  it('pruneLogs：network-meta 30 天、其余 90 天差动清理', () => {
    const now = new Date('2026-10-11T00:00:00Z');
    const iso = (daysAgo: number): string => new Date(now.getTime() - daysAgo * 86400000).toISOString();
    handleStoreRequest(db, {
      id: 5,
      type: 'insertLogs',
      rows: [
        row({ category: 'user-action', msg: 'old-local', ts: iso(100) }),
        row({ category: 'user-action', msg: 'new-local', ts: iso(10) }),
        row({ category: 'network-meta', msg: 'old-net', ts: iso(40) }),
        row({ category: 'network-meta', msg: 'new-net', ts: iso(5) }),
      ],
    });
    // pruneLogs 直接以当前时间计算——传 100/40 天前的时间戳，直接调用即可（不用注入时钟：数据已按天数差构造）
    const { data } = handleStoreRequest(db, { id: 6, type: 'pruneLogs', policy: { localDays: 90, networkMetaDays: 30 } });
    expect(data).toMatchObject({ localDeleted: 1, networkDeleted: 1 });
    const remaining = (handleStoreRequest(db, { id: 7, type: 'queryLogs', filter: { limit: 500, order: 'asc' } }).data as { rows: Array<{ msg: string }> }).rows;
    expect(remaining.map((r) => r.msg).sort()).toEqual(['new-local', 'new-net']);
  });

  it('getTask 不存在 → task:null（不抛）；updateTaskStatus 不存在 → 抛（调用方转错误响应）', () => {
    expect((handleStoreRequest(db, { id: 8, type: 'getTask', taskId: 'ghost' }).data as { task: unknown }).task).toBeNull();
    expect(() => handleStoreRequest(db, { id: 9, type: 'updateTaskStatus', update: { taskId: 'ghost', status: 'cancelled' } })).toThrow(/task not found/);
  });
});

describe('consent 留痕内核（todo 9 / FR-1.9+FR-12.6）', () => {
  it('putConsent → getLatestConsents：eula 现值=最新一行；遥测现值=telemetry_consent 非空最新一行', () => {
    handleStoreRequest(db, {
      id: 10,
      type: 'putConsent',
      consent: { subject: 'eula', action: 'accepted', eulaVersion: '0.1.0-draft', telemetryConsent: true, at: '2026-10-11T00:00:00.000Z' },
    });
    handleStoreRequest(db, {
      id: 11,
      type: 'putConsent',
      consent: { subject: 'telemetry', action: 'disabled', telemetryConsent: false, at: '2026-10-11T01:00:00.000Z' },
    });

    const latest = handleStoreRequest(db, { id: 12, type: 'getLatestConsents' }).data as {
      eula: { action: string; eulaVersion: string | null; createdAt: string } | null;
      telemetry: { action: string; telemetryConsent: boolean | null } | null;
    };
    expect(latest.eula).toMatchObject({ action: 'accepted', eulaVersion: '0.1.0-draft', createdAt: '2026-10-11T00:00:00.000Z' });
    expect(latest.telemetry).toMatchObject({ action: 'disabled', telemetryConsent: false });

    // 最新动作覆盖：再次接受（版本升级重确认）→ eula 现值翻转，遥测开/关行不动 eula 行
    handleStoreRequest(db, {
      id: 13,
      type: 'putConsent',
      consent: { subject: 'eula', action: 'accepted', eulaVersion: '0.2.0-draft', telemetryConsent: false, at: '2026-10-11T02:00:00.000Z' },
    });
    const after = handleStoreRequest(db, { id: 14, type: 'getLatestConsents' }).data as {
      eula: { eulaVersion: string | null; telemetryConsent: boolean | null } | null;
      telemetry: { telemetryConsent: boolean | null } | null;
    };
    expect(after.eula?.eulaVersion).toBe('0.2.0-draft');
    expect(after.telemetry?.telemetryConsent).toBe(false);

    // 拒绝行不带遥测选择 → 遥测现值不被覆盖（保持 false）
    handleStoreRequest(db, { id: 15, type: 'putConsent', consent: { subject: 'eula', action: 'rejected', eulaVersion: '0.2.0-draft', at: '2026-10-11T03:00:00.000Z' } });
    const rejected = handleStoreRequest(db, { id: 16, type: 'getLatestConsents' }).data as {
      eula: { action: string; telemetryConsent: unknown } | null;
      telemetry: { telemetryConsent: boolean | null } | null;
    };
    expect(rejected.eula?.action).toBe('rejected');
    expect(rejected.eula?.telemetryConsent).toBeNull();
    expect(rejected.telemetry?.telemetryConsent).toBe(false);
  });

  it('空表 → getLatestConsents 双 null（首启态）', () => {
    const latest = handleStoreRequest(db, { id: 17, type: 'getLatestConsents' }).data as { eula: unknown; telemetry: unknown };
    expect(latest.eula).toBeNull();
    expect(latest.telemetry).toBeNull();
  });
});

describe('落库 sink（组装点）', () => {
  it('攒批：不满批不落库、flush 后落库、prune 走 store', async () => {
    const sent: Array<{ id: number; type: string; rows?: LogRowInput[]; policy?: unknown }> = [];
    const fakeStore = {
      insertLogs: async (rows: LogRowInput[]) => {
        sent.push({ id: sent.length, type: 'insertLogs', rows });
        return { inserted: rows.length };
      },
      pruneLogs: async (policy: unknown) => {
        sent.push({ id: sent.length, type: 'pruneLogs', policy });
        return { localDeleted: 3, networkDeleted: 2 };
      },
    } as unknown as Parameters<typeof createStoreLogSink>[0];

    const sink = createStoreLogSink(fakeStore, { batchRows: 3, flushIntervalMs: 60_000 });
    sink.write(row({ msg: 'a' }) as LogEntry);
    sink.write(row({ msg: 'b' }) as LogEntry);
    expect(sink.pendingCount).toBe(2); // 未满批，未发送
    sink.write(row({ msg: 'c' }) as LogEntry); // 满批 → 立即冲刷
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.pendingCount).toBe(0);
    expect(sent).toHaveLength(1);

    const pruned = await sink.prune({ localDays: 90, networkMetaDays: 30 });
    expect(pruned).toBe(5);
    await sink.close();
  });
});

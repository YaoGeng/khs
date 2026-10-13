/**
 * store v3 采集相关守卫（m1-insight-plan todo 7 验收⑧ + 门禁①计数面）：
 * - upsertNote 三语句同事务回归守卫（评审 MAJOR 修复：中途失败整体回滚，
 *   杜绝「notes 已写而快照/主题登记缺失」半行状态；样板同 upsertEmbedding）；
 * - 重复采集语义：notes 行数不增 + note_snapshots 追加（FR-4.4）+ countNoteSnapshots 观测面。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleStoreRequest } from './worker';
import { openAndMigrate } from './db';
import type { StoreRequest } from './protocol';
import type { SqliteDatabase } from 'better-sqlite3';

let dir: string;
let db: SqliteDatabase;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'xinglian-collect-guard-'));
  db = openAndMigrate(path.join(dir, 'guard.db')).db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function run<T>(request: StoreRequest): T {
  return handleStoreRequest(db, request).data as T;
}

function counts(): { notes: number; snapshots: number; topicNotes: number } {
  const one = (sql: string): number => Number((db.prepare(sql).get() as { c: number }).c);
  return {
    notes: one('SELECT COUNT(*) AS c FROM notes'),
    snapshots: one('SELECT COUNT(*) AS c FROM note_snapshots'),
    topicNotes: one('SELECT COUNT(*) AS c FROM topic_notes'),
  };
}

describe('upsertNote 事务守卫（评审 MAJOR 回归）', () => {
  it('spy 断言三语句在 db.transaction 内执行（事务包裹）', () => {
    let transactionCalls = 0;
    const originalTransaction = db.transaction.bind(db);
    const spyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (fn: () => unknown) => {
            const wrapped = originalTransaction(fn);
            return () => {
              transactionCalls += 1;
              return wrapped();
            };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as SqliteDatabase;

    const result = handleStoreRequest(spyDb, {
      id: 1,
      type: 'upsertNote',
      note: { noteId: 'abc', title: 'T', likes: 1, topicId: 'topic-1' },
    });
    expect(result.data).toMatchObject({ upserted: true });
    expect(transactionCalls, 'upsertNote 必须恰好包一个事务').toBe(1);
  });

  it('mid-crash 注入：topic_notes 登记失败 → notes/snapshots 全部回滚（真库行为级守卫）', () => {
    // 首条正常入库（建立基线）
    run({ id: 1, type: 'upsertNote', note: { noteId: 'n0', title: 'ok', likes: 1, topicId: 'topic-1' } });
    expect(counts()).toEqual({ notes: 1, snapshots: 1, topicNotes: 1 });

    // 注入 topic_notes 写入失败（模拟 mid-crash）→ 整体回滚：notes/snapshots 不得残留
    const originalPrepare = db.prepare.bind(db);
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('topic_notes')) {
              throw new Error('SQLITE_FULL: simulated mid-crash');
            }
            return originalPrepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as SqliteDatabase;

    expect(() =>
      handleStoreRequest(failingDb, {
        id: 2,
        type: 'upsertNote',
        note: { noteId: 'n1', title: 'will-rollback', likes: 2, topicId: 'topic-1' },
      }),
    ).toThrow(/simulated mid-crash/);

    expect(counts()).toEqual({ notes: 1, snapshots: 1, topicNotes: 1 });
    const n1 = db.prepare('SELECT note_id FROM notes WHERE note_id = ?').get('n1');
    expect(n1, '崩溃路径不得残留 notes 半行').toBeUndefined();
  });
});

describe('重复采集语义（FR-4.4）+ countNoteSnapshots', () => {
  it('重复采集：notes 行数不增、互动列更新、snapshots 追加；countNoteSnapshots 按主题计数', () => {
    run({ id: 1, type: 'upsertNote', note: { noteId: 'n1', title: 'T1', likes: 10, collects: 2, comments: 1, topicId: 'tp-a' } });
    run({ id: 2, type: 'upsertNote', note: { noteId: 'n2', title: 'T2', likes: 5, topicId: 'tp-a' } });
    expect(counts()).toEqual({ notes: 2, snapshots: 2, topicNotes: 2 });

    // 二次采集同笔记：互动变化 → notes 行不增 + 快照追加
    run({ id: 3, type: 'upsertNote', note: { noteId: 'n1', title: 'T1-updated', likes: 99, collects: 8, comments: 6, topicId: 'tp-a' } });
    expect(counts()).toEqual({ notes: 2, snapshots: 3, topicNotes: 2 });

    const notes = run<{ notes: Array<{ noteId: string; likes: number; collects: number; comments: number; title: string }> }>({
      id: 4,
      type: 'listNotes',
      filter: { topicId: 'tp-a' },
    }).notes;
    const n1 = notes.find((n) => n.noteId === 'n1');
    expect(n1).toMatchObject({ likes: 99, collects: 8, comments: 6, title: 'T1-updated' });

    expect(run<{ count: number }>({ id: 5, type: 'countNoteSnapshots', topicId: 'tp-a' }).count).toBe(3);
    expect(run<{ count: number }>({ id: 6, type: 'countNoteSnapshots', topicId: 'tp-b' }).count).toBe(0);
    expect(run<{ count: number }>({ id: 7, type: 'countNoteSnapshots' }).count).toBe(3);
  });
});

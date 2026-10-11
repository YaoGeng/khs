/**
 * 迁移链单测（任务卡 failure QA：v0→v1 升级、v1→v0 回滚、损坏文件报错可读、
 * 失败步骤回滚上一版本）。跑在 electron-as-node（better-sqlite3 ABI 130）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAndMigrate, migrateBeforeWindow } from './db';
import { MigrationError, MIGRATIONS, appliedVersions, currentVersion, runMigrations, type MigrationStep } from './migrations';
import type { SqliteDatabase } from 'better-sqlite3';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'xinglian-migrate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function dbFile(name = 'test.db'): string {
  return path.join(dir, name);
}

describe('v0 → v1 升级', () => {
  it('全新库：0001 建 logs/tasks/task_steps/task_events 四表并记账', () => {
    const { db, migration } = openAndMigrate(dbFile());
    try {
      expect(migration?.fromVersion).toBe(0);
      expect(migration?.toVersion).toBe(1);
      expect(currentVersion(db)).toBe(1);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
      for (const t of ['logs', 'tasks', 'task_steps', 'task_events', 'schema_migrations']) {
        expect(tables).toContain(t);
      }
      const ledger = appliedVersions(db);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.version).toBe(1);
      expect(ledger[0]?.name).toBe('0001-initial-m0-tables');
      expect(ledger[0]?.appliedAt).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('幂等：重复打开不重复执行（仍是 v1）', () => {
    migrateBeforeWindow(dbFile());
    const second = migrateBeforeWindow(dbFile());
    expect(second.fromVersion).toBe(1);
    expect(second.toVersion).toBe(1);
    expect(second.applied).toHaveLength(0);
  });

  it('logs 表列对齐 02 §14.1（ts/level/category/trace_id/span_id/payload_json/created_at）', () => {
    const { db } = openAndMigrate(dbFile());
    try {
      const cols = (db.prepare('PRAGMA table_info(logs)').all() as Array<{ name: string }>).map((r) => r.name);
      for (const col of ['id', 'ts', 'created_at', 'level', 'level_name', 'category', 'trace_id', 'span_id', 'msg', 'payload_json', 'shot_path']) {
        expect(cols).toContain(col);
      }
    } finally {
      db.close();
    }
  });
});

describe('v1 → v0 回滚', () => {
  it('downgrade 到 0：四表消失、记账清空', () => {
    const { db } = openAndMigrate(dbFile());
    try {
      db.prepare("INSERT INTO logs (ts, created_at, level, level_name, category, msg) VALUES ('t','t',30,'info','user-action','m')").run();
      const report = runMigrations(db, { targetVersion: 0 });
      expect(report.fromVersion).toBe(1);
      expect(report.toVersion).toBe(0);
      expect(report.applied[0]?.direction).toBe('down');
      expect(currentVersion(db)).toBe(0);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
      for (const t of ['logs', 'tasks', 'task_steps', 'task_events']) {
        expect(tables).not.toContain(t);
      }
      // 记账表保留（基础设施），但行清空
      expect(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get()).toEqual({ c: 0 });
    } finally {
      db.close();
    }
  });

  it('降级后再升级（往返）：数据结构重建可用', () => {
    const file = dbFile();
    migrateBeforeWindow(file);
    const first = openAndMigrate(file);
    runMigrations(first.db, { targetVersion: 0 });
    first.db.close();
    const second = openAndMigrate(file);
    try {
      expect(currentVersion(second.db)).toBe(1);
      second.db.prepare("INSERT INTO tasks (id, kind, status, created_at, updated_at) VALUES ('t1','demo','idle','now','now')").run();
      expect(second.db.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toEqual({ c: 1 });
    } finally {
      second.db.close();
    }
  });
});

describe('损坏 DB（failure QA：报错可读）', () => {
  it('垃圾字节文件 → E-DB-CORRUPT，message 含文件路径', () => {
    const file = dbFile('corrupt.db');
    writeFileSync(file, Buffer.from('THIS IS NOT A SQLITE DATABASE FILE AT ALL ---- 1234567890', 'utf8'));
    try {
      migrateBeforeWindow(file);
      expect.unreachable('应抛出 MigrationError');
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      const me = error as MigrationError;
      expect(me.code).toBe('E-DB-CORRUPT');
      expect(me.message).toContain(file);
      expect(me.message).toMatch(/无法打开数据库文件|损坏/);
    }
  });

  it('损坏文件经 openAndMigrate 同样可读报错（不裸抛 SQLITE_NOTADB）', () => {
    const file = dbFile('corrupt2.db');
    writeFileSync(file, Buffer.from('\xd0\xcf\x11\xe0 garbage', 'utf8'));
    expect(() => openAndMigrate(file)).toThrowError(MigrationError);
  });
});

describe('升级失败回滚（停在上一版本）', () => {
  it('v2 步骤 up 抛错 → E-DB-MIGRATION-FAILED + v1 表完好 + 记账停在 v1', () => {
    const { db } = openAndMigrate(dbFile());
    try {
      const brokenV2: MigrationStep = {
        version: 2,
        name: '0002-broken-test',
        up() {
          throw new Error('模拟迁移失败（半步 DDL 后崩溃）');
        },
        down(d: SqliteDatabase) {
          d.exec('DROP TABLE IF EXISTS ghost_table');
        },
      };
      try {
        runMigrations(db, { steps: [...MIGRATIONS, brokenV2] });
        expect.unreachable('应抛出 MigrationError');
      } catch (error) {
        const me = error as MigrationError;
        expect(me).toBeInstanceOf(MigrationError);
        expect(me.code).toBe('E-DB-MIGRATION-FAILED');
        expect(me.message).toContain('0002-broken-test');
        expect(me.message).toContain('已回滚');
        expect(me.message).toContain('v1');
      }
      // v1 结构与记账完好
      expect(currentVersion(db)).toBe(1);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
      expect(tables).toContain('logs');
      expect(tables).not.toContain('ghost_table');
      expect(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get()).toEqual({ c: 1 });
    } finally {
      db.close();
    }
  });
});

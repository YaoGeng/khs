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

describe('v0 → v3 升级', () => {
  it('全新库：0001 建 logs/tasks/task_steps/task_events 四表，0002 建 consents，0003 建 M1 洞察九表+embeddings_vec', () => {
    const { db, migration, vecError } = openAndMigrate(dbFile());
    try {
      expect(vecError).toBeUndefined();
      expect(migration?.fromVersion).toBe(0);
      expect(migration?.toVersion).toBe(4);
      expect(currentVersion(db)).toBe(4);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
      for (const t of [
        'logs',
        'tasks',
        'task_steps',
        'task_events',
        'consents',
        'schema_migrations',
        'notes',
        'topic_notes',
        'note_snapshots',
        'reports',
        'llm_calls',
        'circuit_events',
        'keyword_hits',
        'kv_config',
        'collect_run_stats',
        'embeddings_cache',
        'embeddings_vec',
        'sourcing_candidates',
      ]) {
        expect(tables).toContain(t);
      }
      const ledger = appliedVersions(db);
      expect(ledger).toHaveLength(4);
      expect(ledger[0]?.version).toBe(1);
      expect(ledger[0]?.name).toBe('0001-initial-m0-tables');
      expect(ledger[0]?.appliedAt).toBeTruthy();
      expect(ledger[1]?.version).toBe(2);
      expect(ledger[1]?.name).toBe('0002-consents-compliance');
      expect(ledger[1]?.appliedAt).toBeTruthy();
      expect(ledger[2]?.version).toBe(3);
      expect(ledger[2]?.name).toBe('0003-insight-m1-tables');
      expect(ledger[2]?.appliedAt).toBeTruthy();
      expect(ledger[3]?.version).toBe(4);
      expect(ledger[3]?.name).toBe('0004-m2-sourcing-candidates');
      expect(ledger[3]?.appliedAt).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('幂等：重复打开不重复执行（仍是 v4）', () => {
    migrateBeforeWindow(dbFile());
    const second = migrateBeforeWindow(dbFile());
    expect(second.fromVersion).toBe(4);
    expect(second.toVersion).toBe(4);
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

describe('v3 → v0 回滚', () => {
  it('downgrade 到 0：v3 九表+vec、consents/logs/tasks/task_steps/task_events 全部消失、记账清空', () => {
    const { db } = openAndMigrate(dbFile());
    try {
      db.prepare("INSERT INTO logs (ts, created_at, level, level_name, category, msg) VALUES ('t','t',30,'info','user-action','m')").run();
      const report = runMigrations(db, { targetVersion: 0 });
      expect(report.fromVersion).toBe(4);
      expect(report.toVersion).toBe(0);
      expect(report.applied[0]?.direction).toBe('down');
      expect(report.applied).toHaveLength(4);
      expect(currentVersion(db)).toBe(0);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
      for (const t of [
        'logs',
        'tasks',
        'task_steps',
        'task_events',
        'consents',
        'notes',
        'topic_notes',
        'note_snapshots',
        'reports',
        'llm_calls',
        'circuit_events',
        'keyword_hits',
        'kv_config',
        'collect_run_stats',
        'embeddings_cache',
        'embeddings_vec',
        'sourcing_candidates',
      ]) {
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
      expect(currentVersion(second.db)).toBe(4);
      second.db.prepare("INSERT INTO tasks (id, kind, status, created_at, updated_at) VALUES ('t1','demo','idle','now','now')").run();
      expect(second.db.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toEqual({ c: 1 });
    } finally {
      second.db.close();
    }
  });
});

describe('0002 consents（todo 9 / FR-1.9：upgrade/downgrade 成对）', () => {
  it('降回 v1：v3 九表+vec、consents 消失，logs/tasks 保留、记账停 v1', () => {
    const { db } = openAndMigrate(dbFile());
    try {
      db.prepare(
        "INSERT INTO consents (subject, action, eula_version, created_at) VALUES ('eula','accepted','0.1.0-draft','t')",
      ).run();
      const report = runMigrations(db, { targetVersion: 1 });
      expect(report.fromVersion).toBe(4);
      expect(report.toVersion).toBe(1);
      expect(report.applied).toHaveLength(3);
      expect(report.applied[0]?.version).toBe(4);
      expect(report.applied[0]?.name).toBe('0004-m2-sourcing-candidates');
      expect(report.applied[0]?.direction).toBe('down');
      expect(report.applied[1]?.version).toBe(3);
      expect(report.applied[1]?.name).toBe('0003-insight-m1-tables');
      expect(report.applied[1]?.direction).toBe('down');
      expect(report.applied[2]?.version).toBe(2);
      expect(report.applied[2]?.name).toBe('0002-consents-compliance');
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
      expect(tables).not.toContain('consents');
      expect(tables).not.toContain('notes');
      expect(tables).not.toContain('embeddings_vec');
      expect(tables).not.toContain('sourcing_candidates');
      expect(tables).toContain('logs');
      expect(tables).toContain('tasks');
      expect(currentVersion(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('v1 → v2 升级：consents 结构重建可写入', () => {
    const file = dbFile();
    migrateBeforeWindow(file);
    const { db } = openAndMigrate(file, { targetVersion: 1 });
    db.close();
    const second = openAndMigrate(file, { targetVersion: 2 });
    try {
      expect(currentVersion(second.db)).toBe(2);
      second.db
        .prepare("INSERT INTO consents (subject, action, eula_version, telemetry_consent, created_at) VALUES ('eula','accepted','0.1.0-draft',1,'t')")
        .run();
      expect(second.db.prepare("SELECT COUNT(*) AS c FROM consents WHERE subject='eula'").get()).toEqual({ c: 1 });
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
  it('v3 步骤 up 中途抛错 → E-DB-MIGRATION-FAILED + v2 表完好 + 记账停 v2 + 库可复开', () => {
    const file = dbFile();
    // 建到 v2 为止（若直接跑满链，注入的 broken v3 将无从执行）
    const { db } = openAndMigrate(file, { targetVersion: 2 });
    try {
      const brokenV3: MigrationStep = {
        version: 3,
        name: '0003-broken-test',
        up() {
          throw new Error('模拟迁移失败（半步 DDL 后崩溃）');
        },
        down(d: SqliteDatabase) {
          d.exec('DROP TABLE IF EXISTS ghost_table');
        },
      };
      // 真链已含 version 3（0003-insight-m1-tables）——failure QA 用同版本号的
      // 测试步替换真 v3（steps 注入面，生产恒为 MIGRATIONS）
      try {
        runMigrations(db, { steps: [...MIGRATIONS.slice(0, 2), brokenV3] });
        expect.unreachable('应抛出 MigrationError');
      } catch (error) {
        const me = error as MigrationError;
        expect(me).toBeInstanceOf(MigrationError);
        expect(me.code).toBe('E-DB-MIGRATION-FAILED');
        expect(me.message).toContain('0003-broken-test');
        expect(me.message).toContain('已回滚');
        expect(me.message).toContain('v2');
      }
      // v2 结构与记账完好
      expect(currentVersion(db)).toBe(2);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
      expect(tables).toContain('logs');
      expect(tables).toContain('consents');
      expect(tables).not.toContain('ghost_table');
      expect(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get()).toEqual({ c: 2 });
    } finally {
      db.close();
    }
    // 库可复开：同文件以真链重开 → 正常迁到最新（v4）且可写
    const reopened = openAndMigrate(file);
    try {
      expect(currentVersion(reopened.db)).toBe(4);
      reopened.db
        .prepare("INSERT INTO notes (note_id, title, collected_at) VALUES ('reopened', 'ok', 't')")
        .run();
      expect(reopened.db.prepare('SELECT COUNT(*) AS c FROM notes').get()).toEqual({ c: 1 });
    } finally {
      reopened.db.close();
    }
  });
});

describe('0003 insight v3（M1 todo 6：upgrade/downgrade 成对）', () => {
  const V3_TABLES = [
    'notes',
    'topic_notes',
    'note_snapshots',
    'reports',
    'llm_calls',
    'circuit_events',
    'keyword_hits',
    'kv_config',
    'collect_run_stats',
    'embeddings_cache',
    'embeddings_vec',
  ] as const;

  function tableNames(db: SqliteDatabase): string[] {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
  }

  it('v2 库 → up v3 → down v2：v2 数据完好、v3 表消失；再升回 v3 后 v2 数据仍在', () => {
    const file = dbFile();
    // 1) 建到 v2 并播种 v2 数据
    const seeded = openAndMigrate(file, { targetVersion: 2 });
    try {
      seeded.db
        .prepare("INSERT INTO logs (ts, created_at, level, level_name, category, msg) VALUES ('t0','t0',30,'info','user-action','v2-row')")
        .run();
      seeded.db
        .prepare("INSERT INTO consents (subject, action, eula_version, created_at) VALUES ('eula','accepted','0.1.0-draft','t0')")
        .run();
    } finally {
      seeded.db.close();
    }
    // 2) up 到顶（v4，链含 0004）：v3 表齐 + 播种一条 v3 业务行
    const uped = openAndMigrate(file);
    try {
      expect(currentVersion(uped.db)).toBe(4);
      const tables = tableNames(uped.db);
      for (const t of V3_TABLES) expect(tables).toContain(t);
      uped.db
        .prepare("INSERT INTO notes (note_id, title, likes, collected_at) VALUES ('n-1', '标题', 3, 't1')")
        .run();
    } finally {
      uped.db.close();
    }
    // 3) down 到 v2：v3/v4 表全部消失（含 vec0 虚表）、v1/v2 数据原样、记账停 v2
    const downed = openAndMigrate(file, { skipMigration: true });
    try {
      const report = runMigrations(downed.db, { targetVersion: 2 });
      expect(report.fromVersion).toBe(4);
      expect(report.toVersion).toBe(2);
      expect(report.applied).toHaveLength(2);
      expect(report.applied[0]?.version).toBe(4);
      expect(report.applied[0]?.direction).toBe('down');
      expect(report.applied[1]?.version).toBe(3);
      expect(report.applied[1]?.direction).toBe('down');
      const tables = tableNames(downed.db);
      for (const t of V3_TABLES) expect(tables).not.toContain(t);
      expect(downed.db.prepare("SELECT COUNT(*) AS c FROM logs WHERE msg = 'v2-row'").get()).toEqual({ c: 1 });
      expect(downed.db.prepare("SELECT COUNT(*) AS c FROM consents WHERE eula_version = '0.1.0-draft'").get()).toEqual({ c: 1 });
      expect(currentVersion(downed.db)).toBe(2);
    } finally {
      downed.db.close();
    }
    // 4) 再升回顶（v4）：结构重建可写、v2 数据仍在（v3 行不复活——down 即删）
    const reuped = openAndMigrate(file);
    try {
      expect(currentVersion(reuped.db)).toBe(4);
      expect(reuped.db.prepare('SELECT COUNT(*) AS c FROM notes').get()).toEqual({ c: 0 });
      expect(reuped.db.prepare("SELECT COUNT(*) AS c FROM logs WHERE msg = 'v2-row'").get()).toEqual({ c: 1 });
      reuped.db.prepare("INSERT INTO reports (topic, report_json, created_at) VALUES ('topic', '{}', 't2')").run();
      expect(reuped.db.prepare('SELECT COUNT(*) AS c FROM reports').get()).toEqual({ c: 1 });
    } finally {
      reuped.db.close();
    }
  });

  it('dim=2048 锁定：embeddings_vec 为 vec0 虚表且 vec_version 可用（扩展经 db.ts 软加载）', () => {
    const { db } = openAndMigrate(dbFile());
    try {
      const vecInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='embeddings_vec'").get() as { sql: string };
      expect(vecInfo.sql).toContain('vec0');
      expect(vecInfo.sql).toContain('float[2048]');
      const version = db.prepare('SELECT vec_version() AS v').get() as { v: string };
      expect(version.v).toMatch(/^v0\./);
    } finally {
      db.close();
    }
  });
});

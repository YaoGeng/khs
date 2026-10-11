/**
 * 版本化迁移链（ADR-8 §7.7：迁移受事务粒度约束；任务卡：upgrade/downgrade 成对 +
 * schema_migrations 记账 + 损坏 DB 报错可读 + 失败回滚上一版本）。
 *
 * 形态：每步 MigrationStep{version, name, up, down}；runner 依版本序执行，步骤内
 * DDL+记账同事务（SQLite DDL 可事务化）。本文件不 import electron/better-sqlite3
 * 具体实现——以 SqliteDatabase 结构面编程，vitest 与主进程直写/worker 共用。
 */
import type { SqliteDatabase } from 'better-sqlite3';

export interface MigrationStep {
  version: number;
  name: string;
  up(db: SqliteDatabase): void;
  down(db: SqliteDatabase): void;
}

export type MigrationErrorCode = 'E-DB-CORRUPT' | 'E-DB-MIGRATION-FAILED';

/** 迁移失败：code 稳定 + message 含文件路径/步骤名/底层原因（failure QA 可读性） */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options ? { cause: options.cause } : undefined);
    this.name = 'MigrationError';
    this.code = code;
  }
}

const CORRUPT_PATTERN = /file is not a database|database disk image is malformed|SQLITE_CORRUPT|SQLITE_NOTADB|encrypted/i;

function isCorruption(error: unknown): boolean {
  return error instanceof Error && CORRUPT_PATTERN.test(`${(error as { code?: string }).code ?? ''} ${error.message}`);
}

/** 0001 初始：logs / tasks / task_steps / task_events 四表 + 索引（02 §14.1 M0 子集） */
function upV1(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT    NOT NULL,
      created_at    TEXT    NOT NULL,
      level         INTEGER NOT NULL,
      level_name    TEXT    NOT NULL,
      category      TEXT    NOT NULL,
      trace_id      TEXT,
      span_id       TEXT,
      msg           TEXT    NOT NULL,
      payload_json  TEXT,
      shot_path     TEXT
    );
    CREATE INDEX idx_logs_created_at ON logs (created_at);
    CREATE INDEX idx_logs_trace ON logs (trace_id);
    CREATE INDEX idx_logs_category_created ON logs (category, created_at);

    CREATE TABLE tasks (
      id               TEXT PRIMARY KEY,
      kind             TEXT    NOT NULL,
      status           TEXT    NOT NULL,
      payload_json     TEXT,
      priority         INTEGER NOT NULL DEFAULT 0,
      idempotency_key  TEXT,
      created_at       TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL
    );
    CREATE INDEX idx_tasks_status ON tasks (status);
    CREATE INDEX idx_tasks_kind ON tasks (kind);

    CREATE TABLE task_steps (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id        TEXT    NOT NULL,
      step_id        TEXT    NOT NULL,
      seq            INTEGER NOT NULL,
      status         TEXT    NOT NULL,
      output_json    TEXT,
      checkpoint_at  TEXT
    );
    CREATE UNIQUE INDEX ux_task_steps_task_step ON task_steps (task_id, step_id);
    CREATE INDEX idx_task_steps_task_seq ON task_steps (task_id, seq);

    CREATE TABLE task_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id       TEXT    NOT NULL,
      type          TEXT    NOT NULL,
      from_state    TEXT,
      to_state      TEXT,
      payload_json  TEXT,
      created_at    TEXT    NOT NULL
    );
    CREATE INDEX idx_task_events_task_created ON task_events (task_id, created_at);
  `);
}

function downV1(db: SqliteDatabase): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_task_events_task_created;
    DROP TABLE IF EXISTS task_events;
    DROP INDEX IF EXISTS ux_task_steps_task_step;
    DROP INDEX IF EXISTS idx_task_steps_task_seq;
    DROP TABLE IF EXISTS task_steps;
    DROP INDEX IF EXISTS idx_tasks_status;
    DROP INDEX IF EXISTS idx_tasks_kind;
    DROP TABLE IF EXISTS tasks;
    DROP INDEX IF EXISTS idx_logs_created_at;
    DROP INDEX IF EXISTS idx_logs_trace;
    DROP INDEX IF EXISTS idx_logs_category_created;
    DROP TABLE IF EXISTS logs;
  `);
}

/**
 * 0002 合规（todo 9 = T-M0-11；FR-1.9 / FR-12.6）：consents 表。
 * 追加式事件留痕：每条 = 一次同意动作（EULA 接受/拒绝、遥测开/关）；
 * 现值语义由消费方按「最新一条」解析（见 compliance/eula.ts resolveEulaGate）。
 */
function upV2(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE consents (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      subject           TEXT    NOT NULL,
      action            TEXT    NOT NULL,
      eula_version      TEXT,
      telemetry_consent INTEGER,
      created_at        TEXT    NOT NULL
    );
    CREATE INDEX idx_consents_subject ON consents (subject, id);
    CREATE INDEX idx_consents_tele_consent ON consents (telemetry_consent, id);
  `);
}

function downV2(db: SqliteDatabase): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_consents_tele_consent;
    DROP INDEX IF EXISTS idx_consents_subject;
    DROP TABLE IF EXISTS consents;
  `);
}

/** 迁移链：只追加不回改（发布后已应用版本不可变更，M1+ 走 0003+） */
export const MIGRATIONS: readonly MigrationStep[] = [
  { version: 1, name: '0001-initial-m0-tables', up: upV1, down: downV1 },
  { version: 2, name: '0002-consents-compliance', up: upV2, down: downV2 },
];

function ensureLedger(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL
    );
  `);
}

/** 当前已应用版本（无记账表/空表 = v0） */
export function currentVersion(db: SqliteDatabase): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

function appliedAt(db: SqliteDatabase, version: number): string | null {
  const row = db.prepare('SELECT applied_at AS a FROM schema_migrations WHERE version = ?').get(version) as
    | { a: string }
    | undefined;
  return row?.a ?? null;
}

export interface MigrateOptions {
  /** 目标版本（默认链顶）；低于当前版本则执行 downgrade */
  targetVersion?: number;
  /** 注入额外迁移步（测试用）；生产恒为 MIGRATIONS */
  steps?: readonly MigrationStep[];
}

export interface MigrateReport {
  fromVersion: number;
  toVersion: number;
  applied: Array<{ version: number; name: string; direction: 'up' | 'down'; ms: number }>;
}

/**
 * 执行迁移链。失败语义：
 * - 升级失败：先尽力 down 回滚本步，再抛 E-DB-MIGRATION-FAILED（记账不变=停在上一版本）；
 * - 损坏库（SQLITE_NOTADB/CORRUPT）：抛 E-DB-CORRUPT（无从回滚，报错可读）。
 */
export function runMigrations(db: SqliteDatabase, options: MigrateOptions = {}): MigrateReport {
  try {
    ensureLedger(db);
  } catch (error) {
    if (isCorruption(error)) {
      throw new MigrationError('E-DB-CORRUPT', `数据库文件损坏，无法读取迁移记账表（${(error as Error).message}）`, {
        cause: error,
      });
    }
    throw error;
  }

  const steps = options.steps ?? MIGRATIONS;
  const sorted = [...steps].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.version <= sorted[i - 1]!.version) {
      throw new Error(`迁移链版本号重复/乱序：${sorted[i - 1]!.name} → ${sorted[i]!.name}`);
    }
  }

  let from = currentVersion(db);
  const target = options.targetVersion ?? sorted[sorted.length - 1]?.version ?? 0;
  const report: MigrateReport = { fromVersion: from, toVersion: from, applied: [] };

  const run = (step: MigrationStep, direction: 'up' | 'down'): void => {
    const startedAt = process.hrtime.bigint();
    try {
      db.transaction(() => {
        if (direction === 'up') step.up(db);
        else step.down(db);
        if (direction === 'up') {
          db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
            step.version,
            step.name,
            new Date().toISOString(),
          );
        } else {
          db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(step.version);
        }
      })();
      from = direction === 'up' ? step.version : step.version - 1;
      report.applied.push({
        version: step.version,
        name: step.name,
        direction,
        ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
      });
    } catch (error) {
      if (direction === 'up') {
        try {
          step.down(db);
        } catch (downError) {
          throw new MigrationError(
            'E-DB-MIGRATION-FAILED',
            `升级到 v${step.version}（${step.name}）失败：${(error as Error).message}；且回滚亦失败：${(downError as Error).message}——库可能处于中间态，需要人工介入`,
            { cause: error },
          );
        }
        throw new MigrationError(
          'E-DB-MIGRATION-FAILED',
          `升级到 v${step.version}（${step.name}）失败并已回滚该步：${(error as Error).message}；当前停留在 v${step.version - 1}`,
          { cause: error },
        );
      }
      throw new MigrationError(
        'E-DB-MIGRATION-FAILED',
        `从 v${step.version} 回滚（${step.name}）失败：${(error as Error).message}`,
        { cause: error },
      );
    }
  };

  try {
    if (target > from) {
      for (const step of sorted) {
        if (step.version > from && step.version <= target) run(step, 'up');
      }
    } else if (target < from) {
      for (const step of [...sorted].reverse()) {
        if (step.version > target && step.version <= from) run(step, 'down');
      }
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    if (isCorruption(error)) {
      throw new MigrationError('E-DB-CORRUPT', `迁移执行中检测到数据库损坏（${(error as Error).message}）`, {
        cause: error,
      });
    }
    throw error;
  }

  report.toVersion = from;
  return report;
}

/** 已应用版本清单（诊断/测试用） */
export function appliedVersions(db: SqliteDatabase): Array<{ version: number; name: string; appliedAt: string | null }> {
  ensureLedger(db);
  const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
    name: string;
  }>;
  return rows.map((r) => ({ version: r.version, name: r.name, appliedAt: appliedAt(db, r.version) }));
}

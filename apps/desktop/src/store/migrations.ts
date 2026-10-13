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

/**
 * 0003 M1 洞察业务地基（m1-insight-plan todo 6；02 §14.1 notes/note_snapshots/reports、
 * 02:714 llm_calls、FR-4.4 快照、FR-9.5/9.6 留痕、FR-10.3 口径、ADR-7 embeddings）。
 *
 * embeddings_vec 决策注记（ADR-7 §2-4，写死于此供后续迁移遵循）：
 * - vec0 虚拟表单表单 dim，dim=2048（默认嵌入档候选 zhipu embedding-3，[文档] 源，
 *   见 docs/adr/ADR-7-embedding-source.md §4）；
 * - dim 变更 = embeddings_cache 全量失效 + embeddings_vec DROP 后按新 dim 重建 +
 *   kv_config 探针记录更新（届时走 0004+ 迁移，禁回改本步）；不做多 dim 分表矩阵；
 * - rowid 全 BigInt：better-sqlite3 把 JS number 绑成 REAL、vec0 拒收
 *   （sqlite-vec-packaging-validation.md §3-④），embeddings_cache.id 与 vec rowid
 *   共享同值，绑定一律经 BigInt。
 * - 时间戳列沿用 M0 口径（TEXT ISO-8601；provider-matrix §4.2 草图的 INTEGER
 *   不采纳——migrations.ts 是 DDL 真源，链内一致性优先）。
 */
function upV3(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE notes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id         TEXT    NOT NULL,
      title           TEXT,
      content         TEXT,
      author_json     TEXT,
      likes           INTEGER NOT NULL DEFAULT 0,
      collects        INTEGER NOT NULL DEFAULT 0,
      comments        INTEGER NOT NULL DEFAULT 0,
      tags_json       TEXT,
      cover_url       TEXT,
      image_urls_json TEXT,
      published_at    TEXT,
      collected_at    TEXT    NOT NULL
    );
    CREATE UNIQUE INDEX ux_notes_note_id ON notes (note_id);
    CREATE INDEX idx_notes_collected ON notes (collected_at);

    -- 主题 × 笔记多对多登记；UNIQUE 保证重复采集不重建登记行（seen_at = 首见时间）
    CREATE TABLE topic_notes (
      topic_id  TEXT NOT NULL,
      note_id   TEXT NOT NULL,
      seen_at   TEXT NOT NULL
    );
    CREATE UNIQUE INDEX ux_topic_notes_topic_note ON topic_notes (topic_id, note_id);

    -- FR-4.4 追加式互动快照：重复采集仅更新 notes 互动列 + 追加一行观测
    CREATE TABLE note_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id     TEXT    NOT NULL,
      likes       INTEGER NOT NULL DEFAULT 0,
      collects    INTEGER NOT NULL DEFAULT 0,
      comments    INTEGER NOT NULL DEFAULT 0,
      captured_at TEXT    NOT NULL
    );
    CREATE INDEX idx_note_snapshots_note ON note_snapshots (note_id, captured_at);

    -- 八章节报告落库（todo 8 消费）；gate_state = 关键词确认闸门状态（todo 11 推进）
    CREATE TABLE reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      topic       TEXT    NOT NULL,
      report_json TEXT    NOT NULL,
      content_md  TEXT,
      model       TEXT,
      token_cost  INTEGER,
      gate_state  TEXT,
      created_at  TEXT    NOT NULL
    );
    CREATE INDEX idx_reports_topic ON reports (topic, created_at);

    -- LLM 计量（02:714；FR-2.5 用量面板按 at 聚合，trace_id 串联调用链）
    CREATE TABLE llm_calls (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id   TEXT,
      provider   TEXT    NOT NULL,
      model      TEXT    NOT NULL,
      tokens_in  INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost       REAL,
      latency_ms INTEGER,
      at         TEXT    NOT NULL
    );
    CREATE INDEX idx_llm_calls_at ON llm_calls (at);
    CREATE INDEX idx_llm_calls_trace ON llm_calls (trace_id);

    -- 熔断/配额触顶/自检失败本地账本（FR-9.5 抽查与门禁①剔除口径证据源；只记事件不记笔记内容）
    CREATE TABLE circuit_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      kind      TEXT    NOT NULL,
      at        TEXT    NOT NULL,
      meta_json TEXT
    );
    CREATE INDEX idx_circuit_events_at ON circuit_events (at);

    -- FR-9.6 词库命中留痕（词库本体走配置包 JSON，不建内容表——02:763）
    CREATE TABLE keyword_hits (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      wordlist_version TEXT    NOT NULL,
      term             TEXT    NOT NULL,
      category         TEXT,
      topic_id         TEXT,
      at               TEXT    NOT NULL
    );
    CREATE INDEX idx_keyword_hits_at ON keyword_hits (at);

    -- 本地 KV（safeStorage 加密 Key、ADR-7 嵌入探针记录、配额与词库 active 指针）；
    -- BLOB 亲和：字符串落 TEXT、Buffer 落 BLOB，同一列如实容纳两种形态
    CREATE TABLE kv_config (
      key        TEXT PRIMARY KEY,
      value_blob BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 门禁①采集分母公式数据源（no_result/rate_limited/captcha_consumed/duplicate 全计数器化）
    CREATE TABLE collect_run_stats (
      run_id           TEXT PRIMARY KEY,
      completed_unique INTEGER NOT NULL DEFAULT 0,
      duplicate        INTEGER NOT NULL DEFAULT 0,
      no_result        INTEGER NOT NULL DEFAULT 0,
      rate_limited     INTEGER NOT NULL DEFAULT 0,
      captcha_consumed INTEGER NOT NULL DEFAULT 0
    );

    -- 本地嵌入缓存（provider-matrix.md §4.2 设计注记落地；不存原文，隐私友好）；
    -- id 显式 = embeddings_vec rowid（绑定一律 BigInt，见上方注记）
    CREATE TABLE embeddings_cache (
      id           INTEGER PRIMARY KEY,
      provider     TEXT    NOT NULL,
      model        TEXT    NOT NULL,
      input_sha256 TEXT    NOT NULL,
      dim          INTEGER NOT NULL,
      created_at   TEXT    NOT NULL,
      last_used_at TEXT    NOT NULL
    );
    CREATE UNIQUE INDEX ux_embeddings_cache_key ON embeddings_cache (provider, model, input_sha256);
    CREATE INDEX idx_embeddings_cache_last_used ON embeddings_cache (last_used_at);

    -- vec0 虚拟表（需连接已加载 sqlite-vec 扩展，见 db.ts openAndMigrate）
    CREATE VIRTUAL TABLE IF NOT EXISTS embeddings_vec USING vec0(embedding float[2048]);
  `);
}

function downV3(db: SqliteDatabase): void {
  db.exec(`
    DROP TABLE IF EXISTS embeddings_vec;
    DROP INDEX IF EXISTS idx_embeddings_cache_last_used;
    DROP INDEX IF EXISTS ux_embeddings_cache_key;
    DROP TABLE IF EXISTS embeddings_cache;
    DROP TABLE IF EXISTS collect_run_stats;
    DROP TABLE IF EXISTS kv_config;
    DROP INDEX IF EXISTS idx_keyword_hits_at;
    DROP TABLE IF EXISTS keyword_hits;
    DROP INDEX IF EXISTS idx_circuit_events_at;
    DROP TABLE IF EXISTS circuit_events;
    DROP INDEX IF EXISTS idx_llm_calls_trace;
    DROP INDEX IF EXISTS idx_llm_calls_at;
    DROP TABLE IF EXISTS llm_calls;
    DROP INDEX IF EXISTS idx_reports_topic;
    DROP TABLE IF EXISTS reports;
    DROP INDEX IF EXISTS idx_note_snapshots_note;
    DROP TABLE IF EXISTS note_snapshots;
    DROP INDEX IF EXISTS ux_topic_notes_topic_note;
    DROP TABLE IF EXISTS topic_notes;
    DROP INDEX IF EXISTS idx_notes_collected;
    DROP INDEX IF EXISTS ux_notes_note_id;
    DROP TABLE IF EXISTS notes;
  `);
}

/** 迁移链：只追加不回改（发布后已应用版本不可变更，M1+ 走 0004+） */
export const MIGRATIONS: readonly MigrationStep[] = [
  { version: 1, name: '0001-initial-m0-tables', up: upV1, down: downV1 },
  { version: 2, name: '0002-consents-compliance', up: upV2, down: downV2 },
  { version: 3, name: '0003-insight-m1-tables', up: upV3, down: downV3 },
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

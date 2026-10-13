/**
 * SQLite 连接打开助手（ADR-8 §7.2-7.4：WAL + synchronous=NORMAL + busy_timeout=2000 显式设置）。
 * 主进程迁移直写与 store worker 共用；调用方决定生命周期。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MigrationError, runMigrations, type MigrateReport } from './migrations';
import { loadSqliteVec } from './vec';

export const STORE_PRAGMAS = {
  journalMode: 'WAL',
  synchronous: 'NORMAL',
  busyTimeoutMs: 2000,
} as const;

export interface OpenOptions {
  /** 迁移目标版本（迁移直写路径用；worker 打开时恒跑满链） */
  targetVersion?: number;
  skipMigration?: boolean;
}

export interface OpenResult {
  db: betterSqlite3Database;
  migration?: MigrateReport;
  /** sqlite-vec 加载失败原因（软失败：v1/v2 连接不受阻；v3 语句触到 vec0 时才显式报错） */
  vecError?: string;
}

type betterSqlite3Database = import('better-sqlite3').SqliteDatabase;

/** 打开 DB 并跑迁移；损坏文件 → E-DB-CORRUPT（message 含路径，failure QA 口径） */
export function openAndMigrate(dbFile: string, options: OpenOptions = {}): OpenResult {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  let db: betterSqlite3Database | undefined;
  try {
    db = new Database(dbFile);
    // 损坏文件在首条语句（PRAGMA 头读）即抛 SQLITE_NOTADB——open 本身是惰性的
    applyWritePragmas(db);
    // sqlite-vec 软加载（v3 embeddings_vec 建表与 KNN 查询共用；加载失败不记录到
    // vecError 就会让 v3 迁移以难懂的 "no such module" 失败，故落 OpenResult 供诊断）
    let vecError: string | undefined;
    try {
      loadSqliteVec(db);
    } catch (error) {
      vecError = (error as Error).message;
    }
    const migration = options.skipMigration ? undefined : runMigrations(db, { targetVersion: options.targetVersion });
    return { db, migration, vecError };
  } catch (error) {
    // 句柄可能已开（PRAGMA/迁移阶段失败）：先关再抛，不留锁（Windows 下未关闭=文件被锁）
    try {
      db?.close();
    } catch {
      // 未开成功则忽略
    }
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('E-DB-CORRUPT', `无法打开数据库文件 ${dbFile}（${(error as Error).message}）`, {
      cause: error,
    });
  }
}

/** 写连接 PRAGMA（ADR-8 §7.3：busy_timeout 不得依赖默认值；§7.4 WAL + NORMAL） */
export function applyWritePragmas(db: betterSqlite3Database): void {
  db.pragma(`journal_mode = ${STORE_PRAGMAS.journalMode}`);
  db.pragma(`synchronous = ${STORE_PRAGMAS.synchronous}`);
  db.pragma(`busy_timeout = ${STORE_PRAGMAS.busyTimeoutMs}`);
}

/** 迁移直写入口（主进程窗口创建前一次性调用，ADR-8 §6①；用后即闭，不持常驻写连接） */
export function migrateBeforeWindow(dbFile: string, targetVersion?: number): MigrateReport {
  const { db, migration } = openAndMigrate(dbFile, { targetVersion });
  db.close();
  return migration as MigrateReport;
}

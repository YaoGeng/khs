/**
 * store 写 worker —— utilityProcess 托管写（ADR-8 §6 选型 B：唯一写者）。
 *
 * 本文件是 utilityProcess.fork 的入口模块（构建产物 out/store-worker.js），
 * 在 Electron 内置 Node（ABI 130）下运行 better-sqlite3（electron-v130 预编译）。
 * 协议：__init 握手 → StoreRequest{ id, type, ... } → StoreResponse{ id, ok, data|err, writeMs }。
 * 事务粒度（ADR-8 §7.2）：insertLogs 分片 ≤100 行/事务；其余单行写各自成事务。
 */
import { openAndMigrate } from './db';
import { STORE_ERROR_CODES, type StoreRequest, type StoreResponse, type CreateTaskInput, type LogQueryFilter, type StepInput, type TaskEventInput, type TaskStatusInput, type RetentionPolicy } from './protocol';

type SqliteDatabase = import('better-sqlite3').SqliteDatabase;

/** 单事务行数上限（ADR-8 §7.2 硬上限） */
export const MAX_BATCH_ROWS = 100;

interface QueryLogRow {
  id: number;
  ts: string;
  created_at: string;
  level: number;
  level_name: string;
  category: string;
  trace_id: string | null;
  span_id: string | null;
  msg: string;
  payload_json: string | null;
}

function toLogView(row: QueryLogRow): Record<string, unknown> {
  let payload: unknown = null;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = row.payload_json;
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    createdAt: row.created_at,
    level: row.level,
    levelName: row.level_name,
    category: row.category,
    traceId: row.trace_id,
    spanId: row.span_id,
    msg: row.msg,
    payload,
  };
}

function parseJsonOrNull(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 纯请求处理器（worker 内核；vitest 以真实 better-sqlite3 直测，绕过 utilityProcess）。
 * 同步执行：better-sqlite3 API 面即同步；writeMs 覆盖单请求全部 SQL 同步段。
 */
export function handleStoreRequest(db: SqliteDatabase, request: StoreRequest): { data: unknown; writeMs: number } {
  const startedAt = process.hrtime.bigint();
  const run = (): unknown => {
    switch (request.type) {
      case 'ping':
        return { pong: true, version: currentSchemaVersion(db) };

      case 'insertLogs': {
        const rows = request.rows;
        let inserted = 0;
        const stmt = db.prepare(
          `INSERT INTO logs (ts, created_at, level, level_name, category, trace_id, span_id, msg, payload_json, shot_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (let offset = 0; offset < rows.length; offset += MAX_BATCH_ROWS) {
          const chunk = rows.slice(offset, offset + MAX_BATCH_ROWS);
          db.transaction(() => {
            for (const row of chunk) {
              stmt.run(
                row.ts,
                row.ts,
                row.level,
                row.levelName,
                row.category,
                row.traceId ?? null,
                row.spanId ?? null,
                row.msg,
                row.payload === undefined ? null : JSON.stringify(row.payload),
                row.shotPath ?? null,
              );
              inserted += 1;
            }
          })();
        }
        return { inserted };
      }

      case 'createTask': {
        const task = request.task as CreateTaskInput;
        const now = new Date().toISOString();
        const result = db
          .prepare(
            `INSERT INTO tasks (id, kind, status, payload_json, priority, idempotency_key, created_at, updated_at)
             VALUES (?, ?, 'idle', ?, ?, ?, ?, ?)`,
          )
          .run(
            task.id,
            task.kind,
            task.payload === undefined ? null : JSON.stringify(task.payload),
            task.priority ?? 0,
            task.idempotencyKey ?? null,
            now,
            now,
          );
        return { created: true, taskId: task.id, changes: Number(result.changes) };
      }

      case 'updateTaskStatus': {
        const update = request.update as TaskStatusInput;
        const result = db
          .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
          .run(update.status, update.at ?? new Date().toISOString(), update.taskId);
        if (Number(result.changes) === 0) throw new Error(`task not found: ${update.taskId}`);
        return { updated: true, taskId: update.taskId, status: update.status };
      }

      case 'writeTaskEvent': {
        const event = request.event as TaskEventInput;
        db.prepare(
          `INSERT INTO task_events (task_id, type, from_state, to_state, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          event.taskId,
          event.type,
          event.fromState ?? null,
          event.toState ?? null,
          event.payload === undefined ? null : JSON.stringify(event.payload),
          event.at ?? new Date().toISOString(),
        );
        return { written: true };
      }

      case 'upsertStep': {
        const step = request.step as StepInput;
        db.prepare(
          `INSERT INTO task_steps (task_id, step_id, seq, status, output_json, checkpoint_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (task_id, step_id) DO UPDATE SET
             seq = excluded.seq,
             status = excluded.status,
             output_json = excluded.output_json,
             checkpoint_at = excluded.checkpoint_at`,
        ).run(
          step.taskId,
          step.stepId,
          step.seq,
          step.status,
          step.output === undefined ? null : JSON.stringify(step.output),
          step.checkpointAt ?? null,
        );
        return { upserted: true };
      }

      case 'getTask': {
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(request.taskId) as
          | Record<string, unknown>
          | undefined;
        return { task: row ? taskRowToView(row) : null };
      }

      case 'listTasks': {
        const rows =
          request.status === undefined
            ? (db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT 200').all() as Array<Record<string, unknown>>)
            : (db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT 200').all(request.status) as Array<Record<string, unknown>>);
        return { tasks: rows.map(taskRowToView) };
      }

      case 'listSteps': {
        const rows = db
          .prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY seq ASC')
          .all(request.taskId) as Array<Record<string, unknown>>;
        return { steps: rows.map(stepRowToView) };
      }

      case 'listTaskEvents': {
        const rows = db
          .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC')
          .all(request.taskId) as Array<Record<string, unknown>>;
        return {
          events: rows.map((row) => ({
            id: row.id,
            taskId: row.task_id,
            type: row.type,
            fromState: row.from_state,
            toState: row.to_state,
            payload: parseJsonOrNull(row.payload_json as string | null),
            createdAt: row.created_at,
          })),
        };
      }

      case 'queryLogs': {
        const filter = request.filter as LogQueryFilter;
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (filter.traceId) {
          clauses.push('trace_id = ?');
          params.push(filter.traceId);
        }
        if (filter.spanId) {
          clauses.push('span_id = ?');
          params.push(filter.spanId);
        }
        if (filter.category) {
          clauses.push('category = ?');
          params.push(filter.category);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const order = filter.order === 'asc' ? 'ASC' : 'DESC';
        const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
        const rows = db
          .prepare(`SELECT * FROM logs ${where} ORDER BY id ${order} LIMIT ${limit}`)
          .all(...params) as QueryLogRow[];
        return { rows: rows.map(toLogView) };
      }

      case 'pruneLogs': {
        const policy = request.policy as RetentionPolicy;
        const nowIso = new Date().toISOString();
        const cutoffLocal = addDaysIso(nowIso, -policy.localDays);
        const cutoffNetwork = addDaysIso(nowIso, -policy.networkMetaDays);
        const local = db
          .prepare("DELETE FROM logs WHERE category != 'network-meta' AND created_at < ?")
          .run(cutoffLocal);
        const network = db
          .prepare("DELETE FROM logs WHERE category = 'network-meta' AND created_at < ?")
          .run(cutoffNetwork);
        return {
          localDeleted: Number(local.changes),
          networkDeleted: Number(network.changes),
        };
      }

      default: {
        const exhaustive: never = request;
        throw new Error(`unknown store request: ${(exhaustive as { type?: string }).type ?? '?'}`);
      }
    }
  };

  return { data: run(), writeMs: Number(process.hrtime.bigint() - startedAt) / 1e6 };
}

function addDaysIso(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function taskRowToView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    payload: parseJsonOrNull(row.payload_json as string | null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stepRowToView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    taskId: row.task_id,
    stepId: row.step_id,
    seq: row.seq,
    status: row.status,
    output: parseJsonOrNull(row.output_json as string | null),
    checkpointAt: row.checkpoint_at,
  };
}

function currentSchemaVersion(db: SqliteDatabase): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/* ------------------------------ utilityProcess 入口 ------------------------------ */

export function startStoreWorker(): void {
  // 延迟 require electron（本文件同时被 vitest 纯核直测 import；fork 路径才触碰 electron）
  const { parentPort } = process as unknown as { parentPort?: import('electron').MessagePortMain };
  if (!parentPort) {
    throw new Error('store worker 必须经 utilityProcess.fork 启动（非独立 node 进程）');
  }

  let db: SqliteDatabase | null = null;

  const respond = (response: StoreResponse): void => {
    parentPort.postMessage(response);
  };

  parentPort.on('message', (event: { data: unknown }) => {
    const message = event.data as StoreRequest | { type: '__init' | '__close' };

    if ((message as { type: string }).type === '__init') {
      const dbFile = (message as unknown as { dbFile: string }).dbFile;
      try {
        const opened = openAndMigrate(dbFile);
        db = opened.db;
        const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
        parentPort.postMessage({ type: '__ready', dbFile, schemaVersion: row.v ?? 0 });
        // ADR-8 §7.4：空闲期周期 wal_checkpoint(TRUNCATE)，压 checkpoint 边界尖峰
        const checkpointTimer = setInterval(() => {
          try {
            db?.pragma('wal_checkpoint(TRUNCATE)');
          } catch {
            // checkpoint 失败下轮重试
          }
        }, 5 * 60 * 1000);
        checkpointTimer.unref?.();
      } catch (error) {
        parentPort.postMessage({
          type: '__init_fail',
          code: 'E-DB-CORRUPT',
          err: `store worker 打开 DB 失败：${(error as Error).message}`,
        });
      }
      return;
    }

    if ((message as { type: string }).type === '__close') {
      try {
        db?.close();
      } finally {
        db = null;
      }
      process.exit(0);
    }

    const request = message as StoreRequest;
    if (!db) {
      respond({ id: request.id, ok: false, code: STORE_ERROR_CODES.HANDSHAKE, err: 'worker 未完成 __init 握手' });
      return;
    }
    try {
      const { data, writeMs } = handleStoreRequest(db, request);
      respond({ id: request.id, ok: true, data, writeMs });
    } catch (error) {
      respond({ id: request.id, ok: false, code: STORE_ERROR_CODES.DB, err: (error as Error).message });
    }
  });
}

// 被 utilityProcess.fork 直接加载时自启（宿主注入 XINGLIAN_STORE_WORKER=forked；esbuild 产物为 CJS）
if (process.env.XINGLIAN_STORE_WORKER === 'forked') {
  startStoreWorker();
}

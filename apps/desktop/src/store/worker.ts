/**
 * store 写 worker —— utilityProcess 托管写（ADR-8 §6 选型 B：唯一写者）。
 *
 * 本文件是 utilityProcess.fork 的入口模块（构建产物 out/store-worker.js），
 * 在 Electron 内置 Node（ABI 130）下运行 better-sqlite3（electron-v130 预编译）。
 * 协议：__init 握手 → StoreRequest{ id, type, ... } → StoreResponse{ id, ok, data|err, writeMs }。
 * 事务粒度（ADR-8 §7.2）：insertLogs 分片 ≤100 行/事务；其余单行写各自成事务。
 */
import { openAndMigrate } from './db';
import { EMBEDDINGS_RETENTION_DAYS, STORE_ERROR_CODES, isTaskStatus, type CircuitEventFilter, type CircuitEventInput, type CollectRunStatsInput, type CollectRunStatsView, type ConsentInput, type ConsentRowView, type EmbeddingUpsertInput, type EmbeddingUpsertResult, type KeywordHitFilter, type KeywordHitInput, type KnnQuery, type NoteInput, type NoteQueryFilter, type NoteRowView, type ReportInput, type ReportRowView, type StoreRequest, type StoreResponse, type CreateTaskInput, type LogQueryFilter, type LlmCallInput, type StepInput, type TaskEventInput, type TaskStatusInput, type RetentionPolicy } from './protocol';

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
        // M1 扩态值域校验（store 侧镜像面）：非法状态拒绝写入（E-STORE-BAD-REQUEST）
        if (!isTaskStatus(update.status)) {
          throw new Error(`${STORE_ERROR_CODES.BAD_REQUEST}: 非法任务状态: ${String(update.status)}`);
        }
        const result = db
          .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
          .run(update.status, update.at ?? new Date().toISOString(), update.taskId);
        if (Number(result.changes) === 0) throw new Error(`task not found: ${update.taskId}`);
        return { updated: true, taskId: update.taskId, status: update.status };
      }

      case 'writeTaskEvent': {
        const event = request.event as TaskEventInput;
        // task_events 值域校验：from/to 必须落在 TASK_STATUS_VALUES（M1 扩态镜像面）
        for (const [label, value] of [['fromState', event.fromState], ['toState', event.toState]] as const) {
          if (value !== undefined && value !== null && !isTaskStatus(value)) {
            throw new Error(`${STORE_ERROR_CODES.BAD_REQUEST}: task_events ${label} 非法状态值: ${String(value)}`);
          }
        }
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

      case 'putConsent': {
        const consent = request.consent as ConsentInput;
        const result = db
          .prepare(
            `INSERT INTO consents (subject, action, eula_version, telemetry_consent, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            consent.subject,
            consent.action,
            consent.eulaVersion ?? null,
            consent.telemetryConsent === undefined ? null : consent.telemetryConsent ? 1 : 0,
            consent.at ?? new Date().toISOString(),
          );
        return { written: true, id: Number(result.lastInsertRowid) };
      }

      case 'getLatestConsents': {
        // eula 现值 = subject='eula' 的最新一条（accepted/rejected 均含）；
        // 遥测现值 = telemetry_consent 非空的最新一条（eula accepted 行与 telemetry 开关行统一按 id 时序竞争）
        const eula = db
          .prepare("SELECT * FROM consents WHERE subject = 'eula' ORDER BY id DESC LIMIT 1")
          .get() as Record<string, unknown> | undefined;
        const telemetry = db
          .prepare('SELECT * FROM consents WHERE telemetry_consent IS NOT NULL ORDER BY id DESC LIMIT 1')
          .get() as Record<string, unknown> | undefined;
        return {
          eula: eula ? consentRowToView(eula) : null,
          telemetry: telemetry ? consentRowToView(telemetry) : null,
        };
      }

      case 'upsertNote': {
        // 五面同步 v3：upsert notes（ON CONFLICT 不覆盖首采时间）+ 追加 FR-4.4 快照
        // + 可选 topic_notes 登记（首见 DO NOTHING）。三语句必须同事务（评审 MAJOR 修复，
        // T-M1-04 顺手修）：中途失败整体回滚，杜绝「notes 已写而快照/登记缺失」的半行状态
        // （事务样板同 upsertEmbedding case）。回归守卫见 store/collect-guard.test.ts。
        const note = request.note as NoteInput;
        const now = new Date().toISOString();
        const upsert = (): { upserted: true; id: number; changes: number } => {
          const noteId = db
            .prepare(
              `INSERT INTO notes (note_id, title, content, author_json, likes, collects, comments, tags_json, cover_url, image_urls_json, published_at, collected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (note_id) DO UPDATE SET
                 title = COALESCE(excluded.title, title),
                 content = COALESCE(excluded.content, content),
                 author_json = COALESCE(excluded.author_json, author_json),
                 likes = COALESCE(excluded.likes, likes),
                 collects = COALESCE(excluded.collects, collects),
                 comments = COALESCE(excluded.comments, comments),
                 tags_json = COALESCE(excluded.tags_json, tags_json),
                 cover_url = COALESCE(excluded.cover_url, cover_url),
                 image_urls_json = COALESCE(excluded.image_urls_json, image_urls_json),
                 published_at = COALESCE(excluded.published_at, published_at)`,
            )
            .run(
              note.noteId,
              note.title ?? null,
              note.content ?? null,
              note.author === undefined ? null : JSON.stringify(note.author),
              note.likes ?? 0,
              note.collects ?? 0,
              note.comments ?? 0,
              note.tags === undefined ? null : JSON.stringify(note.tags),
              note.coverUrl ?? null,
              note.imageUrls === undefined ? null : JSON.stringify(note.imageUrls),
              note.publishedAt ?? null,
              note.collectedAt ?? now,
            );
          const row = db.prepare('SELECT id FROM notes WHERE note_id = ?').get(note.noteId) as { id: number };
          db.prepare(
            `INSERT INTO note_snapshots (note_id, likes, collects, comments, captured_at) VALUES (?, ?, ?, ?, ?)`,
          ).run(note.noteId, note.likes ?? 0, note.collects ?? 0, note.comments ?? 0, now);
          if (note.topicId !== undefined) {
            db.prepare(
              `INSERT INTO topic_notes (topic_id, note_id, seen_at) VALUES (?, ?, ?)
               ON CONFLICT (topic_id, note_id) DO NOTHING`,
            ).run(note.topicId, note.noteId, now);
          }
          return { upserted: true, id: Number(row.id), changes: Number(noteId.changes) };
        };
        return db.transaction(upsert)();
      }

      case 'countNoteSnapshots': {
        // FR-4.4 快照观测面（e2e/任务视图消费）：topicId 提供则按 topic_notes 范围计数
        const topicId = request.topicId;
        const row = (
          topicId
            ? db
                .prepare(
                  `SELECT COUNT(*) AS c FROM note_snapshots s JOIN topic_notes tn ON tn.note_id = s.note_id WHERE tn.topic_id = ?`,
                )
                .get(topicId)
            : db.prepare('SELECT COUNT(*) AS c FROM note_snapshots').get()
        ) as { c: number };
        return { count: Number(row.c) };
      }

      case 'listNotes': {
        const filter = request.filter as NoteQueryFilter;
        const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
        const order = filter.order === 'asc' ? 'ASC' : 'DESC';
        const rows = (
          filter.topicId
            ? db
                .prepare(
                  `SELECT n.* FROM notes n JOIN topic_notes tn ON tn.note_id = n.note_id
                   WHERE tn.topic_id = ? ORDER BY n.collected_at ${order}, n.id ${order} LIMIT ${limit}`,
                )
                .all(filter.topicId)
            : db.prepare(`SELECT * FROM notes ORDER BY collected_at ${order}, id ${order} LIMIT ${limit}`).all()
        ) as Array<Record<string, unknown>>;
        return { notes: rows.map(noteRowToView) };
      }

      case 'insertReport': {
        const report = request.report as ReportInput;
        const result = db
          .prepare(
            `INSERT INTO reports (topic, report_json, content_md, model, token_cost, gate_state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            report.topic,
            JSON.stringify(report.report),
            report.contentMd ?? null,
            report.model ?? null,
            report.tokenCost ?? null,
            report.gateState ?? null,
            report.createdAt ?? new Date().toISOString(),
          );
        return { written: true, id: Number(result.lastInsertRowid) };
      }

      case 'getReport': {
        const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(request.reportId) as
          | Record<string, unknown>
          | undefined;
        return { report: row ? reportRowToView(row) : null };
      }

      case 'insertLlmCall': {
        const call = request.call as LlmCallInput;
        const result = db
          .prepare(
            `INSERT INTO llm_calls (trace_id, provider, model, tokens_in, tokens_out, cost, latency_ms, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            call.traceId ?? null,
            call.provider,
            call.model,
            call.tokensIn ?? 0,
            call.tokensOut ?? 0,
            call.cost ?? null,
            call.latencyMs ?? null,
            call.at ?? new Date().toISOString(),
          );
        return { written: true, id: Number(result.lastInsertRowid) };
      }

      case 'appendCircuitEvent': {
        const event = request.event as CircuitEventInput;
        const result = db
          .prepare(`INSERT INTO circuit_events (kind, at, meta_json) VALUES (?, ?, ?)`)
          .run(
            event.kind,
            event.at ?? new Date().toISOString(),
            event.meta === undefined ? null : JSON.stringify(event.meta),
          );
        return { written: true, id: Number(result.lastInsertRowid) };
      }

      case 'listCircuitEvents': {
        const filter = request.filter as CircuitEventFilter;
        const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
        const rows = (
          filter.kind
            ? db.prepare(`SELECT * FROM circuit_events WHERE kind = ? ORDER BY id DESC LIMIT ${limit}`).all(filter.kind)
            : db.prepare(`SELECT * FROM circuit_events ORDER BY id DESC LIMIT ${limit}`).all()
        ) as Array<Record<string, unknown>>;
        return {
          events: rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            meta: parseJsonOrNull(row.meta_json as string | null),
            at: row.at,
          })),
        };
      }

      case 'insertKeywordHit': {
        const hit = request.hit as KeywordHitInput;
        const result = db
          .prepare(
            `INSERT INTO keyword_hits (wordlist_version, term, category, topic_id, at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            hit.wordlistVersion,
            hit.term,
            hit.category ?? null,
            hit.topicId ?? null,
            hit.at ?? new Date().toISOString(),
          );
        return { written: true, id: Number(result.lastInsertRowid) };
      }

      case 'listKeywordHits': {
        const filter = request.filter as KeywordHitFilter;
        const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (filter.topicId) {
          clauses.push('topic_id = ?');
          params.push(filter.topicId);
        }
        if (filter.term) {
          clauses.push('term = ?');
          params.push(filter.term);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = db
          .prepare(`SELECT * FROM keyword_hits ${where} ORDER BY id DESC LIMIT ${limit}`)
          .all(...params) as Array<Record<string, unknown>>;
        return {
          hits: rows.map((row) => ({
            id: row.id,
            wordlistVersion: row.wordlist_version,
            term: row.term,
            category: row.category,
            topicId: row.topic_id,
            at: row.at,
          })),
        };
      }

      case 'kvSet': {
        db.prepare(
          `INSERT INTO kv_config (key, value_blob, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_blob = excluded.value_blob, updated_at = excluded.updated_at`,
        ).run(request.key, request.value, new Date().toISOString());
        return { set: true };
      }

      case 'kvGet': {
        const row = db.prepare('SELECT value_blob FROM kv_config WHERE key = ?').get(request.key) as
          | { value_blob: string | Buffer }
          | undefined;
        return { value: row ? row.value_blob : null };
      }

      case 'kvDel': {
        const result = db.prepare('DELETE FROM kv_config WHERE key = ?').run(request.key);
        return { deleted: Number(result.changes) > 0 };
      }

      case 'upsertCollectRunStats': {
        // 增量语义：ON CONFLICT 按列累加（采集 DAG 逐步上报，免去读改写竞争；
        // 首次插入即从 0 起累加）——门禁①分母公式以 get 读全量合计
        const stats = request.stats as CollectRunStatsInput;
        db.prepare(
          `INSERT INTO collect_run_stats (run_id, completed_unique, duplicate, no_result, rate_limited, captcha_consumed)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id) DO UPDATE SET
             completed_unique = completed_unique + excluded.completed_unique,
             duplicate = duplicate + excluded.duplicate,
             no_result = no_result + excluded.no_result,
             rate_limited = rate_limited + excluded.rate_limited,
             captcha_consumed = captcha_consumed + excluded.captcha_consumed`,
        ).run(
          stats.runId,
          stats.completedUnique ?? 0,
          stats.duplicate ?? 0,
          stats.noResult ?? 0,
          stats.rateLimited ?? 0,
          stats.captchaConsumed ?? 0,
        );
        return { upserted: true };
      }

      case 'getCollectRunStats': {
        const row = db.prepare('SELECT * FROM collect_run_stats WHERE run_id = ?').get(request.runId) as
          | Record<string, unknown>
          | undefined;
        return {
          stats: row
            ? ({
                runId: String(row.run_id),
                completedUnique: Number(row.completed_unique),
                duplicate: Number(row.duplicate),
                noResult: Number(row.no_result),
                rateLimited: Number(row.rate_limited),
                captchaConsumed: Number(row.captcha_consumed),
              } satisfies CollectRunStatsView)
            : null,
        };
      }

      case 'upsertEmbedding': {
        // rowid 全 BigInt（vec0 拒收 REAL，§3-④）；embeddings_cache.id = vec rowid。
        // 命中：刷新 last_used_at/dim 并重写向量（自愈 vec 丢行）；未命中：插入分配 rowid。
        const emb = request.embedding as EmbeddingUpsertInput;
        const now = new Date().toISOString();
        const buf = toVectorBuffer(emb.vector);
        const upsert = (): EmbeddingUpsertResult => {
          const existing = db
            .prepare('SELECT id FROM embeddings_cache WHERE provider = ? AND model = ? AND input_sha256 = ?')
            .get(emb.provider, emb.model, emb.inputSha256) as { id: number | bigint } | undefined;
          if (existing) {
            const rowid = BigInt(existing.id);
            db.prepare('UPDATE embeddings_cache SET dim = ?, last_used_at = ? WHERE id = ?').run(
              emb.dim,
              emb.lastUsedAt ?? now,
              rowid,
            );
            db.prepare('DELETE FROM embeddings_vec WHERE rowid = ?').run(rowid);
            db.prepare('INSERT INTO embeddings_vec (rowid, embedding) VALUES (?, ?)').run(rowid, buf);
            return { upserted: true, rowid };
          }
          const result = db
            .prepare(
              `INSERT INTO embeddings_cache (provider, model, input_sha256, dim, created_at, last_used_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(emb.provider, emb.model, emb.inputSha256, emb.dim, emb.createdAt ?? now, emb.lastUsedAt ?? now);
          const rowid = BigInt(result.lastInsertRowid);
          db.prepare('INSERT INTO embeddings_vec (rowid, embedding) VALUES (?, ?)').run(rowid, buf);
          return { upserted: true, rowid };
        };
        return db.transaction(upsert)();
      }

      case 'knnTopK': {
        // vec0 KNN 约束：MATCH + ORDER BY distance + LIMIT 必须直落虚拟表（JOIN 形态
        // 会被 vec0 判为缺失 LIMIT 拒绝）——先纯 vec0 查 topK，再按 rowid 批量取缓存元数据
        const query = request.query as KnnQuery;
        const k = Math.min(Math.max(query.k ?? 5, 1), 100);
        const knnRows = db
          .prepare(`SELECT rowid, distance FROM embeddings_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ${k}`)
          .all(toVectorBuffer(query.vector)) as Array<{ rowid: number | bigint; distance: number }>;
        if (knnRows.length === 0) return { hits: [] };
        const placeholders = knnRows.map(() => '?').join(', ');
        const metaRows = db
          .prepare(`SELECT id, provider, model, input_sha256, dim FROM embeddings_cache WHERE id IN (${placeholders})`)
          .all(...knnRows.map((r) => BigInt(r.rowid))) as Array<Record<string, unknown>>;
        const metaById = new Map(metaRows.map((m) => [BigInt(m.id as number | bigint), m]));
        return {
          hits: knnRows.map((r) => {
            const meta = metaById.get(BigInt(r.rowid));
            return {
              rowid: BigInt(r.rowid),
              distance: r.distance,
              provider: meta ? String(meta.provider) : '',
              model: meta ? String(meta.model) : '',
              inputSha256: meta ? String(meta.input_sha256) : '',
              dim: meta ? Number(meta.dim) : 0,
            };
          }),
        };
      }

      case 'pruneEmbeddingsCache': {
        // FR-10.3 本地保留口径：last_used_at 超 EMBEDDINGS_RETENTION_DAYS 天清理
        // （provider-matrix §4.2「N 由 M1 定」→ 180）；vec 行随 cache 行同批删除，
        // 调度挂接归既有 retention 模式（本卡只提供方法）
        const cutoff = addDaysIso(new Date().toISOString(), -EMBEDDINGS_RETENTION_DAYS);
        const vecDeleted = db
          .prepare('DELETE FROM embeddings_vec WHERE rowid IN (SELECT id FROM embeddings_cache WHERE last_used_at < ?)')
          .run(cutoff);
        const cacheDeleted = db.prepare('DELETE FROM embeddings_cache WHERE last_used_at < ?').run(cutoff);
        return { cacheDeleted: Number(cacheDeleted.changes), vecDeleted: Number(vecDeleted.changes) };
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

function consentRowToView(row: Record<string, unknown>): ConsentRowView {
  return {
    id: Number(row.id),
    subject: String(row.subject),
    action: String(row.action),
    eulaVersion: (row.eula_version as string | null) ?? null,
    telemetryConsent: row.telemetry_consent === null || row.telemetry_consent === undefined ? null : Number(row.telemetry_consent) === 1,
    createdAt: String(row.created_at),
  };
}

function noteRowToView(row: Record<string, unknown>): NoteRowView {
  return {
    id: Number(row.id),
    noteId: String(row.note_id),
    title: (row.title as string | null) ?? null,
    content: (row.content as string | null) ?? null,
    author: parseJsonOrNull(row.author_json as string | null),
    likes: Number(row.likes),
    collects: Number(row.collects),
    comments: Number(row.comments),
    tags: parseJsonOrNull(row.tags_json as string | null),
    coverUrl: (row.cover_url as string | null) ?? null,
    imageUrls: parseJsonOrNull(row.image_urls_json as string | null),
    publishedAt: (row.published_at as string | null) ?? null,
    collectedAt: String(row.collected_at),
  };
}

function reportRowToView(row: Record<string, unknown>): ReportRowView {
  return {
    id: Number(row.id),
    topic: String(row.topic),
    report: parseJsonOrNull(row.report_json as string | null),
    contentMd: (row.content_md as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    tokenCost: row.token_cost === null || row.token_cost === undefined ? null : Number(row.token_cost),
    gateState: (row.gate_state as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

/** vec0 绑定统一为 float32 小端字节 Buffer（Float32Array 与 Buffer 双形态入参归一） */
function toVectorBuffer(vector: Buffer | Float32Array): Buffer {
  if (vector instanceof Float32Array) {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  }
  return vector;
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

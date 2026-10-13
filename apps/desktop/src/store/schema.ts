/**
 * store 表结构（drizzle sqlite-core；对齐 02-系统架构设计.md §14.1 客户端 SQLite 表）。
 *
 * M0 落地四表：logs / tasks / task_steps / task_events（02:715 / 02:708 / 02:709-710）；
 * 其余业务表（notes/reports/... ）随 M1+ 迁移链版本追加，不在 0001。
 * DDL 真源在 migrations.ts（0001），本文件是同一结构的 drizzle 投影（类型化查询用）。
 */
import { blob, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** 五类日志（FR-10.1；02:715 logs 行 + 任务卡：level/category/trace_id/span_id/payload_json/created_at） */
export const logs = sqliteTable(
  'logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: text('ts').notNull(),
    createdAt: text('created_at').notNull(),
    level: integer('level').notNull(),
    levelName: text('level_name').notNull(),
    category: text('category').notNull(),
    traceId: text('trace_id'),
    spanId: text('span_id'),
    msg: text('msg').notNull(),
    payloadJson: text('payload_json'),
    shotPath: text('shot_path'),
  },
  (t) => [
    index('idx_logs_created_at').on(t.createdAt),
    index('idx_logs_trace').on(t.traceId),
    index('idx_logs_category_created').on(t.category, t.createdAt),
  ],
);

/** 任务主表（02:708 tasks 行；§9.1 状态机宏状态落 status 列） */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    payloadJson: text('payload_json'),
    priority: integer('priority').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_tasks_status').on(t.status), index('idx_tasks_kind').on(t.kind)],
);

/** 步骤检查点（02:709 task_steps 行；§6.1 检查点语义：步骤成功后落 output） */
export const taskSteps = sqliteTable(
  'task_steps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: text('task_id').notNull(),
    stepId: text('step_id').notNull(),
    seq: integer('seq').notNull(),
    status: text('status').notNull(),
    outputJson: text('output_json'),
    checkpointAt: text('checkpoint_at'),
  },
  (t) => [
    uniqueIndex('ux_task_steps_task_step').on(t.taskId, t.stepId),
    index('idx_task_steps_task_seq').on(t.taskId, t.seq),
  ],
);

/** 状态迁移流水（02:710 task_events 行；§9.1 持久化规则：每次迁移写 tasks + task_events） */
export const taskEvents = sqliteTable(
  'task_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: text('task_id').notNull(),
    type: text('type').notNull(),
    fromState: text('from_state'),
    toState: text('to_state'),
    payloadJson: text('payload_json'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_task_events_task_created').on(t.taskId, t.createdAt)],
);

/** 迁移链记账（版本化迁移 runner 的基础设施表；见 migrations.ts） */
export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  appliedAt: text('applied_at').notNull(),
});

/**
 * 合规同意留痕（todo 9：FR-1.9 EULA 确认记录 / FR-12.6 遥测 opt-in；0002 迁移追加）。
 * 追加式事件行；现值由消费方按「最新一条」解析（DDL 真源在 migrations.ts 0002）。
 */
export const consents = sqliteTable(
  'consents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subject: text('subject').notNull(),
    action: text('action').notNull(),
    eulaVersion: text('eula_version'),
    telemetryConsent: integer('telemetry_consent'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_consents_subject').on(t.subject, t.id),
    index('idx_consents_tele_consent').on(t.telemetryConsent, t.id),
  ],
);

/* -------------------- M1 store v3（0003 迁移投影；DDL 真源 migrations.ts upV3） -------------------- */

/** 采集笔记主表（02:703-704；note_id 全局去重，collected_at = 首采时间不随 upsert 覆盖） */
export const notes = sqliteTable(
  'notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    noteId: text('note_id').notNull(),
    title: text('title'),
    content: text('content'),
    /** 本地最小化保留原文（author 昵称/ID/粉丝数 JSON）；去标识化仅作用于外发 payload */
    authorJson: text('author_json'),
    likes: integer('likes').notNull().default(0),
    collects: integer('collects').notNull().default(0),
    comments: integer('comments').notNull().default(0),
    tagsJson: text('tags_json'),
    coverUrl: text('cover_url'),
    imageUrlsJson: text('image_urls_json'),
    publishedAt: text('published_at'),
    collectedAt: text('collected_at').notNull(),
  },
  (t) => [uniqueIndex('ux_notes_note_id').on(t.noteId), index('idx_notes_collected').on(t.collectedAt)],
);

/** 主题 × 笔记登记（topic_id 去重 UNIQUE；seen_at = 首见时间） */
export const topicNotes = sqliteTable(
  'topic_notes',
  {
    topicId: text('topic_id').notNull(),
    noteId: text('note_id').notNull(),
    seenAt: text('seen_at').notNull(),
  },
  (t) => [uniqueIndex('ux_topic_notes_topic_note').on(t.topicId, t.noteId)],
);

/** FR-4.4 追加式互动快照（重复采集每次观测追加一行） */
export const noteSnapshots = sqliteTable(
  'note_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    noteId: text('note_id').notNull(),
    likes: integer('likes').notNull().default(0),
    collects: integer('collects').notNull().default(0),
    comments: integer('comments').notNull().default(0),
    capturedAt: text('captured_at').notNull(),
  },
  (t) => [index('idx_note_snapshots_note').on(t.noteId, t.capturedAt)],
);

/** 八章节报告（02:708-710 reports 行；gate_state = 关键词确认闸门状态） */
export const reports = sqliteTable(
  'reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    topic: text('topic').notNull(),
    reportJson: text('report_json').notNull(),
    contentMd: text('content_md'),
    model: text('model'),
    tokenCost: integer('token_cost'),
    gateState: text('gate_state'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_reports_topic').on(t.topic, t.createdAt)],
);

/** LLM 计量（02:714；FR-2.5 用量面板按 at 聚合） */
export const llmCalls = sqliteTable(
  'llm_calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    traceId: text('trace_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    cost: real('cost'),
    latencyMs: integer('latency_ms'),
    at: text('at').notNull(),
  },
  (t) => [index('idx_llm_calls_at').on(t.at), index('idx_llm_calls_trace').on(t.traceId)],
);

/** 熔断/配额/自检失败本地账本（FR-9.5 抽查证据源；只记事件元数据） */
export const circuitEvents = sqliteTable(
  'circuit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    at: text('at').notNull(),
    metaJson: text('meta_json'),
  },
  (t) => [index('idx_circuit_events_at').on(t.at)],
);

/** FR-9.6 词库命中留痕（词库本体走配置包 JSON，不建内容表——02:763） */
export const keywordHits = sqliteTable(
  'keyword_hits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    wordlistVersion: text('wordlist_version').notNull(),
    term: text('term').notNull(),
    category: text('category'),
    topicId: text('topic_id'),
    at: text('at').notNull(),
  },
  (t) => [index('idx_keyword_hits_at').on(t.at)],
);

/** 本地 KV（safeStorage 密文 Buffer / JSON 字符串同列；BLOB 亲和） */
export const kvConfig = sqliteTable('kv_config', {
  key: text('key').primaryKey(),
  valueBlob: blob('value_blob').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 门禁①采集分母公式数据源（run_id 去重；计数器 worker 侧增量累加） */
export const collectRunStats = sqliteTable('collect_run_stats', {
  runId: text('run_id').primaryKey(),
  completedUnique: integer('completed_unique').notNull().default(0),
  duplicate: integer('duplicate').notNull().default(0),
  noResult: integer('no_result').notNull().default(0),
  rateLimited: integer('rate_limited').notNull().default(0),
  captchaConsumed: integer('captcha_consumed').notNull().default(0),
});

/**
 * 本地嵌入缓存（provider-matrix §4.2 注记落地；id 显式 = embeddings_vec rowid，
 * 绑定一律 BigInt）。embeddings_vec 本身是 vec0 虚拟表，drizzle sqlite-core
 * 无法建模，不设投影——仅 raw SQL（DDL 真源 migrations.ts upV3，dim=2048 单表）。
 */
export const embeddingsCache = sqliteTable(
  'embeddings_cache',
  {
    id: integer('id').primaryKey(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputSha256: text('input_sha256').notNull(),
    dim: integer('dim').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at').notNull(),
  },
  (t) => [
    uniqueIndex('ux_embeddings_cache_key').on(t.provider, t.model, t.inputSha256),
    index('idx_embeddings_cache_last_used').on(t.lastUsedAt),
  ],
);

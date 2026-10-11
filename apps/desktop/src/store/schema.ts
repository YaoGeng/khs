/**
 * store 表结构（drizzle sqlite-core；对齐 02-系统架构设计.md §14.1 客户端 SQLite 表）。
 *
 * M0 落地四表：logs / tasks / task_steps / task_events（02:715 / 02:708 / 02:709-710）；
 * 其余业务表（notes/reports/... ）随 M1+ 迁移链版本追加，不在 0001。
 * DDL 真源在 migrations.ts（0001），本文件是同一结构的 drizzle 投影（类型化查询用）。
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

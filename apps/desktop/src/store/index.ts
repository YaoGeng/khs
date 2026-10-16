/**
 * store 门面（主进程消费入口）：把 client / worker-host / 日志落库 sink 组装起来。
 * electron-free 面 = createStoreClient（client.ts）；electron 面 = worker-host.ts。
 */
export { createStoreClient, StoreClientError } from './client';
export type { StoreClient, StoreClientOptions, StoreStats, StoreTransport } from './client';
export { EMBEDDINGS_RETENTION_DAYS, STORE_ERROR_CODES, TASK_STATUS_VALUES, isTaskStatus } from './protocol';
export type {
  CircuitEventFilter,
  CircuitEventInput,
  CircuitEventRowView,
  CollectRunStatsInput,
  CollectRunStatsView,
  CreateTaskInput,
  EmbeddingUpsertInput,
  EmbeddingUpsertResult,
  KeywordHitFilter,
  KeywordHitInput,
  KeywordHitRowView,
  KnnHit,
  KnnQuery,
  LogQueryFilter,
  LogRowInput,
  LogRowView,
  LlmCallInput,
  NoteInput,
  NoteQueryFilter,
  NoteRowView,
  ReportInput,
  ReportRowView,
  SourcingCandidateFilter,
  SourcingCandidateInput,
  SourcingCandidateRowView,
  StepInput,
  StepRowView,
  StoreRequest,
  StoreResponse,
  TaskEventInput,
  TaskEventRowView,
  TaskRowView,
  TaskStatus,
  TaskStatusInput,
  KvValue,
} from './protocol';
export { MIGRATIONS, MigrationError, currentVersion, runMigrations, appliedVersions } from './migrations';
export type { MigrationStep, MigrateOptions, MigrateReport, MigrationErrorCode } from './migrations';
export { openAndMigrate, migrateBeforeWindow, applyWritePragmas, STORE_PRAGMAS } from './db';
export { MAX_BATCH_ROWS, handleStoreRequest } from './worker';
export { createUtilityProcessTransport } from './worker-host';
export { asarUnpackPath, loadSqliteVec, vecLoadablePath } from './vec';
export {
  tasks,
  taskSteps,
  taskEvents,
  logs,
  schemaMigrations,
  consents,
  notes,
  topicNotes,
  noteSnapshots,
  reports,
  llmCalls,
  circuitEvents,
  keywordHits,
  kvConfig,
  collectRunStats,
  embeddingsCache,
} from './schema';
export type { ConsentInput, ConsentRowView, ConsentSubject } from './protocol';

/**
 * store 门面（主进程消费入口）：把 client / worker-host / 日志落库 sink 组装起来。
 * electron-free 面 = createStoreClient（client.ts）；electron 面 = worker-host.ts。
 */
export { createStoreClient, StoreClientError } from './client';
export type { StoreClient, StoreClientOptions, StoreStats, StoreTransport } from './client';
export { STORE_ERROR_CODES } from './protocol';
export type {
  CreateTaskInput,
  LogQueryFilter,
  LogRowInput,
  LogRowView,
  StepInput,
  StepRowView,
  StoreRequest,
  StoreResponse,
  TaskEventInput,
  TaskEventRowView,
  TaskRowView,
  TaskStatus,
  TaskStatusInput,
} from './protocol';
export { MIGRATIONS, MigrationError, currentVersion, runMigrations, appliedVersions } from './migrations';
export type { MigrationStep, MigrateOptions, MigrateReport, MigrationErrorCode } from './migrations';
export { openAndMigrate, migrateBeforeWindow, applyWritePragmas, STORE_PRAGMAS } from './db';
export { MAX_BATCH_ROWS, handleStoreRequest } from './worker';
export { createUtilityProcessTransport } from './worker-host';
export { tasks, taskSteps, taskEvents, logs, schemaMigrations } from './schema';

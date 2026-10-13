/**
 * main 进程 store/日志/运行器装配（todo 11；ADR-8 §6 选型 B）。
 *
 * 启动时序（main.ts 调用）：
 * 1. migrateBeforeWindow：窗口创建前一次性迁移直写（ADR-8 §6①；用后即闭不持连接）；
 * 2. createStoreService：fork 写 worker（唯一写者）+ 日志管线（NDJSON 文件 + store sink）；
 * 3. recoverOnBoot：running → suspended 降级（02:453）；
 * 4. 保留策略：启动时清一次 + 每 24h 定时（FR-10.3）。
 */
import path from 'node:path';
import process from 'node:process';
import { createLogger, type Logger } from '@xinglian/logger';
import { createUtilityProcessTransport, createStoreClient, migrateBeforeWindow, type MigrateReport, type StoreClient } from '../store';
import type { StoreTransport } from '../store/client';
import { createStoreLogSink } from '../logs/store-sink';
import { createTaskRunner, type TaskRunner } from '../tasks';
import type { LogTaskIpcDeps } from './ipc-core';
import type { LogsQueryParams } from '../shared/schemas';

export interface StorePaths {
  dbFile: string;
  logsDir: string;
}

export interface StoreService {
  readonly migration: MigrateReport;
  readonly store: StoreClient;
  readonly logger: Logger;
  readonly runner: TaskRunner;
  /** 启动恢复完成（running→suspended 降级任务 id 列表） */
  readonly recoveredTaskIds: Promise<string[]>;
  readonly ipc: LogTaskIpcDeps;
  shutdown(): Promise<void>;
}

/** dev/test seam：测试经 env 注入 db/logs 路径（与 XINGLIAN_LICENSE_FILE 同风格） */
export function resolveStorePaths(userDataDir: string): StorePaths {
  const dbFile = process.env.XINGLIAN_DB_FILE ?? path.join(userDataDir, 'xinglian.db');
  const logsDir = process.env.XINGLIAN_LOGS_DIR ?? path.join(userDataDir, 'logs');
  return { dbFile, logsDir };
}

/** 窗口创建前的迁移直写（失败可直接抛：主进程无法无库运行，报错可读优先） */
export function runPreWindowMigration(dbFile: string): MigrateReport {
  return migrateBeforeWindow(dbFile);
}

export function createStoreService(paths: StorePaths, workerPath: string): StoreService {
  const store = createStoreClient({
    dbFile: paths.dbFile,
    createTransport: (): StoreTransport => createUtilityProcessTransport(workerPath, 'xinglian-store'),
  });

  const storeSink = createStoreLogSink(store, { batchRows: 50, flushIntervalMs: 500 });
  const logger = createLogger({
    logsDir: paths.logsDir,
    sinks: [storeSink],
    level: 'info',
    memoryBufferSize: 500,
  });

  // e2e/dev seam：拉长 demo 步骤时长，给「接管 → 杀浏览器 → 断言 suspended」留出确定性窗口
  const demoStepDelayMs = Number(process.env.XINGLIAN_DEMO_STEP_DELAY_MS ?? '');
  const runner = createTaskRunner({
    store,
    logger,
    ...(Number.isFinite(demoStepDelayMs) && demoStepDelayMs > 0 ? { stepDelayMs: demoStepDelayMs } : {}),
  });

  // 启动恢复在 worker ready 后执行；IPC handlers 先注册（查询在恢复完成前返回旧值是可接受竞态）
  const recoveredTaskIds = store
    .whenReady()
    .then((schemaVersion) => {
      logger.systemError('store-worker-ready', { dbFile: paths.dbFile, schemaVersion });
      return runner.recoverOnBoot();
    })
    .catch((error: unknown) => {
      logger.systemError('store-boot-failed', { err: String((error as Error).message) });
      return [] as string[];
    });

  // FR-10.3 保留策略：启动清一次 + 每 24h 定时（unref：不阻止进程退出）
  const retentionTimer = setInterval(() => {
    void logger.enforceRetention();
  }, 24 * 60 * 60 * 1000);
  retentionTimer.unref?.();
  void recoveredTaskIds.then(() => logger.enforceRetention());

  const ipc: LogTaskIpcDeps = {
    async queryLogs(params: LogsQueryParams) {
      await recoveredTaskIds;
      const rows = await store.queryLogs({
        traceId: params.traceId,
        spanId: params.spanId,
        category: params.category,
        limit: params.limit,
        order: params.order,
      });
      return { rows };
    },
    async createDemoTask() {
      const taskId = await runner.startDemo();
      return { taskId };
    },
    async listTasks() {
      return { tasks: await runner.listTaskViews() };
    },
    async resumeTask(taskId: string) {
      const status = await runner.resume(taskId);
      return { taskId, status };
    },
    async pauseTask(taskId: string) {
      const status = await runner.pause(taskId, 'user-pause');
      return { taskId, status: status ?? 'running' };
    },
    async cancelTask(taskId: string) {
      const status = await runner.cancel(taskId);
      return { taskId, status };
    },
  };

  return {
    migration: { fromVersion: 0, toVersion: 0, applied: [] } as MigrateReport, // 由 main.ts 回填（直写在先）
    store,
    logger,
    runner,
    recoveredTaskIds,
    ipc,
    async shutdown() {
      clearInterval(retentionTimer);
      await logger.close();
      await store.close();
    },
  };
}

/** main.ts 把直写迁移报告回填到服务对象（仅诊断展示用） */
export function attachMigrationReport(service: StoreService, migration: MigrateReport): void {
  (service as { migration: MigrateReport }).migration = migration;
}

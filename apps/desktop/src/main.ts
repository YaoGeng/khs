/**
 * 星链桌面壳主进程入口（映射 T-M0-02 / 02-系统架构设计.md §4.1-§4.3、§11.2；
 * todo 11：store/日志/任务运行器接入——迁移直写在窗口创建前（ADR-8 §6①））。
 *
 * 职责：单实例锁 → app 'ready' → 窗口前迁移（一次性直写）→ 注册 IPC（zod 校验）
 * → 开主窗口（安全基线 webPreferences）→ did-finish-load 结算冷启动样本（C-3 实测）
 * → 延迟加载重模块（C-3 招一；store worker 的 fork 为异步旁路，不阻塞窗口路径）。
 */
import { app, BrowserWindow } from 'electron';
import { CONTRACT_VERSION } from './shared/channels';
import { registerIpcHandlers } from './main/ipc';
import { createLicenseService } from './main/license-service';
import { createDeferredBootstrap } from './main/lazy';
import { createMainWindow } from './main/window';
import { loadHeavyModules } from './main/heavy';
import { attachMigrationReport, createStoreService, resolveStorePaths, runPreWindowMigration, type StoreService } from './main/store-service';

/** 冷启动计时起点：main 入口被求值的时刻（spawn 后第一个可测点） */
const T0 = process.hrtime.bigint();
let readyMs = 0;

function msSince(from: bigint): number {
  return Number(process.hrtime.bigint() - from) / 1e6;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// C-3 招一：重模块延迟到窗口首帧之后（见 main/lazy.ts）
const heavyBootstrap = createDeferredBootstrap(async () => loadHeavyModules());

// 冷启动基准模式（scripts/cold-start.mjs 传入）：样本打印后自动退出，供脚本循环采样
const isColdStartBench = process.argv.includes('--cold-start-bench');

// dev/test seam：测试注入独立 userData（license/db/logs 均随其隔离）
const userDirOverride = process.env.XINGLIAN_USER_DATA;
if (userDirOverride) {
  app.setPath('userData', userDirOverride);
}

// todo 11：store/日志/运行器服务（worker fork 为异步；ready 前注册的 IPC 依赖其 promise）
let storeService: StoreService | null = null;

// 02 §4.2 shell 行「单实例锁」：二次启动直接退出，由已有实例接管（second-instance 聚焦）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  void app.whenReady().then(() => {
    readyMs = msSince(T0);

    const paths = resolveStorePaths(app.getPath('userData'));
    // ADR-8 §6①：一次性迁移直写（任何 BrowserWindow 之前；损坏库→可读错误并退出）
    const migration = runPreWindowMigration(paths.dbFile);
    console.log(
      '[store] pre-window migration:',
      JSON.stringify({ from: migration.fromVersion, to: migration.toVersion, steps: migration.applied.length }),
    );

    storeService = createStoreService(paths, `${__dirname}/store-worker.js`);
    attachMigrationReport(storeService, migration);

    registerIpcHandlers({
      appInfo: () => ({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? '',
        platform: process.platform,
        contractVersion: CONTRACT_VERSION,
      }),
      // todo 8：license 链路（离线验签 + 72h 宽限状态机 + license 文件持久化）
      license: createLicenseService(app.getPath('userData')),
      // todo 11：logs:query + demo 任务运行器
      logTask: storeService.ipc,
    });

    createMainWindow({
      onDidFinishLoad: () => {
        const totalMs = msSince(T0);
        // 冷启动实测输出：scripts/cold-start.mjs 捕获本行（NFR-1 ≤3s，docs/perf/cold-start-measured.md）
        console.log(
          '[cold-start]',
          JSON.stringify({
            readyMs: round2(readyMs),
            domReadyMs: round2(totalMs - readyMs),
            totalMs: round2(totalMs),
          }),
        );
        heavyBootstrap.bootstrapAfterWindowReady();
        if (isColdStartBench) {
          // 留 150ms 让 stdout（pipe）冲刷完成再退出
          setTimeout(() => app.quit(), 150);
        }
      },
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void app.whenReady().then(() => {
        createMainWindow();
      });
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    void storeService?.shutdown();
  });
}

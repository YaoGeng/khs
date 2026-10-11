/**
 * 星链桌面壳主进程入口（映射 T-M0-02 / 02-系统架构设计.md §4.1-§4.3、§11.2）。
 *
 * 职责：单实例锁 → app 'ready' → 注册 IPC（zod 校验）→ 开主窗口（安全基线 webPreferences）
 * → did-finish-load 结算冷启动样本（C-3 实测）→ 延迟加载重模块（C-3 招一）。
 * 业务模块（store/logger/workflow/browser-service 等）M0 一律不在此引入。
 */
import { app, BrowserWindow } from 'electron';
import { CONTRACT_VERSION } from './shared/channels';
import { registerIpcHandlers } from './main/ipc';
import { createLicenseService } from './main/license-service';
import { createDeferredBootstrap } from './main/lazy';
import { createMainWindow } from './main/window';
import { loadHeavyModules } from './main/heavy';

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

    registerIpcHandlers({
      appInfo: () => ({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? '',
        platform: process.platform,
        contractVersion: CONTRACT_VERSION,
      }),
      // todo 8：license 链路（离线验签 + 72h 宽限状态机 + license 文件持久化）
      license: createLicenseService(app.getPath('userData')),
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
}

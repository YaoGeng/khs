/**
 * 星链桌面壳主进程入口（映射 T-M0-02 / 02-系统架构设计.md §4.1-§4.3、§11.2；
 * todo 11：store/日志/任务运行器接入——迁移直写在窗口创建前（ADR-8 §6①））。
 *
 * 职责：单实例锁 → app 'ready' → 窗口前迁移（一次性直写）→ 注册 IPC（zod 校验）
 * → 开主窗口（安全基线 webPreferences）→ did-finish-load 结算冷启动样本（C-3 实测）
 * → 延迟加载重模块（C-3 招一；store worker 的 fork 为异步旁路，不阻塞窗口路径）。
 */
import { app, BrowserWindow } from 'electron';
import { EULA_LOCKED_VIEWS, CONTRACT_VERSION } from './shared/channels';
import { registerIpcHandlers } from './main/ipc';
import { createComplianceService, type ComplianceService } from './compliance/compliance-service';
import { resolveEulaVersion } from './compliance/eula';
import { createLicenseService } from './main/license-service';
import { createDeferredBootstrap } from './main/lazy';
import { createMainWindow } from './main/window';
import { loadHeavyModules } from './main/heavy';
import { attachMigrationReport, createStoreService, resolveStorePaths, runPreWindowMigration, type StoreService } from './main/store-service';
import { BrowserService } from './browser/browser-service';
import { resolveProfileRoot } from './browser/profiles';

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

// todo 9：合规服务（EULA 首启确认门 + 遥测 opt-in；确认记录经 store 落 consents 表）
let complianceService: ComplianceService | null = null;

// todo 10：受控浏览器接管服务（FR-3；崩溃联动挂起 running 任务，profile 随 e2e/dev seam 隔离）
let browserService: BrowserService | null = null;

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

    // todo 9：合规服务（dev/test seam：XINGLIAN_EULA_VERSION 覆盖 EULA 版本模拟升级重确认）
    complianceService = createComplianceService({
      store: storeService.store,
      eulaVersion: resolveEulaVersion(),
      lockedViews: EULA_LOCKED_VIEWS,
      onLocalRecord: (record) => storeService?.logger.userAction(record.msg, record.payload),
    });

    // todo 10：受控浏览器服务（FR-3；崩溃联动 → T11 runner 挂起；Profile 根目录：
    // %LOCALAPPDATA%/xinglian-workbench/cdp-profiles，e2e 经 XINGLIAN_CDP_PROFILE_ROOT 隔离）
    browserService = new BrowserService({
      logger: storeService.logger,
      profileRoot: resolveProfileRoot({
        localAppData: process.env.LOCALAPPDATA ?? app.getPath('userData'),
        override: process.env.XINGLIAN_CDP_PROFILE_ROOT ?? null,
      }),
      // S6 结论路线 A = pipe（零 TCP 暴露面）；port=0 fallback 是显式配置项，默认关闭
      transportMode: process.env.XINGLIAN_CDP_TRANSPORT === 'port' ? 'port' : 'pipe',
      // e2e/dev seam：健康检测周期覆盖（默认 10s；FR-3.4）
      healthIntervalMs: Number(process.env.XINGLIAN_BROWSER_HEALTH_MS) || undefined,
      userSettingPath: process.env.XINGLIAN_BROWSER_PATH ?? null,
      suspendRunningTasks: async (reason) => {
        if (!storeService) return [];
        const running = await storeService.store.listTasks('running');
        const suspended: string[] = [];
        for (const task of running) {
          const status = await storeService.runner.suspend(task.id, reason);
          if (status === 'suspended') suspended.push(task.id);
        }
        return suspended;
      },
    });

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
      // todo 9：EULA 首启确认门 + 遥测 opt-in
      consent: complianceService.ipc,
      // todo 10：受控浏览器接管（browser:status / browser:openPlatform / browser:disconnect）
      browser: {
        status: () => browserService?.status() ?? Promise.reject(new Error('browser service 未就绪')),
        openPlatform: (params) => browserService?.openPlatform(params) ?? Promise.reject(new Error('browser service 未就绪')),
        disconnect: () => browserService?.disconnect() ?? Promise.reject(new Error('browser service 未就绪')),
      },
    });

    // e2e/测试钩子（仅显式 env 门控；生产不暴露）：让位机制与崩溃联动的进程内驱动入口
    if (process.env.XINGLIAN_DEBUG_HOOKS === '1') {
      (globalThis as unknown as Record<string, unknown>).__xinglianDebug = {
        browser: {
          yieldToUser: (source: 'user-input' | 'manual' | 'e2e-hook', reason?: string) => browserService?.yieldToUser(source, reason),
          resumeFromYield: (reason?: string) => browserService?.resumeFromYield(reason),
          navigateTab: (url: string) => browserService?.navigateTab(url),
        },
      };
    }

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

  // 退出前清理：受控浏览器（CDP Browser.close → Profile 冲刷，不留孤儿 Chrome）+ store。
  // 两段式 quit：will-quit 先 preventDefault，等浏览器优雅退出（cookies 落盘）后再次 quit。
  let quitCleanupDone = false;
  app.on('will-quit', (event) => {
    if (quitCleanupDone) {
      return;
    }
    event.preventDefault();
    storeService?.logger.systemError('app-quit-phase1-start', {});
    void (async () => {
      try {
        await browserService?.shutdown();
        storeService?.logger.systemError('app-quit-browser-closed', {});
        await storeService?.shutdown();
        storeService?.logger.systemError('app-quit-store-closed', {});
      } catch (error) {
        storeService?.logger.systemError('app-quit-phase1-failed', { err: String((error as Error).message) });
      } finally {
        quitCleanupDone = true;
        app.quit();
      }
    })();
  });
}

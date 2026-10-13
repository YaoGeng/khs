/**
 * 星链桌面壳主进程入口（映射 T-M0-02 / 02-系统架构设计.md §4.1-§4.3、§11.2；
 * todo 11：store/日志/任务运行器接入——迁移直写在窗口创建前（ADR-8 §6①））。
 *
 * 职责：单实例锁 → app 'ready' → 窗口前迁移（一次性直写）→ 注册 IPC（zod 校验）
 * → 开主窗口（安全基线 webPreferences）→ did-finish-load 结算冷启动样本（C-3 实测）
 * → 延迟加载重模块（C-3 招一；store worker 的 fork 为异步旁路，不阻塞窗口路径）。
 */
import { app, BrowserWindow, Notification } from 'electron';
import { join } from 'node:path';
import { EULA_LOCKED_VIEWS, CONTRACT_VERSION } from './shared/channels';
import { registerIpcHandlers } from './main/ipc';
import { createComplianceService, type ComplianceService } from './compliance/compliance-service';
import { resolveEulaVersion } from './compliance/eula';
import { createLicenseService } from './main/license-service';
import { createDeferredBootstrap } from './main/lazy';
import { createMainWindow } from './main/window';
import { loadHeavyModules } from './main/heavy';
import { attachMigrationReport, createStoreService, resolveStorePaths, runPreWindowMigration, type StoreService } from './main/store-service';
import { createCollectBinding, type CollectBinding } from './main/collect-binding';
import { createElectronSafeStoragePort } from './main/safe-storage-port';
import { createKeyService, type KeyService } from './main/key-service';
import { createWordlistService, type WordlistService } from './compliance/wordlist-service';
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

// todo 7：采集链路绑定（熔断器/日配额/适配包/mock-CDP seam/让位监视；T-M1-04）
let collectBinding: CollectBinding | null = null;

// m1 todo 10：词库配置包服务（seed→sha256 manifest→fs watch 热更；T-M1-08②）
let wordlistService: WordlistService | null = null;

// m1 todo 10：BYOK Key 服务（safeStorage 经注入 Port；masked 出口断言在 ipc-core；T-M1-08①）
let keyService: KeyService | null = null;

/** 桌面通知（Electron Notification；不可用环境静默降级为日志，e2e/CI 无通知中心） */
function showDesktopNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

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

    // todo 7：采集链路绑定（熔断/配额/适配包/让位监视；fixture seam = XINGLIAN_COLLECT_FIXTURE）
    collectBinding = createCollectBinding({
      store: storeService.store,
      runner: storeService.runner,
      logger: storeService.logger,
      compliance: complianceService,
      notify: showDesktopNotification,
      userDataDir: app.getPath('userData'),
      browser: {
        prepareAutomationTab: () => browserService!.prepareAutomationTab(),
        whenAutomationAllowed: () => browserService!.whenAutomationAllowed(),
        yieldToUser: (source, reason) => browserService!.yieldToUser(source, reason),
        resumeFromYield: (reason) => browserService!.resumeFromYield(reason),
      },
      // pacingScale=0 是合法值（测试/e2e 消除真实等待），不能用 ||1 兜底
      pacingScale: Number.isFinite(Number(process.env.XINGLIAN_COLLECT_PACING_SCALE))
        && Number(process.env.XINGLIAN_COLLECT_PACING_SCALE) >= 0
        ? Number(process.env.XINGLIAN_COLLECT_PACING_SCALE)
        : 1,
    });

    // m1 todo 10：词库服务（配置包根 = <userData>/config/wordlist；seed 首启落盘 + fs watch 热更）
    const storeClient = storeService.store;
    wordlistService = createWordlistService({
      root: join(app.getPath('userData'), 'config', 'wordlist'),
      kvGet: (key) => storeClient.kvGet(key),
      kvSet: (key, value) => storeClient.kvSet(key, value),
      onAudit: (msg, payload) => storeService?.logger.userAction(msg, payload),
    });
    void wordlistService.whenReady;

    // m1 todo 10：BYOK Key 服务（safeStorage 注入 Port；密文/降级明文双形态落 kv_config）
    keyService = createKeyService({
      store: storeClient,
      safeStorage: createElectronSafeStoragePort(),
      fetchFn: globalThis.fetch.bind(globalThis),
      wordlist: wordlistService,
    });

    // 跨日续采扫描（02 §9.1：应用启动扫描昨日未完 remainder；UI「继续采集」经 collect:remainders）
    void storeService.recoveredTaskIds.then(async () => {
      const remainders = await collectBinding?.scanRemainders() ?? [];
      if (remainders.length > 0) {
        storeService?.logger.userAction('collect:remainders-scanned', {
          count: remainders.length,
          taskIds: remainders.map((r) => r.taskId),
          note: '跨日续采面就绪（collect:remainders 通道 + tasks:resume 继续采集，任务不重建）',
        });
      }
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
      // todo 7：采集管道 + 熔断联动（collect:start / collect:remainders / collect:stats / circuit:*）
      collect: {
        start: (params) => collectBinding?.start(params) ?? Promise.reject(new Error('collect binding 未就绪')),
        remainders: async () => ({ remainders: await (collectBinding?.scanRemainders() ?? Promise.reject(new Error('collect binding 未就绪'))) }),
        stats: async (params) =>
          await (collectBinding?.stats(params.runId, params.topicId) ?? Promise.reject(new Error('collect binding 未就绪'))),
        circuitStatus: () => collectBinding?.circuitStatus() ?? Promise.reject(new Error('collect binding 未就绪')),
        circuitConfirmResume: () => collectBinding?.confirmResume() ?? Promise.reject(new Error('collect binding 未就绪')),
      },
      // m1 todo 10：BYOK Key 链路（keys:set / keys:get-masked / keys:test / keys:precall-confirm / keys:scan-test）
      keys: {
        setKey: (params) => keyService?.setKey(params) ?? Promise.reject(new Error('keys service 未就绪')),
        getMasked: () => keyService?.getMasked() ?? Promise.reject(new Error('keys service 未就绪')),
        exitAuditRawValues: () => keyService?.exitAuditRawValues() ?? Promise.reject(new Error('keys service 未就绪')),
        test: (params) => keyService?.test(params) ?? Promise.reject(new Error('keys service 未就绪')),
        precallConfirm: (params) => keyService?.precallConfirm(params) ?? Promise.reject(new Error('keys service 未就绪')),
        scanTest: (params) => keyService?.scanTest(params) ?? Promise.reject(new Error('keys service 未就绪')),
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
        collect: {
          // fixture 模式专用（mock CDP）：等价页面侧 passive 监听写 __khs_yield__
          simulateUserInput: (atMs?: number) => collectBinding?.fixture?.simulateUserInput(atMs),
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
        collectBinding?.shutdown();
        wordlistService?.close();
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

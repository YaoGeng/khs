/**
 * 星链桌面壳主进程入口（映射 T-M0-02 / 02-系统架构设计.md §4.1-§4.3、§11.2；
 * todo 11：store/日志/任务运行器接入——迁移直写在窗口创建前（ADR-8 §6①））。
 *
 * 职责：单实例锁 → app 'ready' → 窗口前迁移（一次性直写）→ 注册 IPC（zod 校验）
 * → 开主窗口（安全基线 webPreferences）→ did-finish-load 结算冷启动样本（C-3 实测）
 * → 延迟加载重模块（C-3 招一；store worker 的 fork 为异步旁路，不阻塞窗口路径）。
 */
import { app, BrowserWindow, Notification, shell } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { EULA_LOCKED_VIEWS, CONTRACT_VERSION } from './shared/channels';
import { channelParamsSchemas, type CollectStartParams } from './shared/schemas';
import { registerIpcHandlers } from './main/ipc';
import { createComplianceService, type ComplianceService } from './compliance/compliance-service';
import { resolveEulaVersion } from './compliance/eula';
import { createLicenseService } from './main/license-service';
import { createDeferredBootstrap } from './main/lazy';
import { createMainWindow } from './main/window';
import { loadHeavyModules } from './main/heavy';
import { attachMigrationReport, createStoreService, resolveStorePaths, runPreWindowMigration, type StoreService } from './main/store-service';
import { createCollectBinding, type CollectBinding } from './main/collect-binding';
import { SelectionService, createFixtureSearchPortFromFile } from './tasks/selection-service';
import { createCdpSourcingPort1688 } from './browser/sourcing-port';
import { createRoutedSearchPort } from './main/sourcing-api-port';
import { createAkStore, maskAkId } from './main/ak-store';
import { createCdpOutreachPort1688, createFixtureOutreachPort } from './browser/outreach-port';
import { OutreachService } from './main/outreach-service';
import { createElectronSafeStoragePort } from './main/safe-storage-port';
import { createGatewayKeyReader, createKeyService, type KeyService, type SafeStoragePort } from './main/key-service';
import { createReportService, type ReportLlmConfig, type ReportService, type StructuredGateway } from './main/report-service';
import { createUsageService, type UsageService } from './main/usage-service';
import { createSelectionViewService } from './main/selection-view-service';
import { createAutomationTierService } from './main/automation-tier';
import { createViralService, type ViralService } from './main/viral-service';
import { MIRROR_FRAME_CHANNEL } from './shared/channels';
import { LlmGateway, TokenBucketLimiter } from '@xinglian/llm-gateway';
import type { StoreClient } from './store';
import { createWordlistService, type WordlistService } from './compliance/wordlist-service';
import { BrowserService } from './browser/browser-service';
import { resolveProfileRoot } from './browser/profiles';
import {
  builtinBrowsersRoot,
  installBuiltinBrowser,
  nodeDiskFreeBytes,
  nodeDownload,
  nodeSha256File,
  probeBuiltinBrowser,
  tarZipExtractor,
} from './browser/builtin';

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

// m1 todo 11：报告组合根服务（report-agent 接线 + 确认闸门；T-M1-06）
let reportService: ReportService | null = null;

// m1 todo 10：词库配置包服务（seed→sha256 manifest→fs watch 热更；T-M1-08②）
let wordlistService: WordlistService | null = null;

// m1 todo 10：BYOK Key 服务（safeStorage 经注入 Port；masked 出口断言在 ipc-core；T-M1-08①）
let keyService: KeyService | null = null;

// m1 todo 12：用量面板 + 全局 RPM（FR-2.5/2.6；llm_calls 聚合 + 自填单价 + 探测档展示）
let usageService: UsageService | null = null;

// M2 产品卡③：自动化档位（kv 偏好；report 步骤读同一 kv 决定闸门自动确认）
let automationTierService: ReturnType<typeof createAutomationTierService> | null = null;

// M2 产品卡②：爆款清单 v1（确定性热度分 + 单次 LLM 解读）
let viralService: ViralService | null = null;

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
    // M2 B2：内置便携 Chromium 链路装配（探测顺序 user-setting → builtin → chrome → edge；
    // 存储根与 cdp-profiles 同根，XINGLIAN_BUILTIN_BROWSER_ROOT 为 dev/e2e seam）
    const builtinBrowsersRootPath = builtinBrowsersRoot(
      process.env.LOCALAPPDATA ?? app.getPath('userData'),
      process.env.XINGLIAN_BUILTIN_BROWSER_ROOT ?? null,
    );
    const readTextOrNull = async (p: string): Promise<string | null> => {
      try {
        return await readFile(p, 'utf8');
      } catch {
        return null;
      }
    };
    const builtinProbeDeps = {
      fileExists: (p: string) => existsSync(p),
      readFile: readTextOrNull,
    };
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
      builtin: {
        probe: () => probeBuiltinBrowser(builtinBrowsersRootPath, builtinProbeDeps),
        install: (onProgress) =>
          installBuiltinBrowser(builtinBrowsersRootPath, {
            ...builtinProbeDeps,
            writeFile: async (p, content) => {
              await writeFile(p, content);
            },
            download: (url, dest, onProgress) =>
              // dev/e2e seam：XINGLIAN_BUILTIN_SNAPSHOT_URL 覆盖下载源（哈希不符拒绝路径的 fixture 测试用）
              nodeDownload(process.env.XINGLIAN_BUILTIN_SNAPSHOT_URL ?? url, dest, onProgress),
            sha256File: nodeSha256File,
            extractZip: tarZipExtractor,
            diskFreeBytes: nodeDiskFreeBytes,
            rmPath: async (p) => {
              await rm(p, { recursive: true, force: true });
            },
            rename: async (src, dest) => {
              await rename(src, dest);
            },
            mkdir: async (p) => {
              await mkdir(p, { recursive: true });
            },
            nowIso: () => new Date().toISOString(),
          }, onProgress),
      },
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

    // m1 todo 10：词库服务（配置包根 = <userData>/config/wordlist；seed 首启落盘 + fs watch 热更）
    const storeClient: StoreClient = storeService.store;
    wordlistService = createWordlistService({
      root: join(app.getPath('userData'), 'config', 'wordlist'),
      kvGet: (key) => storeClient.kvGet(key),
      kvSet: (key, value) => storeClient.kvSet(key, value),
      onAudit: (msg, payload) => storeService?.logger.userAction(msg, payload),
    });
    void wordlistService.whenReady;

    // m1 todo 10：BYOK Key 服务（safeStorage 注入 Port；密文/降级明文双形态落 kv_config）
    const safeStoragePort: SafeStoragePort = createElectronSafeStoragePort();
    keyService = createKeyService({
      store: storeClient,
      safeStorage: safeStoragePort,
      fetchFn: globalThis.fetch.bind(globalThis),
      wordlist: wordlistService,
    });

    // T-M2-05a：1688 官方 API AK 存储（AI版 APP 个人 AK；key-service 同款密文/降级纪律）
    const akStore = createAkStore({
      store: storeClient,
      safeStorage: safeStoragePort,
      onAudit: (msg, payload) => storeService?.logger.userAction(msg, payload),
    });

    // T-M2-03/T-M2-03b：选品执行服务（三步管道 + 登录守卫闸门）。
    // fixture seam XINGLIAN_SELECTION_FIXTURE=<json 路径> = 候选回放（e2e/联调）；
    // 真实端口惰性取浏览器连接（自开后台 tab 直达 1688 canonical URL；须已接管浏览器）。
    const selectionFixture = process.env.XINGLIAN_SELECTION_FIXTURE;
    const selectionService = new SelectionService({
      store: storeClient,
      runner: storeService.runner,
      logger: storeService.logger,
      notify: showDesktopNotification,
      searchPort: selectionFixture
        ? createFixtureSearchPortFromFile(selectionFixture)
        : createRoutedSearchPort({
            // T-M2-05a 传输路由：AK 已配置走官方 API（无需浏览器），未配置回落 CDP 浏览器检索
            getAk: () => akStore.get(),
            fetchImpl: globalThis.fetch.bind(globalThis),
            cdpPort: createCdpSourcingPort1688({
              connection: async () => {
                const session = await browserService!.prepareAutomationTab();
                return session.connection;
              },
              gate: () => browserService!.whenAutomationAllowed(),
              delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
              logger: storeService.logger,
            }),
            logger: storeService.logger,
          }),
    });

    /**
     * queued selection 起跑决策（T-M2-03b 即时起跑）：fixture 模式恒可起跑（回放无需
     * 浏览器）；真实 CDP 模式须浏览器已接管（state !== detached），否则留队——接管动作
     * （openPlatform）与下次 gate confirm / 应用启动都会再触发补跑，不烧任务重试预算。
     */
    const kickQueuedSelections = async (reason: string): Promise<string[]> => {
      try {
        if (!selectionFixture) {
          // T-M2-05a：AK 已配置时检索走官方 API，无需浏览器接管，不做 detached 留队
          const apiMode = (await akStore.get()) !== null;
          if (!apiMode) {
            const status = await browserService?.status();
            if (!status || status.state === 'detached') {
              storeService?.logger.networkMeta('selection:kick-deferred', {
                reason,
                browserState: status?.state ?? 'none',
                note: '浏览器未接管且未配置官方 API AK：queued selection 留队，待接管/下次确认/下轮启动补跑',
              });
              return [];
            }
          }
        }
        const started = await selectionService.startQueued();
        if (started.length > 0) {
          storeService?.logger.userAction('selection:queued-started', {
            count: started.length,
            taskIds: started,
            mode: selectionFixture ? 'fixture' : ((await akStore.get()) !== null ? 'api' : 'cdp'),
            reason,
          });
        }
        return started;
      } catch (error) {
        storeService?.logger.systemError('selection:kick-failed', { reason, error: String((error as Error).message).slice(0, 200) });
        return [];
      }
    };

    // m1 todo 11：报告组合根服务（T-M1-06 组合接线）——report-agent 真实 Ports：
    // structured = LlmGateway（BYOK 解密 Key），llm_calls sink = store.insertLlmCall，
    // insertReport/kv = store client，telemetry emitter = complianceService 唯一出口。
    // M2 产品卡②：网关工厂提取为共享面（report 与 viral 解读同配置同 sink 同计量）。
    const buildGateway = (config: ReportLlmConfig): StructuredGateway =>
      new LlmGateway({
        provider: config.provider,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        strategies: ['prompt-embedded-schema', 'regex-extraction-fallback'],
        maxRetries: 1,
        timeoutMs: 120_000,
        maxTokens: 8192,
        temperature: 0.2,
        // FR-2.4：主 Key 401/403 → 同 provider 备用 Key 单调轮换；遥测经唯一出口 + 本地日志留痕
        keyProvider: {
          list: async () => [config.apiKey, ...config.backupKeys],
          onFailover: (info) => {
            void complianceService
              ?.sendTelemetry({ name: 'key_failover', payload: { provider: info.provider, from: info.failedKeyMasked, to: info.nextKeyMasked, index: info.nextIndex, total: info.total } })
              .catch(() => {});
            storeService?.logger.userAction('key:failover', {
              provider: info.provider,
              from: info.failedKeyMasked,
              to: info.nextKeyMasked,
              index: info.nextIndex,
              total: info.total,
              at: info.at,
            });
          },
        },
        // FR-2.6：全局 RPM 令牌桶（kv llm:rpm-global，0/缺失=不限流；配置解析时读取）
        ...(config.rpmGlobal > 0 ? { limiter: new TokenBucketLimiter({ rpm: config.rpmGlobal }) } : {}),
        sink: async (record) => {
          await storeClient.insertLlmCall(record);
        },
      });
    reportService = createReportService({
      store: storeClient,
      runner: storeService.runner,
      logger: storeService.logger,
      wordlist: wordlistService,
      sendTelemetry: (event) => complianceService!.sendTelemetry(event),
      readKeyEntry: createGatewayKeyReader(storeClient, safeStoragePort),
      salt: `xinglian-report-salt:${app.getPath('userData')}`,
      createGateway: buildGateway,
      // T-M2-03b：闸门确认 → queued selection 即时起跑（不等重启；浏览器未接管则留队补跑）
      onGateConfirmed: (info) => {
        void kickQueuedSelections(`gate-confirmed:${info.source}:${info.selectionTaskId.slice(0, 8)}`);
      },
    });

    // M2 产品卡③：自动化档位（settings 写面 + report 步骤闸门自动确认读面）
    automationTierService = createAutomationTierService({ store: storeClient, logger: storeService.logger });

    // M2 产品卡②：爆款清单 v1（collect-viral 步骤 + insight 读面 + 单次 LLM 解读）
    viralService = createViralService({
      store: storeClient,
      runner: storeService.runner,
      logger: storeService.logger,
      readKeyEntry: createGatewayKeyReader(storeClient, safeStoragePort),
      createGateway: buildGateway,
    });

    // todo 7：采集链路绑定（熔断/配额/适配包/让位监视；fixture seam = XINGLIAN_COLLECT_FIXTURE）。
    // 报告步骤（collect-report）默认接线；e2e/dev seam XINGLIAN_REPORT_STEP=off 回 todo 7 四步管道。
    // 爆款清单步骤（collect-viral，FR-4.7）确定性零成本，恒接线（fixture 单测不经组合根）。
    const reportStepEnabled = process.env.XINGLIAN_REPORT_STEP !== 'off';
    collectBinding = createCollectBinding({
      store: storeService.store,
      runner: storeService.runner,
      logger: storeService.logger,
      compliance: complianceService,
      notify: showDesktopNotification,
      userDataDir: app.getPath('userData'),
      ...(reportStepEnabled && reportService
        ? { reportStep: (ctx) => reportService!.runCollectReportStep(ctx) }
        : {}),
      viralStep: (ctx) => viralService!.runCollectViralStep(ctx),
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

    // 跨日续采扫描（02 §9.1：应用启动扫描昨日未完 remainder；UI「继续采集」经 collect:remainders）
    void storeService.recoveredTaskIds.then(async () => {
      const storeSvc = storeService;
      if (!storeSvc) return;
      const remainders = await collectBinding?.scanRemainders() ?? [];
      if (remainders.length > 0) {
        storeSvc.logger.userAction('collect:remainders-scanned', {
          count: remainders.length,
          taskIds: remainders.map((r) => r.taskId),
          note: '跨日续采面就绪（collect:remainders 通道 + tasks:resume 继续采集，任务不重建）',
        });
      }
      // T-M2-03/T-M2-03b：boot 扫描 queued selection——fixture 恒起跑；真实模式浏览器
      // 未接管时留队（kick 内决策），由接管动作/gate confirm/下轮启动补跑
      await kickQueuedSelections('boot');
    });

    // m1 todo 12：用量面板 + 全局 RPM（FR-2.5/2.6；llm_calls 聚合 + 自填单价 + 探测档展示）
    usageService = createUsageService({ store: storeClient });

    // 05 T-M2-03：选品候选清单视图服务（FR-6.2 权重/FR-6.3 对比表格读面；构造期含
    // shared↔agents 五维镜像一致性断言——漂移即启动期可见）
    const selectionViewService = createSelectionViewService({ store: storeClient, runner: storeService.runner });

    // T-M2-04：收藏/询盘执行服务（FR-6.3 勾选 → FR-6.4 confirm 红线弹窗 → FR-6.5 素材+卡片）。
    // fixture seam XINGLIAN_OUTREACH_FIXTURE=1 = 内存会话回放（e2e 全链路不碰真站；
    // 真实写操作位点校准见 adapters-1688 v1.1.1，会话窗内部位点待用户在场联调）。
    const outreachFixture = process.env.XINGLIAN_OUTREACH_FIXTURE === '1';
    const outreachService = new OutreachService({
      store: storeClient,
      port: outreachFixture
        ? () => Promise.resolve(createFixtureOutreachPort())
        : () =>
            Promise.resolve(
              createCdpOutreachPort1688({
                connection: async () => {
                  const session = await browserService!.prepareAutomationTab();
                  return session.connection;
                },
                gate: () => browserService!.whenAutomationAllowed(),
                delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                logger: storeService!.logger,
              }),
            ),
      browserState: outreachFixture
        ? () => Promise.resolve('attached')
        : async () => (await browserService?.status())?.state ?? 'detached',
      logger: storeService!.logger,
      notify: showDesktopNotification,
      // main→renderer 确认/进度推送（PUSH_CHANNELS 白名单；preload onPush 门面）
      push: (channel, payload) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
      },
      materialsDir: join(app.getPath('userData'), 'materials'),
      // 候选间拟人间隔（§7.1）：真实模式 20s+抖动，防止背靠背触发风控；fixture/e2e 置 0
      ...(outreachFixture ? { offerGapMs: 0 } : { offerGapMs: 20_000 }),
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
      // M2 B2：+ browser:installBuiltin（内置便携 Chromium 按需安装）
      browser: {
        status: () => browserService?.status() ?? Promise.reject(new Error('browser service 未就绪')),
        openPlatform: async (params) => {
          const result = await (browserService?.openPlatform(params) ?? Promise.reject(new Error('browser service 未就绪')));
          // T-M2-03b：浏览器接管成功 → 补跑留队的 queued selection（真实模式此前因未接管留队）
          if (result.ok) void kickQueuedSelections(`browser-attached:${params.platform}`);
          return result;
        },
        disconnect: () => browserService?.disconnect() ?? Promise.reject(new Error('browser service 未就绪')),
        installBuiltin: () => browserService?.installBuiltin() ?? Promise.reject(new Error('browser service 未就绪')),
        // M2 产品卡①：应用内镜像预览（screencast 只读投流；帧经 PUSH_CHANNELS 推送）
        startMirror: () => browserService?.startMirror() ?? Promise.reject(new Error('browser service 未就绪')),
        stopMirror: () => browserService?.stopMirror() ?? Promise.reject(new Error('browser service 未就绪')),
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
      // m1 todo 11：报告 UI + 确认闸门（notes:/reports:/report:*/gate:*；T-M1-06）
      report: {
        listNotes: (params) => reportService!.listNotes(params.topicId, params.limit),
        listReports: () => reportService!.listReports(),
        getReport: (params) => reportService!.getReportView(params.reportId),
        chartData: (params) => reportService!.chartData(params.reportId),
        exportPdf: async () => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) throw new Error('E-REPORT-PDF-WINDOW-MISSING: 主窗口未就绪，无法打印 PDF');
          // B-6（03:220）：PDF = 渲染进程打印管线——webContents.printToPDF，无第三方 PDF 库
          const buffer = await win.webContents.printToPDF({
            landscape: false,
            printBackground: true,
            pageSize: 'A4',
            margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
          });
          return { dataBase64: buffer.toString('base64') };
        },
        // QA failure 组专用（缺⑧章 mock 报告 → error boundary）：仅 debug 门控装配
        ...(process.env.XINGLIAN_DEBUG_HOOKS === '1'
          ? {
              insertFixture: (params) => reportService!.insertFixtureReport(params),
            }
          : {}),
        listGates: () => reportService!.listGates(),
        confirmGate: (params) => reportService!.confirmGate(params.taskId),
        rejectGate: (params) => reportService!.rejectGate(params.taskId),
      },
      // m1 todo 12：用量面板 + 全局 RPM（usage:summary / usage:setPricing / usage:setRpm；FR-2.5/2.6）
      usage: usageService!.ipc,
      // M2 产品卡③：自动化档位（automation:getTier / automation:setTier；FR-12.7）
      automation: {
        getTier: () => automationTierService!.getTier(),
        setTier: (params) => automationTierService!.setTier(params.tier),
      },
      // M2 产品卡②：爆款清单 v1（viral:list / viral:refresh / viral:generateRationale；FR-4.7）
      viral: {
        list: (params) => viralService!.listSnapshot(params.topicId),
        refresh: (params) => viralService!.refresh(params.topicId, params.topN),
        generateRationale: (params) => viralService!.generateRationale(params.topicId),
      },
      // 05 T-M2-03：选品候选清单（selection:*；FR-6.2 权重可调/FR-6.3 对比表格）
      selection: {
        list: () => selectionViewService.listSelections(),
        // T-M2-04：candidates = 视图读面 + 勾选集合并（checked 归 outreach kv，组合根组装）
        candidates: async (params) => {
          const result = await selectionViewService.listCandidates(params.taskId);
          return { ...result, checked: await outreachService.listChecked(params.taskId) };
        },
        config: () => selectionViewService.getConfig(),
        setWeights: (params) => selectionViewService.setWeights(params.weights),
        setPinned: (params) => selectionViewService.setPinned(params),
        setChecked: (params) =>
          outreachService.setChecked(params.taskId, params.offerId, params.checked).then((offerIds) => ({ taskId: params.taskId, offerIds })),
        // QA 播种专用（缺省显式报未就绪）：仅 debug 门控装配
        ...(process.env.XINGLIAN_DEBUG_HOOKS === '1'
          ? {
              insertFixture: (params: Parameters<typeof selectionViewService.insertFixture>[0]) =>
                selectionViewService.insertFixture(params),
            }
          : {}),
      },
      // T-M2-04：收藏/询盘执行（outreach:*；FR-6.4 红线确认弹窗 + 审计）
      outreach: {
        start: (params) => outreachService.startRun(params.taskId, params),
        decide: async (params) => ({ accepted: await outreachService.decide(params.confirmId, params.decision, params.message ?? null) }),
        status: () => Promise.resolve(outreachService.status()),
      },
      // T-M2-04：商品卡片（products:*；FR-6.5 素材留存展示面）
      products: {
        list: async (params) => ({ products: await outreachService.listProductCards(params) }),
        // 打开货源页（FR-6.5「打开货源页」按钮）：ipc-core 已拦非 1688 域，这里真实外开
        openSource: async (params) => {
          await shell.openExternal(params.link);
          return { opened: true };
        },
      },
      // T-M2-05a：1688 官方 API AK 配置（sourcing:ak*；masked 出口，密文纪律归 ak-store）
      sourcingAk: {
        status: async () => {
          const [status, ak] = await Promise.all([akStore.status(), akStore.get()]);
          // configured 以「可解析出有效 AK」为准；masked 从实时解析推导（解析器修正后
          // 旧 meta 里的掩码不再误导 UI），值损坏时如实报未配置
          if (!ak) return { configured: false, accessKeyIdMasked: null, encryption: null, setAt: null };
          return { configured: true, accessKeyIdMasked: maskAkId(ak.accessKeyId), encryption: status.encryption, setAt: status.setAt };
        },
        set: async (params) => akStore.setRaw(params.raw),
        clear: async () => {
          await akStore.clear();
          return { cleared: true };
        },
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

    // M2 产品卡①：镜像帧推送出口（主窗口 webContents；窗口销毁/未建时静默丢弃）
    browserService?.attachMirrorSink((frame) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) win.webContents.send(MIRROR_FRAME_CHANNEL, frame);
    });

    // pilot 脚本化采集 seam（XINGLIAN_PILOT_AUTOCOLLECT，env 门控；仅联调窗口设置，生产不设）：
    // JSON = {action:'collect', payload:<collect:start 入参>} | {action:'resume', taskId}
    //      | {action:'confirm-gate', taskId}（无头确认闸门，等价 gate:confirm 通道）
    //      | {action:'install-builtin'}（触发内置 Chromium 真实安装，B4 验收用），
    //      或以上动作组成的数组（顺序执行；collect/resume 等任务终态再走下一条——
    //      runner.resume 只踢驱动不阻塞，且真实链路共用单个自动化会话，并发必窜）。
    // 与手动流程同路径：接管 xhs 平台浏览器（登录态在专用 Profile，保持 FR-3.1 不碰账密）→
    // prepare 自动化 → start（新任务）/ resumeTask（检查点续跑，等价 tasks:resume 通道）。
    const pilotAutoRaw = process.env.XINGLIAN_PILOT_AUTOCOLLECT;
    if (pilotAutoRaw) {
      // B4 验收助手：轮询内置安装到终态（2s 间隔，进度行打 stdout）
      const waitBuiltinTerminal = async (): Promise<void> => {
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const info = (await browserService?.status())?.builtinInstall;
          console.log('[pilot-autocollect] builtin-install', info?.state, info?.receivedBytes ?? 0);
          if (info?.state === 'installed' || info?.state === 'failed') return;
        }
      };
      // 数组编排助手：等任务到终态（2s 轮询，30min 上限；awaiting_user/paused/suspended
      // 都是「本条已让位人工/闸门」的停点，不应堵住后续条目）
      const waitTaskTerminal = async (taskId: string): Promise<string> => {
        const terminal = new Set(['completed', 'failed', 'paused', 'suspended', 'awaiting_user', 'cancelled']);
        for (let i = 0; i < 900; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const task = await storeClient.getTask(taskId).catch(() => null);
          if (!task || terminal.has(task.status)) return task?.status ?? 'gone';
        }
        return 'wait-timeout';
      };
      setTimeout(() => {
        void (async () => {
          try {
            const parsedSpecs: unknown = JSON.parse(pilotAutoRaw);
            const specs = (Array.isArray(parsedSpecs) ? parsedSpecs : [parsedSpecs]) as Array<
              | { action: 'collect'; payload: unknown }
              | { action: 'resume'; taskId: string }
              | { action: 'confirm-gate'; taskId: string }
              | { action: 'install-builtin' }
            >;
            for (const spec of specs) {
              if (spec.action !== 'confirm-gate' && spec.action !== 'install-builtin') {
                await browserService?.openPlatform({ platform: 'xhs' });
              }
              if (spec.action === 'collect') {
                const parsed = channelParamsSchemas['collect:start'].safeParse(spec.payload);
                if (!parsed.success) {
                  throw new Error(`E-PILOT-AUTO-INVALID: collect 入参不合法（${parsed.error.issues[0]?.message ?? 'schema'}）`);
                }
                const started = await collectBinding?.start(parsed.data as CollectStartParams);
                console.log('[pilot-autocollect] started', JSON.stringify(started));
                if (started?.taskId && specs.length > 1) {
                  console.log('[pilot-autocollect] await-terminal', started.taskId, await waitTaskTerminal(started.taskId));
                }
              } else if (spec.action === 'confirm-gate') {
                const parsed = channelParamsSchemas['gate:confirm'].safeParse({ taskId: spec.taskId });
                if (!parsed.success) {
                  throw new Error(`E-PILOT-AUTO-INVALID: confirm-gate 入参不合法（${parsed.error.issues[0]?.message ?? 'schema'}）`);
                }
                console.log('[pilot-autocollect] gate-confirmed', JSON.stringify(await reportService!.confirmGate((parsed.data as { taskId: string }).taskId)));
              } else if (spec.action === 'install-builtin') {
                console.log('[pilot-autocollect] builtin-install kicked', JSON.stringify(await browserService?.installBuiltin()));
                // 轮询到终态再让编排继续（B4 验收：进程内观察真实下载/解压/校验全程）
                await waitBuiltinTerminal();
              } else {
                await collectBinding?.prepare();
                const resumed = await storeService!.ipc.resumeTask(spec.taskId);
                console.log('[pilot-autocollect] resumed', JSON.stringify(resumed));
                if (specs.length > 1) {
                  console.log('[pilot-autocollect] await-terminal', spec.taskId, await waitTaskTerminal(spec.taskId));
                }
              }
            }
          } catch (error) {
            console.error('[pilot-autocollect] failed', error);
          }
        })();
      }, 3000);
    }
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

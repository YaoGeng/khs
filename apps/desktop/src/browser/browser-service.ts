/**
 * 受控浏览器接管服务（todo 10 = T-M0-08；FR-3.1~3.5、FR-4.5、02 §5 全章）。
 *
 * 职责：
 * - FR-3.1 一键拉起：探测（detect.ts）→ 专用 Profile（profiles.ts）→ pipe 拉起 + CDP 握手
 *   （launcher.ts，S6 路线 A）；port=0 fallback 为显式配置项（port-fallback*，默认关闭）；
 * - FR-3.2 平台快捷入口：新标签 = Target.createTarget（真实 CDP 往返）；
 * - FR-3.4 会话健康检测：周期 CDP ping + 目标页 URL 登录特征检查（规则从简，session.ts）；
 * - FR-3.5 三态标题栏：detached/attached/login-expired（session.ts 状态机为唯一真源）+
 *   一键断开（断开语义见 notes-browser-m0.md §3：CDP 连接 + 浏览器进程一并关闭）；
 * - FR-4.5 人工输入让位：M0 = 状态标志 + UI 指示 + 测试钩子（YieldFlag；简化口径 §5）；
 * - 崩溃联动（failure QA / 门禁②）：浏览器进程死亡 → 会话丢失 → 调 T11 runner 挂起全部
 *   running 任务（suspended，02 §9.1）→ 同 Profile 自动重拉 → 任务由用户 resume 按检查点续跑。
 *
 * 红线（FR-3.1/02 §5.2）：绝不读取/存储平台账号密码；不触碰任何 Login/Cookie 写路径——
 * 登录态完全由用户在受控浏览器内本人完成并落盘在专用 Profile 目录。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Logger } from '@xinglian/logger';
import {
  BROWSER_PLATFORM_URLS,
  BROWSER_ERRORS,
  type BrowserPlatformId,
} from '../shared/channels';
import type {
  BrowserDisconnectResult,
  BrowserOpenPlatformParams,
  BrowserOpenPlatformResult,
  BrowserStatusResult,
} from '../shared/schemas';
import { CdpConnection } from './cdp';
import { PASSIVE_INPUT_LISTENER_SCRIPT, WEBDRIVER_FLAG_REMOVAL_SCRIPT } from '@xinglian/stealth-middleware';
import { assertExecutableAvailable, launchPipeBrowser, type CdpTransportMode, type LaunchedPipeBrowser } from './launcher';
import { resolvePlatformProfileDir } from './profiles';
import { detectBrowser } from './detect';
import { registryQueryAppPaths } from './detect-node';
import { launchPortFallbackBrowser } from './port-fallback-launch';
import { isLoginExpiredUrl, resolveSessionTransition, YieldFlag, type BrowserSessionEvent, type BrowserSessionState } from './session';

export interface BrowserServiceDeps {
  readonly logger: Logger;
  /** 平台 Profile 根目录（main.ts 注入；e2e 经 XINGLIAN_CDP_PROFILE_ROOT 覆盖） */
  readonly profileRoot: string;
  /** CDP 传输路线：pipe（默认，S6 路线 A）| port（D6 fallback，显式配置） */
  readonly transportMode?: CdpTransportMode;
  readonly healthIntervalMs?: number;
  readonly relaunchDelayMs?: number;
  readonly relaunchMaxAttempts?: number;
  /** 用户设置中的浏览器路径（M0：settings 无该字段 → null；dev seam XINGLIAN_BROWSER_PATH） */
  readonly userSettingPath?: string | null;
  /** 探测绑定覆盖（单测注入；生产用 reg.exe/existsSync） */
  readonly detect?: {
    readonly registryQuery: (key: string) => Promise<string | null>;
    readonly fileExists: (path: string) => boolean;
  };
  /** 进程拉起注入（单测假进程；生产 = node child_process.spawn） */
  readonly spawnImpl?: typeof spawn;
  /** 崩溃联动：把当前全部 running 任务置 suspended（T11 runner；02 §9.1 running→suspended） */
  readonly suspendRunningTasks: (reason: string) => Promise<string[]>;
  readonly now?: () => Date;
}

interface CdpTargetView {
  targetId: string;
  type: string;
  url: string;
}

/** Target.getTargets 真实响应形状：{ targetInfos: TargetInfo[] }（DevTools 协议） */
interface TargetListResult {
  targetInfos?: CdpTargetView[];
}

const DEFAULTS = {
  healthIntervalMs: 10_000,
  relaunchDelayMs: 1_000,
  relaunchMaxAttempts: 3,
};

export class BrowserService {
  private readonly logger: Logger;
  private readonly deps: BrowserServiceDeps;
  private readonly transportMode: CdpTransportMode;

  private state: BrowserSessionState = 'detached';
  private readonly yieldFlag = new YieldFlag();
  private launched: LaunchedPipeBrowser | null = null;
  private detectedPath: string | null = null;
  private detectedSource: BrowserStatusResult['browserSource'] = null;
  private currentPlatform: BrowserPlatformId | null = null;
  private openTabs: { targetId: string; url: string }[] | null = null;
  private browserVersion: string | null = null;
  private attachedAt: string | null = null;
  private lastError: string | null = null;

  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private relaunchTimer: ReturnType<typeof setTimeout> | null = null;
  private userDisconnected = false;
  private shuttingDown = false;
  private lossHandling = false;
  private readonly now: () => Date;

  constructor(deps: BrowserServiceDeps) {
    this.deps = deps;
    this.logger = deps.logger;
    this.transportMode = deps.transportMode ?? 'pipe';
    this.now = deps.now ?? (() => new Date());
  }

  /* ------------------------------ 查询（FR-3.5 UI 轮询面） ------------------------------ */

  async status(): Promise<BrowserStatusResult> {
    return {
      state: this.state,
      yielded: this.yieldFlag.active,
      yieldReason: this.yieldFlag.snapshot().reason,
      browserVersion: this.browserVersion,
      browserPid: this.launched?.child.pid ?? null,
      browserPath: this.detectedPath,
      browserSource: this.detectedSource,
      profileDir: this.currentPlatform
        ? resolvePlatformProfileDir(this.deps.profileRoot, this.currentPlatform)
        : this.deps.profileRoot,
      currentPlatform: this.currentPlatform,
      openTabs: this.openTabs,
      attachedAt: this.attachedAt,
      lastError: this.lastError,
    };
  }

  /* ------------------------------ 接管与快捷入口（FR-3.1/3.2） ------------------------------ */

  /** 一键拉起 + CDP 接管 + 打开平台首页（真实 CDP 往返；幂等：已接管时仅新开/聚焦平台页） */
  async openPlatform(params: BrowserOpenPlatformParams): Promise<BrowserOpenPlatformResult> {
    const url = BROWSER_PLATFORM_URLS[params.platform];
    this.userDisconnected = false;
    const launchedNow = this.launched === null || this.launched.connection.isClosed;
    const browser = await this.ensureLaunched(params.platform);
    const targetId = await this.openPlatformTab(browser.connection, params.platform, url);
    await this.waitForPlatformTab(browser.connection, params.platform);
    this.applyEvent({ type: 'TAKEOVER_OK' }, `openPlatform:${params.platform}`);
    this.logger.userAction('browser:takeover', {
      platform: params.platform,
      launchedNow,
      browserVersion: this.browserVersion,
      pid: browser.child.pid ?? null,
      transport: this.transportMode,
    });
    return { ok: true, state: this.state, platform: params.platform, url, targetId, launchedNow, browserVersion: this.browserVersion };
  }

  /** 等平台标签导航提交（Target.getTargets 的 url 出现平台域名；网络不可用时记日志不阻断接管） */
  private async waitForPlatformTab(connection: CdpConnection, platform: BrowserPlatformId, timeoutMs = 15_000): Promise<void> {
    const host = this.platformHost(platform);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.refreshOpenTabs(connection);
      if ((this.openTabs ?? []).some((t) => t.url.includes(host))) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.logger.networkMeta('browser:platform-tab-not-committed', { platform, note: '平台页导航未在窗口期内提交（网络不可用？）；接管会话不受影响' });
  }

  /**
   * 既有平台标签内导航（flat 会话：Target.attachToTarget + Page.navigate；任务要求的
   * attachToTarget/Page.navigate 运行时面）。e2e 用它驱动标签到登录特征 URL 以演示
   * FR-3.4 失效引导；这也是 M1 自动化步骤在受控页面上移动的唯一合法动作形态。
   */
  async navigateTab(url: string): Promise<{ targetId: string | null }> {
    const browser = this.launched;
    if (!browser || browser.connection.isClosed) throw new Error('E-BROWSER-CDP-ATTACH-FAILED: 无已接管浏览器可导航');
    const tabs = this.openTabs ?? [];
    const platform = this.currentPlatform;
    const target = platform ? tabs.find((t) => t.url.includes(this.platformHost(platform))) : undefined;
    const targetId = target?.targetId ?? tabs[tabs.length - 1]?.targetId ?? null;
    if (!targetId) throw new Error('E-BROWSER-CDP-ATTACH-FAILED: 无可用目标页');
    const attached = await browser.connection.send<{ sessionId?: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await browser.connection.send('Page.navigate', { url }, attached.sessionId);
    await this.refreshOpenTabs(browser.connection);
    return { targetId };
  }

  /** 打开平台新标签（FR-3.2）：createTarget 即建即导（about:blank + Page.navigate 分两步走 flat 会话） */
  private async openPlatformTab(connection: CdpConnection, platform: BrowserPlatformId, url: string): Promise<string | null> {
    try {
      const created = await connection.send<{ targetId?: string }>('Target.createTarget', { url });
      this.currentPlatform = platform;
      this.lastError = null;
      return created.targetId ?? null;
    } catch (error) {
      const message = String((error as Error).message);
      if (message.includes('E-BROWSER-PROFILE-BUSY') || /profile/i.test(message)) {
        throw new Error(`${BROWSER_ERRORS.PROFILE_BUSY}: 平台 Profile 被占用（${message}）`, { cause: error });
      }
      throw error;
    }
  }

  /** 复用或新建受控浏览器（FR-3.1 探测链在首次拉起时执行一次，结果缓存） */
  private async ensureLaunched(platform: BrowserPlatformId): Promise<LaunchedPipeBrowser> {
    if (this.launched && !this.launched.connection.isClosed) {
      this.currentPlatform = this.currentPlatform ?? platform;
      return this.launched;
    }
    const profileDir = resolvePlatformProfileDir(this.deps.profileRoot, platform);
    const exe = await this.resolveBrowserOrThrow();

    let launched: LaunchedPipeBrowser;
    try {
      if (this.transportMode === 'port') {
        const fallback = await launchPortFallbackBrowser({ exePath: exe.path, profileDir, spawnImpl: this.deps.spawnImpl });
        launched = {
          child: fallback.child,
          connection: fallback.connection,
          version: fallback.version,
          profileDir,
        };
      } else {
        launched = await launchPipeBrowser({
          exePath: exe.path,
          profileDir,
          transport: 'pipe',
          ...(this.deps.spawnImpl ? { spawnImpl: this.deps.spawnImpl } : {}),
        });
      }
    } catch (error) {
      const message = String((error as Error).message);
      this.lastError = message;
      this.logger.systemError('browser-launch-failed', { path: exe.path, err: message.slice(0, 300) });
      throw new Error(message.startsWith('E-BROWSER-') ? message : `${BROWSER_ERRORS.LAUNCH_FAILED}: ${message}`, { cause: error });
    }

    this.launched = launched;
    this.browserVersion = `${launched.version.product}`;
    this.attachedAt = this.now().toISOString();
    this.currentPlatform = platform;
    this.openTabs = null;
    this.lastError = null;
    this.watchConnection(launched.connection);
    this.logger.networkMeta('browser:pipe-attached', {
      product: launched.version.product,
      version: launched.version.version,
      protocolVersion: launched.version.protocolVersion,
      pid: launched.child.pid ?? null,
      profileDir,
      transport: this.transportMode,
    });
    this.startHealthLoop();
    return launched;
  }

  /** FR-3.1 探测链（缓存；未命中 → E-BROWSER-NOT-FOUND + 降级记录） */
  private async resolveBrowserOrThrow(): Promise<{ path: string; source: BrowserStatusResult['browserSource'] }> {
    if (this.detectedPath) return { path: this.detectedPath, source: this.detectedSource };
    const found = await detectBrowser({
      userSettingPath: this.deps.userSettingPath ?? null,
      registryQuery: this.deps.detect?.registryQuery ?? registryQueryAppPaths,
      fileExists: this.deps.detect?.fileExists ?? ((p) => existsSync(p)),
      roots: {
        programFiles: process.env.ProgramFiles ?? 'C:\\Program Files',
        programFilesX86: process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        localAppData: process.env.LOCALAPPDATA ?? 'C:\\Users\\me\\AppData\\Local',
      },
    });
    if (!found) {
      this.lastError = `${BROWSER_ERRORS.NOT_FOUND}: 未探测到本机 Chrome/Edge（便携 Chromium 降级分支 M0 只记录不实现，见 docs/adr/notes-browser-m0.md §6）`;
      this.logger.systemError('browser-detect-degraded', { note: '无 Chrome/Edge：M0 记录降级，不做便携 Chromium 下载' });
      throw new Error(this.lastError);
    }
    assertExecutableAvailable(found.path);
    this.detectedPath = found.path;
    this.detectedSource = found.source;
    return { path: found.path, source: found.source };
  }

  /* ------------------------------ 会话事件与崩溃联动 ------------------------------ */

  private applyEvent(event: BrowserSessionEvent, context: string): void {
    const next = resolveSessionTransition(this.state, event);
    if (next === null) return;
    const from = this.state;
    this.state = next;
    if (next === 'attached') {
      this.attachedAt = this.attachedAt ?? this.now().toISOString();
    }
    if (next === 'detached' && event.type === 'BROWSER_LOST') {
      this.attachedAt = null;
    }
    this.logger.networkMeta('browser:session', { from, to: next, event: event.type, context });
  }

  private watchConnection(connection: CdpConnection): void {
    connection.onEvent((event) => {
      // 运行时事件监听（任务要求）：目标生命周期事件轻量留痕；不触碰页面内容
      if (event.method === 'Target.targetCreated' || event.method === 'Target.targetDestroyed') {
        this.logger.networkMeta('browser:target-event', { method: event.method });
      }
    });
    connection.waitForClose().then((info) => {
      this.handleBrowserLost(`CDP 连接关闭（exit code=${info.code}）`);
    });
  }

  /**
   * 崩溃联动（failure QA / 门禁②）：
   * 会话丢失 → 挂起全部 running 任务（T11 runner）→ 同 Profile 自动重拉（重试上限内）。
   * 任务不自动 resume：02 §9.1 规定 suspended→running 须经人工确认恢复。
   */
  private handleBrowserLost(reason: string): void {
    if (this.shuttingDown) return;
    this.launched = null;
    this.openTabs = null;
    this.browserVersion = null;
    if (this.userDisconnected) {
      this.applyEvent({ type: 'DISCONNECT', reason }, 'user');
      return;
    }
    this.applyEvent({ type: 'BROWSER_LOST', reason }, 'crash-linkage');
    this.lastError = reason;
    if (this.lossHandling) return;
    this.lossHandling = true;
    void (async () => {
      try {
        const suspendedIds = await this.deps.suspendRunningTasks('browser-lost');
        if (suspendedIds.length > 0) {
          this.logger.systemError('browser-lost-tasks-suspended', { reason, taskIds: suspendedIds });
        }
        await this.relaunchWithRetry();
      } catch (error) {
        this.logger.systemError('browser-loss-handling-failed', { err: String((error as Error).message).slice(0, 300) });
      } finally {
        this.lossHandling = false;
      }
    })();
  }

  private async relaunchWithRetry(): Promise<void> {
    const maxAttempts = this.deps.relaunchMaxAttempts ?? DEFAULTS.relaunchMaxAttempts;
    const delayMs = this.deps.relaunchDelayMs ?? DEFAULTS.relaunchDelayMs;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.shuttingDown || this.userDisconnected) return;
      const platform = this.currentPlatform ?? 'xhs';
      await new Promise((resolve) => {
        this.relaunchTimer = setTimeout(resolve, delayMs * attempt);
      });
      try {
        const browser = await this.ensureLaunched(platform);
        await this.openPlatformTab(browser.connection, platform, BROWSER_PLATFORM_URLS[platform]);
        await this.refreshOpenTabs(browser.connection);
        this.applyEvent({ type: 'TAKEOVER_OK' }, 'relaunch-after-loss');
        this.logger.systemError('browser-relaunched', { attempt, pid: browser.child.pid ?? null, platform });
        return;
      } catch (error) {
        this.logger.systemError('browser-relaunch-failed', { attempt, err: String((error as Error).message).slice(0, 300) });
      }
    }
    this.lastError = `自动重拉失败（${maxAttempts} 次尝试）——请在界面重新点击「打开平台」`;
  }

  /* ------------------------------ 会话健康检测（FR-3.4） ------------------------------ */

  private startHealthLoop(): void {
    if (this.healthTimer) return;
    const intervalMs = this.deps.healthIntervalMs ?? DEFAULTS.healthIntervalMs;
    this.healthTimer = setInterval(() => {
      void this.healthTick();
    }, intervalMs);
    this.healthTimer.unref?.();
  }

  private stopHealthLoop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async healthTick(): Promise<void> {
    if (this.state === 'detached' || !this.launched || this.launched.connection.isClosed) return;
    const connection = this.launched.connection;
    try {
      // 连接层 ping：真实 CDP 往返（3s 内必须回，否则视为连接丢失）
      const ping = await Promise.race([
        connection.send('Browser.getVersion'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('health ping timeout')), 3_000)),
      ]);
      void ping;
      await this.refreshOpenTabs(connection);
      // 会话层规则（M0 从简）：平台目标页 URL 命中登录特征 → login-expired；离开 → 自动恢复
      const platform = this.currentPlatform;
      if (platform) {
        const platformTabs = (this.openTabs ?? []).filter((t) => t.url.includes(this.platformHost(platform)));
        const expired = platformTabs.some((t) => isLoginExpiredUrl(t.url, platform));
        if (expired && this.state === 'attached') {
          this.applyEvent({ type: 'LOGIN_EXPIRED', url: platformTabs[0]?.url ?? '' }, 'health-tick');
          this.logger.systemError('browser-login-expired', { platform, rule: 'url-login-pattern（M0 从简）' });
        } else if (!expired && this.state === 'login-expired') {
          this.applyEvent({ type: 'LOGIN_RECOVERED', url: platformTabs[0]?.url ?? '' }, 'health-tick');
          this.logger.userAction('browser-login-recovered', { platform });
        }
      }
    } catch (error) {
      this.handleBrowserLost(`健康检测失败：${String((error as Error).message).slice(0, 120)}`);
    }
  }

  private platformHost(platform: BrowserPlatformId): string {
    return new URL(BROWSER_PLATFORM_URLS[platform]).hostname.replace(/^www\./, '');
  }

  private async refreshOpenTabs(connection: CdpConnection): Promise<void> {
    const result = await connection.send<TargetListResult>('Target.getTargets');
    this.openTabs = (result.targetInfos ?? [])
      .filter((t) => t.type === 'page')
      .map((t) => ({ targetId: t.targetId, url: t.url }));
  }

  /* ------------------------------ 一键断开（FR-3.5） ------------------------------ */

  /**
   * 断开语义（notes-browser-m0.md §3）：CDP 连接 + 浏览器进程一并关闭。
   * 取舍：pipe 模式下 detached 后的浏览器无法二次 attach（无端点可连）且会锁住平台
   * Profile——保留进程会永久阻断重接管；关闭进程不损失登录态（FR-3.3 落盘在 Profile）。
   */
  async disconnect(): Promise<BrowserDisconnectResult> {
    const browser = this.launched;
    this.userDisconnected = true;
    this.stopHealthLoop();
    if (this.relaunchTimer) {
      clearTimeout(this.relaunchTimer);
      this.relaunchTimer = null;
    }
    let browserClosed = false;
    if (browser) {
      browserClosed = await this.closeBrowser(browser);
      this.launched = null;
      this.openTabs = null;
      this.browserVersion = null;
      this.attachedAt = null;
    }
    this.applyEvent({ type: 'DISCONNECT', reason: 'user' }, 'disconnect');
    this.logger.userAction('browser:disconnect', { hadBrowser: browser !== null, browserClosed });
    return { ok: true, state: 'detached', browserClosed };
  }

  private async closeBrowser(browser: LaunchedPipeBrowser): Promise<boolean> {
    // 优雅先行：Browser.close（内核侧完整退出 + Profile 冲刷）；超时/已死则整树终止兜底
    try {
      await browser.connection.send('Browser.close');
    } catch {
      // 连接可能已断：走进程树终止
    }
    browser.connection.close();
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        if (browser.child.exitCode !== null || !browser.child.pid) return resolve(true);
        browser.child.once('exit', () => resolve(true));
        setTimeout(() => resolve(false), 3_000);
      }),
    ]);
    if (!exited && browser.child.pid) {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      try {
        await promisify(execFile)('taskkill', ['/PID', String(browser.child.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        // 已退出则忽略
      }
    }
    return true;
  }

  /* ------------------------------ 人工输入让位（FR-4.5 M0 机制桩） ------------------------------ */

  /** 置「人工接管中」：真实输入信号接线归 M1（本方法即测试钩子与未来信号源的统一入口） */
  yieldToUser(source: 'user-input' | 'manual' | 'e2e-hook', reason = 'user-activity'): void {
    this.yieldFlag.engage(source, reason, this.now());
    this.logger.userAction('browser:yield-to-user', { source, reason, note: 'M0 机制桩（FR-4.5 简化口径见 ADR §5）' });
  }

  resumeFromYield(reason = 'user-idle-resume'): boolean {
    const released = this.yieldFlag.release();
    if (released) {
      this.logger.userAction('browser:resume-from-yield', { reason });
    }
    return released;
  }

  /** M1 自动化动作队列的唯一入口（让位期间挂起；M0 无调用方，仅机制预留 + 测试钩子） */
  whenAutomationAllowed(): Promise<void> {
    return this.yieldFlag.whenAutomationAllowed();
  }

  /**
   * M1 采集自动化会话准备（todo 7⑤）：flat attach 平台标签页 → Page.enable →
   * addScriptToEvaluateOnNewDocument 注入 webdriver 去标志（stealth 保守三项之一）与
   * FR-4.5 passive 输入监听。返回会话句柄供 CdpAutomation 使用；
   * 所有后续 CDP 动作仍须经 whenAutomationAllowed()（本方法只是注入点，非动作通道）。
   */
  async prepareAutomationTab(): Promise<{ connection: import('./cdp').CdpConnection; sessionId: string; targetId: string }> {
    const browser = this.launched;
    if (!browser || browser.connection.isClosed) {
      throw new Error('E-BROWSER-CDP-ATTACH-FAILED: 无已接管浏览器可自动化');
    }
    await this.refreshOpenTabs(browser.connection);
    const tabs = this.openTabs ?? [];
    const platform = this.currentPlatform;
    const target = platform ? tabs.find((t) => t.url.includes(this.platformHost(platform))) : undefined;
    const targetId = target?.targetId ?? tabs[tabs.length - 1]?.targetId ?? null;
    if (!targetId) throw new Error('E-BROWSER-CDP-ATTACH-FAILED: 无可用目标页');
    const attached = await browser.connection.send<{ sessionId?: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId ?? '';
    await browser.connection.send('Page.enable', {}, sessionId);
    await browser.connection.send('Page.addScriptToEvaluateOnNewDocument', { source: WEBDRIVER_FLAG_REMOVAL_SCRIPT }, sessionId);
    await browser.connection.send('Page.addScriptToEvaluateOnNewDocument', { source: PASSIVE_INPUT_LISTENER_SCRIPT }, sessionId);
    this.logger.automationStep('browser:automation-tab-prepared', { targetId, note: 'FR-4.5 passive 监听 + stealth 去标志（addScriptToEvaluateOnNewDocument）' });
    return { connection: browser.connection, sessionId, targetId };
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  /** app 退出联动（main will-quit）：关浏览器进程（Profile 冲刷）不留孤儿 Chrome */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopHealthLoop();
    if (this.relaunchTimer) {
      clearTimeout(this.relaunchTimer);
      this.relaunchTimer = null;
    }
    const browser = this.launched;
    if (browser) {
      await this.closeBrowser(browser);
      this.launched = null;
    }
  }
}

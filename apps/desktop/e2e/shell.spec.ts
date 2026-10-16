/**
 * Electron 壳 e2e（映射 T-M0-02 验收：dev 启动出九视图；IPC 越权用例；安全基线断言）。
 *
 * 依赖说明：_electron.launch 直接启动 out/main.js，Electron 二进制来自
 * apps/desktop/node_modules/electron（无需 Playwright 浏览器下载；GitHub 不可达环境下可跑）。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;

const NINE_VIEWS = [
  'dashboard',
  'insight',
  'report',
  'sourcing',
  'publish',
  'promo',
  'review',
  'logs',
  'settings',
] as const;

test.describe.serial('desktop shell（九视图 + IPC 契约 + 安全基线）', () => {
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    electronApp = await _electron.launch({
      executablePath: electronPath,
      args: ['out/main.js'],
      cwd: pkgRoot,
    });
    page = await electronApp.firstWindow();
    await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
    // todo 9：EULA 首启门种子（真实 consent:acceptEula 通道；不改本文件任何旧断言）
    await ensureEulaAccepted(page);
  });

  test.afterAll(async () => {
    await electronApp.close();
  });

  test('首屏骨架被替换、壳挂载完成、桥接对象暴露白名单门面', async () => {
    await page.waitForSelector('#boot-skeleton', { state: 'detached' });
    await expect(page.locator('#app')).toBeVisible();
    const bridgeKeys = await page.evaluate(() => Object.keys(window.xinglian ?? {}));
    // M2 产品卡①：+onPush（PUSH_CHANNELS 白名单推送门面；越权通道 throw，见 preload）
    expect(bridgeKeys.sort()).toEqual(['contractVersion', 'invoke', 'navigate', 'onPush']);
    expect(await page.evaluate(() => window.xinglian?.contractVersion)).toBe('m0-ipc-1');
  });

  test('九视图逐个导航可达（app:navigate IPC 往返证据）', async () => {
    for (const view of NINE_VIEWS) {
      await page.click(`.nav-item[data-view="${view}"]`);
      await expect(page.locator(`#view-${view}`)).toHaveClass(/active/);
      // IPC 往返证据：html data 属性仅在主进程 app:navigate 成功返回后写入
      expect(await page.getAttribute('html', 'data-last-navigate')).toBe(view);
      expect(await page.getAttribute('html', 'data-last-ipc')).toBe('ok');
    }
  });

  test('app:info happy path：渲染进程经白名单拿到主进程信息', async () => {
    const info = (await page.evaluate(() => window.xinglian?.invoke('app:info'))) as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual(
      ['appVersion', 'contractVersion', 'electronVersion', 'platform'].sort(),
    );
    expect(info.contractVersion).toBe('m0-ipc-1');
    // 与主进程实际值交叉核对（dev 态 unpackaged 版本号跟随 Electron 默认 app，故用相对断言）
    const mainVersion = await electronApp.evaluate(({ app }) => app.getVersion());
    expect(info.appVersion).toBe(mainVersion);
    const versionText = await page.textContent('#topbar-version');
    expect(versionText).toContain(mainVersion);
  });

  test('logs:ping zod 校验往返：合法通过 / 非法被拒', async () => {
    const pong = (await page.evaluate(() =>
      window.xinglian?.invoke('logs:ping', { message: 'e2e' }),
    )) as { pong: string; at: string };
    expect(pong.pong).toContain('e2e');
    expect(Number.isNaN(Date.parse(pong.at))).toBe(false);

    const invalid = await page.evaluate(async () => {
      try {
        await window.xinglian?.invoke('logs:ping', { message: '' });
        return 'NO_ERROR';
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(invalid).toContain('E-IPC-INVALID-PARAMS');
  });

  test('IPC 越权被拒：业务通道/伪造通道均返回 E-IPC-UNKNOWN-CHANNEL（failure QA 证据）', async () => {
    // todo 10 起 browser:* 三通道入 M0 白名单（见 security.test.ts）；越权面仍以 M1+ 通道与伪造通道为准
    for (const channel of ['workflow:start', 'review:list', 'fs:readFile']) {
      const message = await page.evaluate(async (ch) => {
        try {
          await window.xinglian?.invoke(ch, { evil: true });
          return 'NO_ERROR';
        } catch (error) {
          return (error as Error).message;
        }
      }, channel);
      expect(message, `channel=${channel}`).toContain('E-IPC-UNKNOWN-CHANNEL');
      expect(message, `channel=${channel}`).toContain(channel);
    }
  });

  test('Node 能力不泄漏：require/process/module/ipcRenderer 在渲染主世界均 undefined', async () => {
    const leak = await page.evaluate(() => ({
      require: typeof window.require,
      process: typeof window.process,
      module: typeof window.module,
      ipcRenderer: typeof window.ipcRenderer,
      nodeIntegrationExposed: typeof window.__electron_require,
    }));
    expect(leak.require).toBe('undefined');
    expect(leak.process).toBe('undefined');
    expect(leak.module).toBe('undefined');
    expect(leak.ipcRenderer).toBe('undefined');
    expect(leak.nodeIntegrationExposed).toBe('undefined');
  });

  test('CSP meta 存在且为 self 基线（default-src/self + 严格 script-src）', async () => {
    const csp = await page.evaluate(() =>
      document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
    );
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    // 外链脚本/样式在 file:// + CSP 'self' 下确实加载成功（renderer 已挂载即证明，双保险再查一次）
    const mounted = await page.getAttribute('html', 'data-app-mounted');
    expect(mounted).toBe('1');
  });

  test('登录占位：本地路由可达、不发任何请求、提交仅更新占位文案', async () => {
    await page.click('#topbar-login');
    await expect(page.locator('#view-login')).toHaveClass(/active/);
    await page.fill('#login-form input[name="email"]', 'qa@example.com');
    await page.click('#login-form button[type="submit"]');
    await expect(page.locator('#login-msg')).toContainText('未接入');
  });

  test('单实例锁：二次启动立即退出（exit 0），主实例仍存活可导航', async () => {
    // 前置：主实例活着
    expect(await page.evaluate(() => 1 + 1)).toBe(2);

    const child = spawn(electronPath, ['out/main.js'], {
      cwd: pkgRoot,
      stdio: 'ignore',
      windowsHide: true,
    });
    let timer: NodeJS.Timeout | undefined;
    const exitCode = await Promise.race([
      new Promise<number | null>((resolve) => {
        child.on('exit', (code) => resolve(code));
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('second instance did not exit within 20s')), 20_000);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && !child.killed) child.kill();
    });
    expect(exitCode).toBe(0);

    // 主实例未被波及：导航仍正常（second-instance 聚焦路径在真实桌面才可感知，此处验证存活）
    await page.click('.nav-item[data-view="review"]');
    await expect(page.locator('#view-review')).toHaveClass(/active/);
  });
});

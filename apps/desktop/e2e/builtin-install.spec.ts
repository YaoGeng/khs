/**
 * 内置浏览器安装 e2e（m2-builtin-browser-plan B4）：
 * 哈希不符拒绝路径（fixture：假源 ×3 → failed 态 UI 断言）。344MB 真实下载不进 ci
 * （成功路径由一次性真实安装留证 + 单测覆盖，见 .omo/evidence/m2-builtin-browser/b4-real-install.md）。
 *
 * 机制：XINGLIAN_BUILTIN_BROWSER_ROOT 指向临时目录 + XINGLIAN_BUILTIN_SNAPSHOT_URL 指向
 * 本测试起的本地 http 源（内容 ≠ pin 的哈希）→ installBuiltinBrowser 三次重试后
 * E-BUILTIN-HASH-MISMATCH → 设置页状态行「安装失败」+ data-builtin-install="failed"。
 * 诚实性：mock 的只有「下载源」（本地 http 假包）；下载/流式哈希/重试/状态机/UI 全链路生产。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;

const BOGUS_ZIP = Buffer.alloc(4096, 0x5a); // 4KB 假包体（≠ pin 哈希）

let electronApp: ElectronApplication;
let page: Page;
let server: Server;
let serverPort = 0;
let browsersRoot: string;

test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(BOGUS_ZIP.length) });
    res.end(BOGUS_ZIP);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverPort = (server.address() as { port: number }).port;
  browsersRoot = mkdtempSync(path.join(tmpdir(), 'xhs-builtin-e2e-'));

  electronApp = await _electron.launch({
    executablePath: electronPath,
    args: ['out/main.js'],
    cwd: pkgRoot,
    env: {
      ...process.env,
      XINGLIAN_BUILTIN_BROWSER_ROOT: browsersRoot,
      XINGLIAN_BUILTIN_SNAPSHOT_URL: `http://127.0.0.1:${serverPort}/chrome-win.zip`,
    },
  });
  page = await electronApp.firstWindow();
  await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
  await ensureEulaAccepted(page);
});

test.afterAll(async () => {
  await electronApp.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('内置浏览器：假源哈希不符 → 三次重试后 failed 态可见（不误装）', async () => {
  await page.click('.nav-item[data-view="settings"]');
  const status = page.locator('#builtin-install-status');
  await expect(status).toHaveText(/未安装/);

  await page.locator('#builtin-install-btn').click();
  await expect(page.locator('#builtin-progress-track')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#builtin-install-status')).toHaveText(/安装失败/, { timeout: 30_000 });
  await expect(page.locator('#builtin-install-status')).toHaveText(/E-BUILTIN-HASH-MISMATCH/);
  expect(await page.getAttribute('html', 'data-builtin-install')).toBe('failed');
  // 假源被拒：临时根目录不得出现已安装的 chrome.exe
  const installedExe = path.join(browsersRoot, 'chromium-1710741', 'chrome-win', 'chrome.exe');
  const { existsSync } = await import('node:fs');
  expect(existsSync(installedExe)).toBe(false);
});

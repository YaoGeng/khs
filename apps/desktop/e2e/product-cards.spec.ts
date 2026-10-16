/**
 * M2 产品三卡 e2e（2026-10-15 用户新增需求；FR-4.7 爆款清单 / FR-12.7 自动化档位 / FR-3.7 镜像预览）。
 *
 * 覆盖（全部无需真实浏览器与真实 LLM Key——省 BYOK 口径）：
 * - 卡③：设置页档位开关 → automation:getTier/setTier kv 往返 + html 回显标记；
 * - 卡②：insight 视图爆款区块空态渲染 + viral:refresh 重算（无采集任务 → 稳定错误文案）
 *   + 无 Key 时 viral:generateRationale 的引导性报错（E-VIRAL-LLM-NOT-CONFIGURED）；
 * - 卡①：mirror:start 无接管浏览器 → E-BROWSER-CDP-ATTACH-FAILED + 面板失败提示（只读边界文案在场）。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, createPrivateKey, randomUUID, sign as edSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;
// 与 license.spec.ts 同源：M0 测试私钥签发有效 license（爆款重算/解读/镜像为写入口，锁定态下按钮禁用）
const TEST_PRIVATE_PEM = readFileSync(path.join(__dirname, '../../server/keys/license-private.pem'), 'utf8');

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

function signLicenseJwt(): string {
  const header = { alg: 'EdDSA', typ: 'license', kid: 'm0-license-test-1' };
  const payload = {
    sub: 'e2e-desktop-user',
    typ: 'license',
    plan: 'month',
    tier: 'personal',
    device_limit: 1,
    exp: Math.floor(Date.now() / 1000) + 31 * 24 * 3600,
    device_hash: '',
    jti: randomUUID(),
  };
  const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
  const signature = edSign(null, Buffer.from(signingInput, 'utf8'), createPrivateKey(TEST_PRIVATE_PEM));
  return `${signingInput}.${enc(signature)}`;
}

interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
  userData: string;
}

async function launchApp(userData: string, licenseFile: string): Promise<LaunchedApp> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XINGLIAN_USER_DATA: userData,
    XINGLIAN_LICENSE_FILE: licenseFile,
    XINGLIAN_DEBUG_HOOKS: '1',
    // 无 fixture / 无报告步骤：本 spec 只验三卡 UI 面与稳定错误码，不跑采集管道
    XINGLIAN_REPORT_STEP: 'off',
  };
  const electronApp = await _electron.launch({
    executablePath: electronPath,
    args: ['out/main.js'],
    cwd: pkgRoot,
    env,
  });
  const page = await electronApp.firstWindow();
  await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
  await ensureEulaAccepted(page);
  return { electronApp, page, userData };
}

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(async ([ch, pl]) => (await window.xinglian?.invoke(ch as string, pl)) as never, [channel, payload]) as Promise<T>;
}

test.describe.serial('M2 产品三卡（爆款清单 / 自动化档位 / 镜像预览）', () => {
  let userData: string;
  let licenseFile: string;

  test.beforeAll(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-product-cards-e2e-'));
    licenseFile = path.join(userData, 'license.json');
    writeFileSync(
      licenseFile,
      JSON.stringify({
        licenseJwt: signLicenseJwt(),
        lastVerifiedAt: new Date().toISOString(),
        deviceHash: createHash('sha256').update('e2e').digest('hex'),
      }),
      'utf8',
    );
  });

  test.afterAll(async () => {
    // 先关应用再删 userData（Windows 下 SQLite/日志句柄未释放时 rmSync EPERM）
    await app?.electronApp.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  });

  let app: LaunchedApp | null = null;

  test.beforeAll(async () => {
    app = await launchApp(userData, licenseFile);
  });

  test('卡③：设置页档位开关——默认 semi，切 auto 后 kv 往返 + 状态行回显，回切 semi', async () => {
    const { page } = app;

    const initial = await invoke<{ tier: string }>(page, 'automation:getTier', {});
    expect(initial.tier).toBe('semi');
    await expect(page.locator('html')).toHaveAttribute('data-automation-tier', 'semi');

    await page.click('.nav-item[data-view="settings"]');
    await expect(page.locator('#view-settings')).toHaveClass(/active/);
    await expect(page.locator('#automation-card')).toBeVisible();
    await expect(page.locator('#automation-tier-note')).toContainText('永远保留');

    await page.check('#automation-tier-auto');
    await expect(page.locator('html')).toHaveAttribute('data-automation-tier-set', 'done:auto', { timeout: 10_000 });
    await expect(page.locator('html')).toHaveAttribute('data-automation-tier', 'auto');
    expect((await invoke<{ tier: string }>(page, 'automation:getTier', {})).tier).toBe('auto');

    await page.check('#automation-tier-semi');
    await expect(page.locator('html')).toHaveAttribute('data-automation-tier', 'semi', { timeout: 10_000 });
  });

  test('卡②：insight 爆款区块——空态渲染；无采集任务重算 → 稳定错误；无 Key 解读 → 配置引导', async () => {
    const { page } = app;

    await page.click('.nav-item[data-view="insight"]');
    await expect(page.locator('#view-insight')).toHaveClass(/active/);
    await expect(page.locator('#viral-card')).toBeVisible();
    await expect(page.locator('#viral-formula-note')).toContainText('赞×1 + 藏×5 + 评×3');
    // 空态：无采集任务 → topicId 解析为空串，快照空 items
    await expect(page.locator('html')).toHaveAttribute('data-viral-loaded', '1', { timeout: 10_000 });
    expect(await page.locator('#viral-list li').count()).toBe(0);

    // 重算（业务写面走 EULA 门内）：无采集任务 → E-VIRAL-NO-TOPIC 稳定错误
    await page.click('#viral-refresh');
    await expect(page.locator('html')).toHaveAttribute('data-viral-action', 'failed:viral:refresh', { timeout: 10_000 });
    await expect(page.locator('html')).toHaveAttribute('data-viral-action-error', /E-VIRAL-NO-TOPIC/);

    // 解读（单次 LLM 调用）：主题解析先于 Key 检查 → 同为 NO-TOPIC 引导先去采集
    // （E-VIRAL-LLM-NOT-CONFIGURED 的设置引导路径由 viral-service 单测覆盖，不在此造库）
    await page.click('#viral-rationale');
    await expect(page.locator('html')).toHaveAttribute('data-viral-action', 'failed:viral:generateRationale', { timeout: 10_000 });
    await expect(page.locator('html')).toHaveAttribute('data-viral-action-error', /E-VIRAL-NO-TOPIC/);
    await expect(page.locator('#viral-status')).toContainText('解读失败');
  });

  test('卡①：工作台镜像面板——无接管浏览器 start → 稳定错误码 + 失败提示（只读边界文案在场）', async () => {
    const { page } = app;

    await page.click('.nav-item[data-view="dashboard"]');
    await expect(page.locator('#view-dashboard')).toHaveClass(/active/);
    await expect(page.locator('#mirror-card')).toBeVisible();
    await expect(page.locator('#mirror-card .mirror-status')).toContainText('只读');

    await page.click('#mirror-toggle');
    await expect(page.locator('html')).toHaveAttribute('data-mirror-action', 'start:failed', { timeout: 10_000 });
    await expect(page.locator('html')).toHaveAttribute('data-mirror-action-error', /E-BROWSER-CDP-ATTACH-FAILED/);
    await expect(page.locator('#mirror-card .mirror-status')).toContainText('镜像操作失败');
    // 面板保持停止态：未显示镜像画面容器
    await expect(page.locator('#mirror-frame-wrap')).toBeHidden();
  });
});

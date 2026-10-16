/**
 * license 授权链路 e2e（todo 8 = T-M0-07；映射任务卡验收：有效 license 解锁 /
 * 无 license 或过期锁定但 logs 可达 / 72h 宽限边界 / UI 激活流占位）。
 *
 * 桌面侧 M0 走「注入 license 文件 + 公钥验签」路径：
 * - 测试进程持 apps/server/keys/license-private.pem（M0 固定测试密钥对，与 desktop 内置公钥同源，
 *   见 docs/adr/notes-license-m0.md §1）在测试内签发 license；
 * - 经 XINGLIAN_LICENSE_FILE（dev/test seam）把 license envelope 注入被测实例。
 * 真机联网激活流归 M5，不在本文件范围。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, createPrivateKey, randomUUID, sign as edSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
// Electron 二进制与 shell.spec.ts 同源（apps/desktop/node_modules/electron）
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;
// apps/desktop/e2e → apps/server/keys：M0 固定测试密钥对（跨包只读 fixture 文件，非模块 import）
const TEST_PRIVATE_PEM = readFileSync(
  path.join(__dirname, '../../server/keys/license-private.pem'),
  'utf8',
);

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const HOUR_MS = 60 * 60 * 1000;

interface LicenseClaimsE2E {
  sub: string;
  typ: 'license';
  plan: string;
  tier: string;
  device_limit: number;
  exp: number;
  device_hash: string;
  jti: string;
}

/** 用测试私钥签发 Ed25519 license JWT（header 与服务端签发器一致：EdDSA/license/kid） */
function signLicenseJwt(claims: Partial<LicenseClaimsE2E> & { exp: number }): string {
  const header = { alg: 'EdDSA', typ: 'license', kid: 'm0-license-test-1' };
  const payload: LicenseClaimsE2E = {
    sub: 'e2e-desktop-user',
    typ: 'license',
    plan: 'month',
    tier: 'personal',
    device_limit: 1,
    device_hash: '',
    jti: randomUUID(),
    ...claims,
  };
  const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
  const signature = edSign(null, Buffer.from(signingInput, 'utf8'), createPrivateKey(TEST_PRIVATE_PEM));
  return `${signingInput}.${enc(signature)}`;
}

/** 篡改 payload 的 license（同签名段 + 伪造 payload 段）→ 验签必失败 */
function tamperPayload(token: string): string {
  const [h, , s] = token.split('.');
  const evilPayload = enc(
    JSON.stringify({ sub: 'e2e-desktop-user', typ: 'license', plan: 'year', tier: 'personal', device_limit: 99, exp: Math.floor(Date.now() / 1000) + 3600, device_hash: '', jti: 'evil' }),
  );
  return `${h}.${evilPayload}.${s}`;
}

interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
}

test.describe.serial('license 锁定状态机 e2e（FR-1.5/FR-1.6）', () => {
  let licenseDir: string;
  let licenseFile: string;

  test.beforeAll(() => {
    licenseDir = mkdtempSync(path.join(tmpdir(), 'license-e2e-'));
    licenseFile = path.join(licenseDir, 'license.json');
  });

  test.afterAll(() => {
    rmSync(licenseDir, { recursive: true, force: true });
  });

  async function launch(): Promise<LaunchedApp> {
    const electronApp = await _electron.launch({
      executablePath: electronPath,
      args: ['out/main.js'],
      cwd: pkgRoot,
      env: { ...process.env, XINGLIAN_LICENSE_FILE: licenseFile },
    });
    const page = await electronApp.firstWindow();
    await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
    // todo 9：EULA 首启门种子（真实 consent:acceptEula 通道；不改本文件任何旧断言）
    await ensureEulaAccepted(page);
    return { electronApp, page };
  }

  async function launchWithLicense(licenseJwt: string | null, lastVerifiedAt: string): Promise<LaunchedApp> {
    if (licenseJwt === null) {
      rmSync(licenseFile, { force: true });
    } else {
      writeFileSync(
        licenseFile,
        JSON.stringify({ licenseJwt, lastVerifiedAt, deviceHash: createHash('sha256').update('e2e').digest('hex') }),
        'utf8',
      );
    }
    return launch();
  }

  async function close(app: LaunchedApp): Promise<void> {
    await app.electronApp.close();
  }

  /** 等待初始 license:status 渲染完成（html 数据标记是主进程状态机的渲染投影） */
  function waitStatusRendered(page: Page): Promise<string> {
    return page.waitForSelector('html[data-license-loaded="1"]', { timeout: 15_000 }).then(() => page.getAttribute('html', 'data-license-state') ?? '');
  }

  const WRITE_VIEWS = ['dashboard', 'insight', 'sourcing', 'publish', 'promo', 'review'];

  test('无 license → 锁定：logs/settings 可达、工作流执行入口全部置灰、锁定横幅可见', async () => {
    const app = await launchWithLicense(null, '');
    const { page } = app;
    try {
      expect(await waitStatusRendered(page)).toBe('locked');
      expect(await page.getAttribute('html', 'data-license-reason')).toBe('NO_LICENSE');

      // 锁定不锁路由：logs（历史查看+日志导出）/settings 可达（FR-1.6 保留路由）
      for (const view of ['logs', 'settings']) {
        await page.click(`.nav-item[data-view="${view}"]`);
        await expect(page.locator(`#view-${view}`)).toHaveClass(/active/);
        expect(await page.getAttribute('html', 'data-last-navigate')).toBe(view);
      }

      // 工作流写入口：6 视图全部 data-entry-locked + 横幅可见；仍带占位执行按钮的视图
      // 同时断言按钮 disabled（sourcing 自 T-M2-03 起为真实候选清单读面，无占位按钮
      // ——T-M2-04 收藏/询盘将带回真实写入口并恢复按钮级断言）
      for (const view of WRITE_VIEWS) {
        await page.click(`.nav-item[data-view="${view}"]`);
        const section = page.locator(`#view-${view}`);
        await expect(section).toHaveClass(/active/);
        expect(await section.getAttribute('data-entry-locked')).toBe('true');
        const entry = section.locator('.workflow-entry[data-write-entry]');
        if ((await entry.count()) > 0) {
          expect(await entry.isDisabled()).toBe(true);
        }
        expect(await section.locator('[data-license-lock]').isVisible()).toBe(true);
      }

      // 设置页状态行
      await page.click('.nav-item[data-view="settings"]');
      await expect(page.locator('#license-status-line')).toContainText('已锁定');
    } finally {
      await close(app);
    }
  });

  test('有效 license（宽限内）→ 解锁：执行入口可用，点击出占位提示，状态行回显套餐', async () => {
    const licenseJwt = signLicenseJwt({ exp: Math.floor(Date.now() / 1000) + 31 * 24 * 3600 });
    const app = await launchWithLicense(licenseJwt, new Date(Date.now() - 1 * HOUR_MS).toISOString());
    const { page } = app;
    try {
      expect(await waitStatusRendered(page)).toBe('unlocked');
      expect(await page.getAttribute('html', 'data-license-reason')).toBe('WITHIN_GRACE');

      for (const view of WRITE_VIEWS) {
        await page.click(`.nav-item[data-view="${view}"]`);
        const section = page.locator(`#view-${view}`);
        await expect(section).toHaveClass(/active/);
        expect(await section.getAttribute('data-entry-locked')).toBe('false');
        const entry = section.locator('.workflow-entry[data-write-entry]');
        if ((await entry.count()) > 0) {
          expect(await entry.isDisabled()).toBe(false);
          await entry.click();
          await expect(section.locator('[data-entry-msg]')).toBeVisible();
        }
      }

      await page.click('.nav-item[data-view="settings"]');
      await expect(page.locator('#license-status-line')).toContainText('已解锁');
      await expect(page.locator('#license-status-line')).toContainText('month/personal');
    } finally {
      await close(app);
    }
  });

  test('宽限超期（lastVerifiedAt=73h 前）→ 锁定 GRACE_EXCEEDED，logs 仍可达（FR-1.5）', async () => {
    const licenseJwt = signLicenseJwt({ exp: Math.floor(Date.now() / 1000) + 31 * 24 * 3600 });
    const app = await launchWithLicense(licenseJwt, new Date(Date.now() - 73 * HOUR_MS).toISOString());
    const { page } = app;
    try {
      expect(await waitStatusRendered(page)).toBe('locked');
      expect(await page.getAttribute('html', 'data-license-reason')).toBe('GRACE_EXCEEDED');
      await page.click('.nav-item[data-view="logs"]');
      await expect(page.locator('#view-logs')).toHaveClass(/active/);
      const section = page.locator('#view-dashboard');
      await page.click('.nav-item[data-view="dashboard"]');
      expect(await section.getAttribute('data-entry-locked')).toBe('true');
    } finally {
      await close(app);
    }
  });

  test('过期 license → 锁定 EXPIRED，logs 可达（FR-1.6）', async () => {
    const licenseJwt = signLicenseJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const app = await launchWithLicense(licenseJwt, new Date().toISOString());
    const { page } = app;
    try {
      expect(await waitStatusRendered(page)).toBe('locked');
      expect(await page.getAttribute('html', 'data-license-reason')).toBe('EXPIRED');
      await page.click('.nav-item[data-view="logs"]');
      await expect(page.locator('#view-logs')).toHaveClass(/active/);
      // 设置页状态行（锁定原因可读，FR-1.6 的用户可感知面）
      await page.click('.nav-item[data-view="settings"]');
      await expect(page.locator('#license-status-line')).toContainText('已锁定');
    } finally {
      await close(app);
    }
  });

  test('篡改 license → 锁定 SIGNATURE_INVALID（e2e 侧再证验签拒绝）', async () => {
    const licenseJwt = tamperPayload(signLicenseJwt({ exp: Math.floor(Date.now() / 1000) + 31 * 24 * 3600 }));
    const app = await launchWithLicense(licenseJwt, new Date().toISOString());
    const { page } = app;
    try {
      expect(await waitStatusRendered(page)).toBe('locked');
      expect(await page.getAttribute('html', 'data-license-reason')).toBe('SIGNATURE_INVALID');
    } finally {
      await close(app);
    }
  });

  test('UI 激活流（settings 占位）：有效 license 解锁 → 过期 license 拒绝覆盖 → 再次有效恢复解锁', async () => {
    const app = await launchWithLicense(null, '');
    const { page } = app;
    try {
      expect(await waitStatusRendered(page)).toBe('locked');
      await page.click('.nav-item[data-view="settings"]');

      // ① 有效 license 激活 → 解锁
      const validJwt = signLicenseJwt({ exp: Math.floor(Date.now() / 1000) + 31 * 24 * 3600 });
      await page.fill('#license-jwt-input', validJwt);
      await page.click('#license-activate-btn');
      await page.waitForSelector('html[data-license-activate="done"]', { timeout: 15_000 });
      expect(await page.getAttribute('html', 'data-license-state')).toBe('unlocked');
      await expect(page.locator('#license-status-line')).toContainText('已解锁');
      // 解锁态下执行入口确实恢复（激活链路端到端生效）
      await page.click('.nav-item[data-view="publish"]');
      const publish = page.locator('#view-publish');
      expect(await publish.getAttribute('data-entry-locked')).toBe('false');
      expect(await publish.locator('.workflow-entry[data-write-entry]').isDisabled()).toBe(false);

      // ② 用过期 license 再次激活 → 验签拒绝、不落盘（不覆盖有效 license），本会话按 EXPIRED 锁定
      await page.click('.nav-item[data-view="settings"]');
      const expiredJwt = signLicenseJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
      await page.fill('#license-jwt-input', expiredJwt);
      await page.click('#license-activate-btn');
      await page.waitForSelector('html[data-license-activate="done"]', { timeout: 15_000 });
      expect(await page.getAttribute('html', 'data-license-state')).toBe('locked');
      expect(await page.getAttribute('html', 'data-license-reason')).toBe('EXPIRED');
      await expect(page.locator('#license-status-line')).toContainText('已锁定');

      // ③ 重新激活有效 license → 恢复解锁（本地路径往返幂等）
      await page.fill('#license-jwt-input', validJwt);
      await page.click('#license-activate-btn');
      await page.waitForSelector('html[data-license-activate="done"]', { timeout: 15_000 });
      expect(await page.getAttribute('html', 'data-license-state')).toBe('unlocked');
    } finally {
      await close(app);
    }
  });

  test('UI 激活流：空输入被拒（不发起 invoke），状态不变', async () => {
    const app = await launchWithLicense(null, '');
    const { page } = app;
    try {
      expect(await waitStatusRendered(page)).toBe('locked');
      await page.click('.nav-item[data-view="settings"]');
      await page.click('#license-activate-btn');
      expect(await page.getAttribute('html', 'data-license-activate')).toBe('invalid-input');
      expect(await page.getAttribute('html', 'data-license-state')).toBe('locked');
    } finally {
      await close(app);
    }
  });

  test('安全基线不受影响：require/process 仍 undefined、越权通道仍被拒', async () => {
    const app = await launchWithLicense(null, '');
    const { page } = app;
    try {
      const leak = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process }));
      expect(leak.require).toBe('undefined');
      expect(leak.process).toBe('undefined');
      const message = await page.evaluate(async () => {
        try {
          await window.xinglian?.invoke('license:delete', {});
          return 'NO_ERROR';
        } catch (error) {
          return (error as Error).message;
        }
      });
      expect(message).toContain('E-IPC-UNKNOWN-CHANNEL');
    } finally {
      await close(app);
    }
  });
});

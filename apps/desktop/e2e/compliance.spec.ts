/**
 * 合规 e2e（todo 9 = T-M0-11；FR-1.9 EULA 首启确认门 / FR-12.6 遥测 opt-in）。
 *
 * 场景：
 * A. 首启 → EULA 弹窗 → 六工作流路由锁（UI 导航拒绝 + 主进程 app:navigate 拒绝双证据）
 *    → 同意（含遥测独立勾选）→ 路由解锁 → consents 记录落库断言（经 store 查询：版本号+时间戳字段齐）
 * B. 重启持久化 + settings 遥测开关随时改 + 匿名化口径声明文案位
 * C. EULA 版本升级（XINGLIAN_EULA_VERSION seam，非生产后门：确认流全链路照常）→ 重确认弹窗
 * D. 拒绝 EULA → 锁定保持 + 退出提示 → 重启后仍锁
 *
 * 诚实性：拒绝态/拦截态均有真实断言；无任何「跳过弹窗」捷径。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;

const SIX_WORKFLOW_VIEWS = ['dashboard', 'insight', 'sourcing', 'publish', 'promo', 'review'] as const;
const DRAFT_V1 = '0.1.0-draft';
const DRAFT_V2 = '0.2.0-draft';

interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
}

interface ConsentState {
  eulaVersion: string;
  eulaStatus: 'unconfirmed' | 'accepted' | 'rejected' | 'version-changed';
  requiresConfirm: boolean;
  confirmedVersion: string | null;
  confirmedAt: string | null;
  rejectedAt: string | null;
  telemetryConsent: 'granted' | 'denied' | 'unasked';
}

test.describe.serial('compliance EULA/遥测（todo 9 = T-M0-11）', () => {
  let userData: string;

  test.beforeAll(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-eula-'));
  });

  test.afterAll(() => {
    rmSync(userData, { recursive: true, force: true });
  });

  async function launch(env: Record<string, string> = {}): Promise<LaunchedApp> {
    const electronApp = await _electron.launch({
      executablePath: electronPath,
      args: ['out/main.js'],
      cwd: pkgRoot,
      env: { ...process.env, XINGLIAN_USER_DATA: userData, ...env },
    });
    const page = await electronApp.firstWindow();
    await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
    await page.waitForSelector('html[data-consent-loaded="1"]', { timeout: 30_000 });
    return { electronApp, page };
  }

  async function consentState(page: Page): Promise<ConsentState> {
    return (await page.evaluate(() => window.xinglian?.invoke('consent:state'))) as ConsentState;
  }

  test('A. 首启：EULA 弹窗 + 六工作流路由锁 → 同意（含遥测勾选）→ 解锁 + consents 落库', async () => {
    const { electronApp, page } = await launch();
    try {
      /* ---------- 首启态：弹窗出现（opt-in 复选框默认不勾） ---------- */
      expect(await page.getAttribute('html', 'data-eula-requires-confirm')).toBe('1');
      expect(await page.getAttribute('html', 'data-eula-state')).toBe('unconfirmed');
      expect(await page.getAttribute('html', 'data-eula-modal')).toBe('open');
      await expect(page.locator('#eula-modal')).toBeVisible();
      await expect(page.locator('#eula-version-label')).toHaveText(DRAFT_V1);
      expect(await page.locator('#eula-telemetry-consent').isChecked()).toBe(false);

      /* ---------- 未确认：六个工作流视图不可进入（UI 导航拒绝 + 主进程拒绝双证据） ----------
       * 先切到 logs（离开首屏激活的 dashboard），使「六个视图未变 active」对全部六视图都有判定力 */
      await page.click('.nav-item[data-view="logs"]');
      await expect(page.locator('#view-logs')).toHaveClass(/active/);

      for (const view of SIX_WORKFLOW_VIEWS) {
        await page.click(`.nav-item[data-view="${view}"]`);
        await expect(page.locator(`#view-${view}`), `view=${view}`).not.toHaveClass(/active/);
        expect(await page.getAttribute('html', 'data-eula-nav'), `view=${view}`).toBe('denied');
        const message = await page.evaluate(async (v) => {
          try {
            await window.xinglian?.invoke('app:navigate', { view: v });
            return 'NO_ERROR';
          } catch (error) {
            return (error as Error).message;
          }
        }, view);
        expect(message, `view=${view} 主进程路由锁`).toContain('E-COMPLIANCE-EULA-LOCKED');
      }
      await expect(page.locator('#eula-nav-banner')).toBeAttached();

      /* ---------- logs/settings 保持可达（FR-1.9：settings 承载遥测开关） ---------- */
      await page.click('.nav-item[data-view="logs"]');
      await expect(page.locator('#view-logs')).toHaveClass(/active/);
      await page.click('.nav-item[data-view="settings"]');
      await expect(page.locator('#view-settings')).toHaveClass(/active/);
      expect(await page.getAttribute('html', 'data-last-navigate')).toBe('settings');

      /* ---------- 同意（勾选遥测）→ 弹窗关闭 + 路由解锁 ---------- */
      await page.check('#eula-telemetry-consent');
      await page.click('#eula-accept-btn');
      await page.waitForSelector('html[data-eula-accept="done"]', { timeout: 15_000 });
      expect(await page.getAttribute('html', 'data-eula-requires-confirm')).toBe('0');
      expect(await page.getAttribute('html', 'data-eula-state')).toBe('accepted');
      expect(await page.getAttribute('html', 'data-eula-modal')).toBe('closed');
      await expect(page.locator('#eula-modal')).toBeHidden();
      expect(await page.getAttribute('html', 'data-telemetry-consent')).toBe('granted');

      for (const view of SIX_WORKFLOW_VIEWS) {
        await page.click(`.nav-item[data-view="${view}"]`);
        await expect(page.locator(`#view-${view}`), `view=${view}`).toHaveClass(/active/);
        expect(await page.getAttribute('html', 'data-last-navigate'), `view=${view}`).toBe(view);
        expect(await page.getAttribute('html', 'data-last-ipc'), `view=${view}`).toBe('ok');
      }

      /* ---------- consents 记录落库断言（经 store 查询：版本号+时间戳字段齐） ---------- */
      const state = await consentState(page);
      expect(state.confirmedVersion).toBe(DRAFT_V1);
      expect(Number.isNaN(Date.parse(state.confirmedAt ?? ''))).toBe(false);

      // 0002 迁移在真实 app 内生效（store-worker-ready 日志携带 schemaVersion≥2，logs 表可查）
      await expect
        .poll(
          async () => {
            const logs = (await page.evaluate(() =>
              window.xinglian?.invoke('logs:query', { category: 'system-error', limit: 100 }),
            )) as { rows: Array<{ msg: string; payload: { schemaVersion?: number } | null }> };
            const ready = logs.rows.find((r) => r.msg === 'store-worker-ready');
            return ready?.payload?.schemaVersion ?? 0;
          },
          { timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(2);
    } finally {
      await electronApp.close();
    }
  });

  test('B. 重启持久化 + settings 遥测开关随时改 + 匿名化口径声明文案位', async () => {
    const { electronApp, page } = await launch();
    try {
      /* ---------- 已确认态跨进程持久：弹窗不再出现 ---------- */
      expect(await page.getAttribute('html', 'data-eula-requires-confirm')).toBe('0');
      expect(await page.getAttribute('html', 'data-eula-modal')).toBe('closed');
      await expect(page.locator('#eula-modal')).toBeHidden();
      const stateBefore = await consentState(page);
      expect(stateBefore.eulaStatus).toBe('accepted');
      expect(stateBefore.telemetryConsent).toBe('granted');

      /* ---------- settings 遥测卡：声明文案位 + 开关 ---------- */
      await page.click('.nav-item[data-view="settings"]');
      await expect(page.locator('#telemetry-card')).toBeVisible();
      await expect(page.locator('#telemetry-anonymization-note')).toBeVisible();
      await expect(page.locator('#telemetry-anonymization-note')).toContainText('匿名化口径');
      expect(await page.locator('#telemetry-toggle').isChecked()).toBe(true);

      /* ---------- 关 → granted 翻 denied（consents 留痕，FR-12.6） ---------- */
      await page.uncheck('#telemetry-toggle');
      await page.waitForSelector('html[data-telemetry-set="done"]', { timeout: 15_000 });
      expect(await page.getAttribute('html', 'data-telemetry-consent')).toBe('denied');
      await expect(page.locator('#telemetry-status-line')).toContainText('已关闭');
      const deniedState = await consentState(page);
      expect(deniedState.telemetryConsent).toBe('denied');

      /* ---------- 开 → 恢复 granted（可随时改） ---------- */
      await page.check('#telemetry-toggle');
      await page.waitForSelector('html[data-telemetry-set="done"]', { timeout: 15_000 });
      expect(await page.getAttribute('html', 'data-telemetry-consent')).toBe('granted');

      /* ---------- EULA 确认记录本身不受遥测开关影响（confirmedAt 不变） ---------- */
      const stateAfter = await consentState(page);
      expect(stateAfter.eulaStatus).toBe('accepted');
      expect(stateAfter.confirmedAt).toBe(stateBefore.confirmedAt);
      expect(stateAfter.confirmedVersion).toBe(DRAFT_V1);
    } finally {
      await electronApp.close();
    }
  });

  test('C. EULA 版本升级 → 重确认（旧记录存在但版本不匹配 → 重弹；确认流全链路照常）', async () => {
    // test seam：XINGLIAN_EULA_VERSION 模拟新版发布（不旁路确认流——弹窗/落库/锁照常）
    const { electronApp, page } = await launch({ XINGLIAN_EULA_VERSION: DRAFT_V2 });
    try {
      expect(await page.getAttribute('html', 'data-eula-requires-confirm')).toBe('1');
      expect(await page.getAttribute('html', 'data-eula-state')).toBe('version-changed');
      expect(await page.getAttribute('html', 'data-eula-reconfirm')).toBe('1');
      await expect(page.locator('#eula-modal')).toBeVisible();
      await expect(page.locator('#eula-version-label')).toHaveText(DRAFT_V2);
      await expect(page.locator('#eula-reconfirm-note')).toBeVisible();
      await expect(page.locator('#eula-reconfirm-note')).toContainText(DRAFT_V1);
      await expect(page.locator('#eula-reconfirm-note')).toContainText(DRAFT_V2);

      // 旧记录存在但版本不匹配：confirmedVersion 仍是旧版
      const state = await consentState(page);
      expect(state.confirmedVersion).toBe(DRAFT_V1);
      expect(state.eulaVersion).toBe(DRAFT_V2);
      expect(Number.isNaN(Date.parse(state.confirmedAt ?? ''))).toBe(false);

      // 重确认前工作流视图仍锁（先切到 logs 离开首屏激活的 dashboard，使断言有判定力）
      await page.click('.nav-item[data-view="logs"]');
      await expect(page.locator('#view-logs')).toHaveClass(/active/);
      await page.click('.nav-item[data-view="dashboard"]');
      await expect(page.locator('#view-dashboard')).not.toHaveClass(/active/);
      expect(await page.getAttribute('html', 'data-eula-nav')).toBe('denied');

      // 重确认 → 新版本落库 → 解锁
      await page.click('#eula-accept-btn');
      await page.waitForSelector('html[data-eula-accept="done"]', { timeout: 15_000 });
      expect(await page.getAttribute('html', 'data-eula-state')).toBe('accepted');
      const after = await consentState(page);
      expect(after.confirmedVersion).toBe(DRAFT_V2);
      expect(Number.isNaN(Date.parse(after.confirmedAt ?? ''))).toBe(false);
      await page.click('.nav-item[data-view="dashboard"]');
      await expect(page.locator('#view-dashboard')).toHaveClass(/active/);
    } finally {
      await electronApp.close();
    }
  });

  test('D. 拒绝 EULA → 锁定保持 + 退出提示 → 重启后仍锁', async () => {
    const rejectDir = mkdtempSync(path.join(tmpdir(), 'xinglian-eula-reject-'));
    try {
      const first = await launchAt(rejectDir, {});
      const { electronApp, page } = first;
      /* ---------- 拒绝：记录留痕 + 弹窗保持 + 退出提示可见 + 功能持续锁定 ---------- */
      await page.click('#eula-reject-btn');
      await page.waitForSelector('html[data-eula-reject="shown"]', { timeout: 15_000 });
      expect(await page.getAttribute('html', 'data-eula-requires-confirm')).toBe('1');
      expect(await page.getAttribute('html', 'data-eula-state')).toBe('rejected');
      expect(await page.getAttribute('html', 'data-eula-modal')).toBe('open');
      await expect(page.locator('#eula-modal')).toBeVisible();
      await expect(page.locator('#eula-reject-msg')).toBeVisible();
      await expect(page.locator('#eula-reject-msg')).toContainText('不同意');
      await expect(page.locator('#eula-reject-msg')).toContainText('关闭窗口');

      const rejectedState = await consentState(page);
      expect(rejectedState.eulaStatus).toBe('rejected');
      expect(Number.isNaN(Date.parse(rejectedState.rejectedAt ?? ''))).toBe(false);

      for (const view of SIX_WORKFLOW_VIEWS) {
        // 先切到 logs 离开首屏激活的 dashboard，使「未变 active」对全部六视图都有判定力
        await page.click('.nav-item[data-view="logs"]');
        await expect(page.locator('#view-logs'), `view=${view} 前置`).toHaveClass(/active/);
        await page.click(`.nav-item[data-view="${view}"]`);
        await expect(page.locator(`#view-${view}`), `view=${view}`).not.toHaveClass(/active/);
      }
      await electronApp.close();

      /* ---------- 重启：拒绝记录持久化，锁定保持 ---------- */
      const second = await launchAt(rejectDir, {});
      const { electronApp: app2, page: page2 } = second;
      try {
        expect(await page2.getAttribute('html', 'data-eula-requires-confirm')).toBe('1');
        expect(await page2.getAttribute('html', 'data-eula-state')).toBe('rejected');
        await expect(page2.locator('#eula-modal')).toBeVisible();
        await expect(page2.locator('#eula-reject-msg')).toBeVisible();
        await page2.click('.nav-item[data-view="publish"]');
        await expect(page2.locator('#view-publish')).not.toHaveClass(/active/);
      } finally {
        await app2.close();
      }
    } finally {
      rmSync(rejectDir, { recursive: true, force: true });
    }
  });

  /** 独立 userData 启动（拒绝场景隔离用） */
  async function launchAt(dir: string, env: Record<string, string>): Promise<LaunchedApp> {
    const electronApp = await _electron.launch({
      executablePath: electronPath,
      args: ['out/main.js'],
      cwd: pkgRoot,
      env: { ...process.env, XINGLIAN_USER_DATA: dir, ...env },
    });
    const page = await electronApp.firstWindow();
    await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
    await page.waitForSelector('html[data-consent-loaded="1"]', { timeout: 30_000 });
    return { electronApp, page };
  }
});

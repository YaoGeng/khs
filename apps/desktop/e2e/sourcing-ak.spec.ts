/**
 * 1688 官方 API 检索 AK 配置 e2e（T-M2-05a）。
 *
 * 场景（设置性质 IPC + masked 出口；不触网——akSet 只落存储，路由只在检索时现读 AK）：
 * A. 首屏 AK 状态 = 未配置（检索走内置浏览器）；
 * B. 保存无法解析的 AK（32 位全 K → id 为空）→ E-SOURCING-AK-INVALID 引导文案；
 * C. 保存合法 AK → 已配置 ****<akId 后 4 位> + 密码框清空（secret 不回显）+
 *    页面全文不含 AK 原始串；
 * D. 清除 → 回未配置；
 * E. AK 配置期间既有 selection 检索面照常（fixture 播种候选正常渲染——传输路由
 *    只在真实检索时按 AK 现读，fixture 优先）。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));

/** 合法形态 AK（base64url(32 位 secret + akId)）——e2e 只落存储不发起任何真实 API 调用 */
const RAW_AK = Buffer.from(`${'S'.repeat(32)}E2EAKID-9876`, 'utf8').toString('base64url');

test.describe.serial('1688 官方 API AK 配置（T-M2-05a）', () => {
  let userData: string;
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-ak-'));
    electronApp = await _electron.launch({
      executablePath: requireFromDesktop('electron') as string,
      args: ['out/main.js'],
      cwd: pkgRoot,
      env: {
        ...process.env,
        XINGLIAN_USER_DATA: userData,
        XINGLIAN_DEBUG_HOOKS: '1',
        XINGLIAN_REPORT_STEP: 'off',
      },
    });
    page = await electronApp.firstWindow();
    await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
    await ensureEulaAccepted(page);
    await page.click('.nav-item[data-view="sourcing"]');
    await expect(page.locator('#view-sourcing')).toHaveClass(/active/);
  });

  test.afterAll(async () => {
    await electronApp.close();
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟：清理失败不影响验收 */
    }
  });

  test('A. 首屏状态 = 未配置（检索走内置浏览器）', async () => {
    await expect(page.locator('#sourcing-ak-status')).toHaveText('未配置（检索走内置浏览器）');
    await expect(page.locator('#sourcing-ak-clear')).toBeHidden();
  });

  test('B. 无法解析的 AK → E-SOURCING-AK-INVALID 引导文案且不落库', async () => {
    await page.fill('#sourcing-ak-input', 'K'.repeat(32));
    await page.click('#sourcing-ak-save');
    await expect(page.locator('#sourcing-ak-status')).toContainText('AK 无法解析');
    // 保存失败不改变配置态（清除按钮仍隐藏）
    await expect(page.locator('#sourcing-ak-clear')).toBeHidden();
  });

  test('C. 合法 AK → 已配置 masked + 输入框清空 + 原始串不出现在页面', async () => {
    await page.fill('#sourcing-ak-input', RAW_AK);
    await page.click('#sourcing-ak-save');
    await expect(page.locator('#sourcing-ak-status')).toContainText('已配置 ****9876');
    await expect(page.locator('#sourcing-ak-status')).toContainText('检索走官方 API');
    await expect(page.locator('#sourcing-ak-clear')).toBeVisible();
    // secret 不回显：密码框清空 + 全文无原始串
    await expect(page.locator('#sourcing-ak-input')).toHaveValue('');
    expect(await page.content()).not.toContain(RAW_AK);
    expect(await page.content()).not.toContain('E2EAKID-9876');
  });

  test('E. AK 配置期间 selection 检索面照常（fixture 候选正常渲染）', async () => {
    await page.evaluate(async () => {
      await window.xinglian?.invoke('selection:insertFixture', {
        topic: 'e2e-ak-选品',
        keywords: ['收纳盒——e2e 理由'],
        candidates: [
          {
            offerId: '770000000001',
            keyword: '收纳盒',
            title: '桌面收纳盒塑料抽屉式',
            priceText: '¥2.1',
            salesText: '5.6万+件',
            supplierName: 'e2e-供应商',
            sourceUrl: 'https://detail.1688.com/offer/770000000001.html',
          },
        ],
      });
    });
    // 离开再回来触发 refreshSourcingView（sourcing 导航钩子重载清单）
    await page.click('.nav-item[data-view="dashboard"]');
    await page.click('.nav-item[data-view="sourcing"]');
    await expect(page.locator('#view-sourcing')).toHaveClass(/active/);
    await page.waitForSelector('html[data-sourcing-loaded="1"][data-sourcing-count="1"]', { timeout: 15_000 });
    await expect(page.locator('#sourcing-ak-status')).toContainText('已配置 ****9876');
  });

  test('D. 清除 → 回未配置', async () => {
    await page.click('#sourcing-ak-clear');
    await expect(page.locator('#sourcing-ak-status')).toHaveText('未配置（检索走内置浏览器）');
    await expect(page.locator('#sourcing-ak-clear')).toBeHidden();
  });
});

/**
 * 收藏/询盘执行 e2e（T-M2-04；FR-6.3 勾选 → FR-6.4 确认弹窗红线 → FR-6.5 商品卡片）。
 *
 * 场景（诚实性：XINGLIAN_OUTREACH_FIXTURE=1 内存端口回放页面会话，收藏/询盘/素材/提取
 * 全走生产服务链路——confirm 推送、审计事件、products/materials 落库、渲染层弹窗与卡片；
 * 唯独不碰真站。真实写操作（真点收藏/发询盘）必须用户在场验收，e2e 永不代发）：
 * A. 勾选两候选 → 执行入口出现 → 全确认批次 → 确认弹窗逐 flow 弹出（话术可编辑）→
 *    完成 → 商品卡片列表（2 卡、对接中、打开货源页按钮）；
 * B. 再次执行 → 首个确认点「取消整批」→ 批次取消（cancelled）。
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
// M0 固定测试密钥对（同 license.spec：真实执行入口受 FR-1.6 license 锁，e2e 需解锁态）
const TEST_PRIVATE_PEM = readFileSync(path.join(__dirname, '../../server/keys/license-private.pem'), 'utf8');

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

function signLicenseJwt(exp: number): string {
  const header = { alg: 'EdDSA', typ: 'license', kid: 'm0-license-test-1' };
  const payload = {
    sub: 'e2e-desktop-user', typ: 'license', plan: 'month', tier: 'personal',
    device_limit: 1, device_hash: '', jti: randomUUID(), exp,
  };
  const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
  const signature = edSign(null, Buffer.from(signingInput, 'utf8'), createPrivateKey(TEST_PRIVATE_PEM));
  return `${signingInput}.${enc(signature)}`;
}

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(async ([ch, pl]) => (await window.xinglian?.invoke(ch as string, pl)) as never, [channel, payload]) as Promise<T>;
}

test.describe.serial('收藏/询盘执行（T-M2-04）', () => {
  let userData: string;
  let licenseFile: string;
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-outreach-'));
    // 真实执行入口受 FR-1.6 license 锁：注入有效 license（解锁态）——锁定面由 license.spec 覆盖
    licenseFile = path.join(userData, 'license.json');
    writeFileSync(
      licenseFile,
      JSON.stringify({
        licenseJwt: signLicenseJwt(Math.floor(Date.now() / 1000) + 31 * 24 * 3600),
        lastVerifiedAt: new Date(Date.now() - 3_600_000).toISOString(),
        deviceHash: createHash('sha256').update('e2e').digest('hex'),
      }),
      'utf8',
    );
    electronApp = await _electron.launch({
      executablePath: electronPath,
      args: ['out/main.js'],
      cwd: pkgRoot,
      env: {
        ...process.env,
        XINGLIAN_USER_DATA: userData,
        XINGLIAN_LICENSE_FILE: licenseFile,
        XINGLIAN_DEBUG_HOOKS: '1',
        XINGLIAN_REPORT_STEP: 'off',
        XINGLIAN_OUTREACH_FIXTURE: '1',
      },
    });
    page = await electronApp.firstWindow();
    await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
    await ensureEulaAccepted(page);
    await invoke(page, 'selection:insertFixture', {
      topic: 'e2e-outreach-选品',
      keywords: ['防晒帽——e2e 理由'],
      candidates: [
        {
          offerId: '880000000001',
          keyword: '防晒帽',
          title: '冰丝防晒帽女夏季UPF50+渔夫帽大头围',
          priceText: '¥3.5',
          salesText: '3.4万+件',
          supplierName: '台州市椒江顺新鞋帽厂',
          sourceUrl: 'https://detail.1688.com/offer/880000000001.html',
        },
        {
          offerId: '880000000002',
          keyword: '防晒帽',
          title: '防晒帽男透气薄款空顶帽户外遮阳',
          priceText: '¥2.8',
          salesText: '1.0万+件',
          supplierName: '义乌市沐原服装有限公司',
          sourceUrl: 'https://detail.1688.com/offer/880000000002.html',
        },
      ],
    });
    await page.click('.nav-item[data-view="sourcing"]');
    await expect(page.locator('#view-sourcing')).toHaveClass(/active/);
    await page.waitForSelector('html[data-sourcing-loaded="1"][data-sourcing-count="2"]', { timeout: 15_000 });
  });

  test.afterAll(async () => {
    await electronApp.close();
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      // tmp 目录残留无妨
    }
  });

  /** 等确认弹窗出现并按指定按钮收口（每候选×每 flow 一次，FR-6.4 永远人工） */
  async function answerConfirm(action: 'confirm' | 'skip' | 'cancel'): Promise<void> {
    await page.waitForSelector('#outreach-confirm-dialog:not([hidden])', { timeout: 20_000 });
    await expect(page.locator('html')).toHaveAttribute('data-outreach', 'awaiting-confirm');
    await page.click(`#outreach-confirm-${action === 'confirm' ? 'yes' : action}`);
    await page.waitForSelector('#outreach-confirm-dialog', { state: 'hidden', timeout: 20_000 });
  }

  test('A. 勾选 → 全确认批次 → 确认弹窗逐 flow → 商品卡片入库（FR-6.3/6.4/6.5）', async () => {
    /* 勾选两候选（真实 selection:setChecked 链路） */
    await page.locator('tr[data-offer-id="880000000001"] input.sourcing-check').check();
    await page.locator('tr[data-offer-id="880000000002"] input.sourcing-check').check();
    await expect(page.locator('html')).toHaveAttribute('data-sourcing-checked', '2');
    await expect(page.locator('#sourcing-outreach-run')).toBeVisible();
    await expect(page.locator('#sourcing-outreach-count')).toHaveText('2');

    /* 起跑：4 次确认弹窗（2 候选 × 收藏+询盘；永远人工，无自动确认） */
    await page.click('#sourcing-outreach-run');
    await answerConfirm('confirm'); // offer1 favorite
    // offer1 询盘弹窗：话术预填（FR-6.4 三要素）+ 可编辑
    await page.waitForSelector('#outreach-confirm-dialog:not([hidden])', { timeout: 20_000 });
    await expect(page.locator('#outreach-confirm-msg-label')).toBeVisible();
    const message = await page.locator('#outreach-confirm-msg').inputValue();
    expect(message).toContain('一件代发');
    expect(message).toContain('社交平台');
    await answerConfirm('confirm'); // offer1 inquiry
    await answerConfirm('confirm'); // offer2 favorite
    await answerConfirm('confirm'); // offer2 inquiry

    await expect(page.locator('html')).toHaveAttribute('data-outreach', 'completed', { timeout: 30_000 });

    /* 商品卡片（FR-6.5）：2 卡入库、询盘发出 → 对接中、含原始链接打开按钮 */
    await page.waitForSelector('html[data-products-count="2"]', { timeout: 15_000 });
    await expect(page.locator('.product-card')).toHaveCount(2);
    await expect(page.locator('.product-card[data-product-id="880000000001"]')).toHaveAttribute('data-status', '对接中');
    await expect(page.locator('.product-card[data-product-id="880000000002"]')).toHaveAttribute('data-status', '对接中');
    await expect(page.locator('.product-card .product-card-title').first()).toContainText('防晒帽');
    await expect(page.locator('.product-open-source')).toHaveCount(2);
    await expect(page.locator('.product-card .product-card-desc').first()).toContainText('fixture 商品详情');
  });

  test('B. 再次执行 → 取消整批（FR-6.4 红线：任意确认点可中止）', async () => {
    await page.click('#sourcing-outreach-run');
    await answerConfirm('cancel');
    await expect(page.locator('html')).toHaveAttribute('data-outreach', 'cancelled', { timeout: 30_000 });
    /* 取消不新增商品卡片（首批已入库的仍在） */
    await expect(page.locator('html')).toHaveAttribute('data-products-count', '2');
  });
});

/**
 * 工作流转场 e2e（T-M2-06；FR-7.1 已对接判定 → FR-7.2 进入发布携带上下文 → FR-7.3 看板 v1）。
 *
 * 场景（诚实性：XINGLIAN_OUTREACH_FIXTURE=1 回放页面会话，转场全走生产服务链路——
 * 转场矩阵、PRODUCT_ENTER_PUBLISH 审计、products/status 落库、渲染层卡片与看板；
 * 唯独不碰真站。同时兼 M2 门禁「标记已对接 → 进入发布」转场演示路径）：
 * A. outreach fixture 批次 → 2 卡对接中 → 标记已对接（FR-7.1）→「进入发布」出现并点击
 *    （FR-7.2）→ 待发布 + 上下文摘要行；IPC 级非法迁移被矩阵拒绝（E-PRODUCT-TRANSITION-INVALID）；
 * B. 工作台看板四列分列正确；拖拽流转（待发布→推广中→已完成）+ 非法拖拽诚实回显。
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

test.describe.serial('工作流转场 + 看板（T-M2-06）', () => {
  let userData: string;
  let licenseFile: string;
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-workflow-board-'));
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
      topic: 'e2e-board-选品',
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

    /* outreach fixture 批次：勾选 2 候选 → 全确认（4 弹窗）→ 2 卡对接中 */
    await page.locator('tr[data-offer-id="880000000001"] input.sourcing-check').check();
    await page.locator('tr[data-offer-id="880000000002"] input.sourcing-check').check();
    await page.click('#sourcing-outreach-run');
    for (let i = 0; i < 4; i += 1) {
      await page.waitForSelector('#outreach-confirm-dialog:not([hidden])', { timeout: 20_000 });
      await page.click('#outreach-confirm-yes');
      await page.waitForSelector('#outreach-confirm-dialog', { state: 'hidden', timeout: 20_000 });
    }
    await expect(page.locator('html')).toHaveAttribute('data-outreach', 'completed', { timeout: 30_000 });
    await page.waitForSelector('html[data-products-count="2"]', { timeout: 15_000 });
  });

  test.afterAll(async () => {
    await electronApp.close();
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      // tmp 目录残留无妨
    }
  });

  test('A. 标记已对接（FR-7.1）→ 进入发布携带上下文（FR-7.2）→ 非法迁移被矩阵拒绝', async () => {
    const card = page.locator('.product-card[data-product-id="880000000001"]');
    await expect(card).toHaveAttribute('data-status', '对接中');
    await expect(card.locator('.product-enter-publish')).toHaveCount(0);

    /* FR-7.1：手动标记已对接 → 「进入发布」按钮出现 */
    await card.locator('.product-mark-connected').click();
    await expect(page.locator('html')).toHaveAttribute('data-product-status-action', 'done', { timeout: 15_000 });
    await expect(page.locator('.product-card[data-product-id="880000000001"]')).toHaveAttribute('data-status', '已对接');
    await expect(page.locator('.product-card[data-product-id="880000000001"] .product-enter-publish')).toBeVisible();

    /* FR-7.2：一键转场 → 待发布 + 上下文摘要（素材/报告/供应商；fixture reportId=0 → 不展示报告） */
    await page.locator('.product-card[data-product-id="880000000001"] .product-enter-publish').click();
    await expect(page.locator('html')).toHaveAttribute('data-product-enter-publish', 'done', { timeout: 15_000 });
    await expect(page.locator('html')).toHaveAttribute('data-product-published', '880000000001');
    const published = page.locator('.product-card[data-product-id="880000000001"]');
    await expect(published).toHaveAttribute('data-status', '待发布');
    await expect(published.locator('.product-card-handoff')).toContainText('进入发布');
    await expect(published.locator('.product-card-handoff')).toContainText('素材 2 张');
    await expect(published.locator('.product-card-handoff')).toContainText(/供应商 .+/);
    await expect(page.locator('#sourcing-status')).toContainText('已进入发布清单');
    await expect(page.locator('#sourcing-status')).toContainText('e2e-board-选品');

    /* 矩阵拒绝：待发布 → 候选 不允许（→待发布 唯一入口 enterPublish；跨阶段回退受限） */
    await expect(
      invoke(page, 'products:setStatus', { productId: '880000000001', status: '候选' }),
    ).rejects.toThrow(/E-PRODUCT-TRANSITION-INVALID/);
    /* 二号卡仍是对接中：直接 enterPublish 前置态不满足 → NOT-CONNECTED（须先标记已对接） */
    await expect(invoke(page, 'products:enterPublish', { productId: '880000000002' })).rejects.toThrow(/E-PRODUCT-NOT-CONNECTED/);
  });

  test('B. 看板 v1：四列分列 + 拖拽流转（FR-7.3）+ 非法拖拽诚实回显', async () => {
    await page.click('.nav-item[data-view="dashboard"]');
    await expect(page.locator('#view-dashboard')).toHaveClass(/active/);
    await page.waitForSelector('html[data-board-loaded="1"][data-board-total="2"]', { timeout: 15_000 });
    await expect(page.locator('.kanban .col[data-stage="选品中"]')).toHaveAttribute('data-count', '1');
    await expect(page.locator('.kanban .col[data-stage="待发布"]')).toHaveAttribute('data-count', '1');
    await expect(page.locator('.kanban .col[data-stage="待发布"] .kcard[data-product-id="880000000001"]')).toBeVisible();

    /** HTML5 DnD（Chromium DataTransfer 事件派发：dragstart → dragover → drop → dragend） */
    async function drag(productId: string, targetStage: string): Promise<void> {
      await page.evaluate(([pid, stage]) => {
        const card = document.querySelector(`.kcard[data-product-id="${pid}"]`);
        const col = document.querySelector(`.kanban .col[data-stage="${stage}"]`);
        if (!card || !col) throw new Error(`drag target missing: ${pid} → ${stage}`);
        const dt = new DataTransfer();
        card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      }, [productId, targetStage]);
      await expect(page.locator('html')).toHaveAttribute('data-board-move', /done|failed/, { timeout: 15_000 });
    }

    /* 待发布 → 推广中（手动推进，M2 无自动生产者） */
    await drag('880000000001', '推广中');
    await expect(page.locator('html')).toHaveAttribute('data-board-move', 'done');
    await expect(page.locator('.kanban .col[data-stage="推广中"]')).toHaveAttribute('data-count', '1');
    await expect(page.locator('.kanban .col[data-stage="待发布"]')).toHaveAttribute('data-count', '0');

    /* 推广中 → 已完成 */
    await drag('880000000001', '已完成');
    await expect(page.locator('html')).toHaveAttribute('data-board-move', 'done');
    await expect(page.locator('.kanban .col[data-stage="已完成"] .kcard[data-product-id="880000000001"]')).toBeVisible();

    /* 非法拖拽：已完成 → 选品中（矩阵无通路）——主进程拒绝并如实回显，不静默 */
    await drag('880000000001', '选品中');
    await expect(page.locator('html')).toHaveAttribute('data-board-move', 'failed');
    await expect(page.locator('html')).toHaveAttribute('data-board-move-error', /E-PRODUCT-TRANSITION-INVALID/);
    await expect(page.locator('.kanban .col[data-stage="已完成"]')).toHaveAttribute('data-count', '1');

    /* 撤回通路仍在：已完成 → 推广中（回退纠正） */
    await drag('880000000001', '推广中');
    await expect(page.locator('html')).toHaveAttribute('data-board-move', 'done');
  });
});

/**
 * M2 门禁评审材料：FR-6.4 确认弹窗在场截图（fixture 内存会话版）。
 *
 * 为什么不是真实库：真实链路下确认弹窗在受控浏览器会话建立后按 flow 推出，
 * 未接管态 outreach:start 直接 E-OUTREACH-BROWSER-DETACHED（且会自动开真窗口）——
 * 「弹窗在场但零写」只有 fixture 会话（XINGLIAN_OUTREACH_FIXTURE=1 内存回放）能达成。
 *
 * 诚实口径（同 outreach.spec）：内存端口回放页面会话，confirm 推送、审计事件、
 * 渲染层弹窗全为生产链路——唯独不碰真站；收藏 flow=skip、整批=cancel，
 * **全程零收藏/询盘写操作（红线：绝不代用户发送）**；真实发送验收轮须用户在场。
 * 本 spec 不产出「评审通过」结论——判定仍归用户。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, createPrivateKey, randomUUID, sign as edSign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;
// M0 固定测试密钥对（同 outreach.spec：执行入口受 FR-1.6 license 锁，e2e 需解锁态）
const TEST_PRIVATE_PEM = readFileSync(path.join(__dirname, '../../server/keys/license-private.pem'), 'utf8');

const repoRoot = path.resolve(pkgRoot, '..', '..');
const outDir = path.join(repoRoot, '.omo', 'evidence', 'm2-gate', 'review-captures');

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

const manifest: {
  startedAt: string;
  finishedAt?: string;
  shots: Array<{ name: string; file: string }>;
  assertions: Record<string, string | number | boolean | null>;
  notes: string[];
} = { startedAt: new Date().toISOString(), shots: [], assertions: {}, notes: [] };

async function shot(page: Page, name: string, locator?: string): Promise<void> {
  const file = path.join(outDir, `${name}.png`);
  const target = locator ? page.locator(locator) : page;
  await target.screenshot({ path: file });
  manifest.shots.push({ name, file: `${name}.png` });
  console.log(`[capture-m2-fixture] ${name}`);
}

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(async ([ch, pl]) => (await window.xinglian?.invoke(ch as string, pl)) as never, [channel, payload]) as Promise<T>;
}

test.skip(!process.env.XINGLIAN_REVIEW_CAPTURE_M2, 'M2 评审材料捕获专用：需显式 XINGLIAN_REVIEW_CAPTURE_M2=1');

test.describe.serial('M2 弹窗取证（fixture 内存会话，零写）', () => {
  let userData: string;
  let licenseFile: string;
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    mkdirSync(outDir, { recursive: true });
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-m2capture-'));
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
      topic: 'm2-gate-capture-选品',
      keywords: ['防晒帽——门禁取证'],
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
    manifest.finishedAt = new Date().toISOString();
    writeFileSync(path.join(outDir, 'manifest-fixture.json'), JSON.stringify(manifest, null, 1));
    console.log('[capture-m2-fixture] manifest 写入完成');
  });

  test('确认弹窗在场取证（收藏 flow=skip → 询盘话术截屏断言 → 取消整批）', async () => {
    await page.locator('tr[data-offer-id="880000000001"] input.sourcing-check').check();
    await page.locator('tr[data-offer-id="880000000002"] input.sourcing-check').check();
    await expect(page.locator('html')).toHaveAttribute('data-sourcing-checked', '2');
    await page.click('#sourcing-outreach-run');

    /* 弹窗 1 = 候选 1 收藏确认：截屏（含候选与 flow 标识），绝不点确认 */
    await page.waitForSelector('#outreach-confirm-dialog:not([hidden])', { timeout: 30_000 });
    await expect(page.locator('html')).toHaveAttribute('data-outreach', 'awaiting-confirm');
    await shot(page, '02a-confirm-dialog-favorite', '#outreach-confirm-dialog');
    await page.click('#outreach-confirm-skip');

    /* 弹窗 2 = 候选 1 询盘确认：话术三要素断言（FR-6.4）+ 全屏截图 */
    await page.waitForSelector('#outreach-confirm-dialog:not([hidden])', { timeout: 30_000 });
    const message = await page.locator('#outreach-confirm-msg').inputValue();
    manifest.assertions.inquiryMsgEditable = String(await page.locator('#outreach-confirm-msg').isEnabled());
    manifest.assertions.inquiryMsgHasYijianDaifa = String(message.includes('一件代发'));
    manifest.assertions.inquiryMsgHasShejiao = String(message.includes('社交平台'));
    expect(message).toContain('一件代发');
    expect(message).toContain('社交平台');
    await shot(page, '02b-confirm-dialog-inquiry');

    /* 取消整批收口（FR-6.4 红线：任意确认点可中止） */
    await page.click('#outreach-confirm-cancel');
    await expect(page.locator('html')).toHaveAttribute('data-outreach', 'cancelled', { timeout: 30_000 });
    manifest.assertions.batchCancelled = 'cancelled';
    manifest.notes.push('弹窗为 fixture 内存会话回放（零外呼零写）；收藏 flow=skip、整批=cancel——全程无收藏/询盘写操作');
    manifest.notes.push('真实发送与会话窗位点校准 = 用户在场验收轮（M2 门禁 PENDING(user) 项）');
  });
});

/**
 * 偏好画像 e2e（05 T-M2-07；FR-6.7 偏好回流 v1——兼 M2 门禁「偏好回流」演示）。
 *
 * 场景（诚实性：候选数据经 debug 门控的 selection:insertFixture 注入真实 store；
 * 勾选/淘汰 → preferences 流水 → 画像派生 → 综合分乘性微调全是生产链路；
 * 不依赖浏览器与 1688 登录态）：
 * A. 淘汰写面 + 勾选互斥：先勾选再淘汰 → 勾选集自动移出（kv + 渲染双面）；
 * B. 画像形成与回流：3 勾选（高相关）+ 5 淘汰（低相关）→ config preference 块
 *    （adopted/dismissed/dimBias/effectiveWeights）+ UI 摘要注记 + 综合分按 effective 重算；
 * C. 开关：关闭 → effective 回落用户显式权重（画像派生不受影响）→ 重开恢复。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;

const DIMENSION_IDS = ['relevance', 'price', 'sales', 'supplier', 'gallery', 'repurchase'] as const;

function dims(scores: Record<(typeof DIMENSION_IDS)[number], number>): Array<{ name: string; title: string; score: number; weight: number; reason: string }> {
  const titles: Record<string, string> = { relevance: '关键词相关性', price: '价格竞争力', sales: '销量信号', supplier: '供应商资质', gallery: '素材完备度', repurchase: '复购信号' };
  return DIMENSION_IDS.map((name) => ({ name, title: titles[name], score: scores[name], weight: 0, reason: `e2e 理由-${name}` }));
}

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(async ([ch, pl]) => (await window.xinglian?.invoke(ch as string, pl)) as never, [channel, payload]) as Promise<T>;
}

interface PreferenceInfo {
  enabled: boolean;
  adopted: number;
  dismissed: number;
  sampleInsufficient: boolean;
  dimBias: Record<string, number>;
  effectiveWeights: Record<string, number>;
}

test.describe.serial('偏好画像（05 T-M2-07）', () => {
  let userData: string;
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-sourcing-pref-'));
    electronApp = await _electron.launch({
      executablePath: electronPath,
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
    // 播种 8 条：900~902 高相关（勾选组）、903~907 低相关（淘汰组）；其余维两组同分 50
    // ——只有 relevance 产生组均值差（dimBias.relevance = +0.5），断言可预测
    const candidates = [
      ...[900, 901, 902].map((offerId) => ({
        offerId: String(offerId),
        keyword: '防晒帽',
        title: `防晒帽 高相关 ${offerId}`,
        dimensions: dims({ relevance: 100, price: 50, sales: 50, supplier: 50, gallery: 50, repurchase: 50 }),
      })),
      ...[903, 904, 905, 906, 907].map((offerId) => ({
        offerId: String(offerId),
        keyword: '防晒帽',
        title: `防晒帽 低相关 ${offerId}`,
        dimensions: dims({ relevance: 0, price: 50, sales: 50, supplier: 50, gallery: 50, repurchase: 50 }),
      })),
    ];
    await invoke(page, 'selection:insertFixture', { topic: 'e2e-偏好画像', keywords: ['防晒帽——e2e 理由'], candidates });
    await page.click('.nav-item[data-view="sourcing"]');
    await expect(page.locator('#view-sourcing')).toHaveClass(/active/);
    await page.waitForSelector('html[data-sourcing-loaded="1"][data-sourcing-count="8"]', { timeout: 15_000 });
  });

  test.afterAll(async () => {
    await electronApp.close();
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      // tmp 目录残留无妨
    }
  });

  test('A. 淘汰写面 + 勾选互斥（先勾选再淘汰 → 勾选集自动移出）', async () => {
    // 先勾选 903（kv + 渲染 checked 集），再淘汰 → 双面互斥
    await page.locator('.sourcing-check[data-offer-id="903"]').check();
    await expect(page.locator('html[data-sourcing-checked="1"]')).toBeAttached();
    await page.locator('.sourcing-dismiss-btn[data-offer-id="903"]').click();
    await expect(page.locator('tr[data-offer-id="903"][data-dismissed="true"]')).toBeVisible();
    await expect(page.locator('html[data-sourcing-checked="0"]')).toBeAttached();
    await expect(page.locator('html[data-sourcing-dismissed="1"]')).toBeAttached();
    // 勾选框状态同步为未勾选（互斥镜像）
    await expect(page.locator('.sourcing-check[data-offer-id="903"]')).not.toBeChecked();

    // 其余 4 条低相关直接淘汰（对照组凑 5）
    for (const offerId of ['904', '905', '906', '907']) {
      await page.locator(`.sourcing-dismiss-btn[data-offer-id="${offerId}"]`).click();
    }
    await expect(page.locator('html[data-sourcing-dismissed="5"]')).toBeAttached();
    for (const offerId of ['904', '905', '906', '907']) {
      await expect(page.locator(`tr[data-offer-id="${offerId}"][data-dismissed="true"]`)).toBeVisible();
    }
  });

  test('B. 画像形成 → config preference 块 + UI 注记 + 综合分乘性微调', async () => {
    // 勾选 3 条高相关（生产链路：selection:setChecked → outreach 埋点）
    for (const offerId of ['900', '901', '902']) {
      await page.locator(`.sourcing-check[data-offer-id="${offerId}"]`).check();
    }
    await expect(page.locator('html[data-sourcing-checked="3"]')).toBeAttached();

    const config = await invoke<{ preference: PreferenceInfo }>(page, 'selection:config', {});
    expect(config.preference.adopted).toBe(3);
    expect(config.preference.dismissed).toBe(5);
    expect(config.preference.sampleInsufficient).toBe(false);
    expect(config.preference.dimBias.relevance).toBeCloseTo(0.5, 5);
    expect(config.preference.effectiveWeights.relevance).toBe(38); // 25×1.5 → 38
    expect(config.preference.effectiveWeights.price).toBe(15); // 其余维组间同分 → bias 0

    // UI 注记刷新（config 只在视图刷新/权重操作/开关时重读——切走再切回）
    await page.click('.nav-item[data-view="insight"]');
    await page.click('.nav-item[data-view="sourcing"]');
    await expect(page.locator('#sourcing-preference-note')).toContainText('已按 3 勾选 / 5 淘汰');

    // 综合分按 effectiveWeights 重算：900 = (100×38 + 50×75)/113 = 66.8 → 67；903 = 33
    await expect(page.locator('tr[data-offer-id="900"] td.sourcing-total')).toHaveText('67');
    await expect(page.locator('tr[data-offer-id="903"] td.sourcing-total')).toHaveText('33');
  });

  test('C. 开关关闭 → effective 回落用户权重；重开恢复微调', async () => {
    await page.locator('#sourcing-preference-toggle').uncheck();
    await expect(page.locator('html[data-sourcing-preference="off"]')).toBeAttached();
    await expect(page.locator('#sourcing-preference-note')).toContainText('偏好回流已关闭');
    // 回落用户显式权重：900 = (100×25 + 50×75)/100 = 62.5 → 63
    await expect(page.locator('tr[data-offer-id="900"] td.sourcing-total')).toHaveText('63');

    // 画像派生不受开关影响（bias 仍在，只是不融合）
    const config = await invoke<{ preference: PreferenceInfo }>(page, 'selection:config', {});
    expect(config.preference.enabled).toBe(false);
    expect(config.preference.dimBias.relevance).toBeCloseTo(0.5, 5);
    expect(config.preference.effectiveWeights.relevance).toBe(25);

    await page.locator('#sourcing-preference-toggle').check();
    await expect(page.locator('html[data-sourcing-preference="on"]')).toBeAttached();
    await expect(page.locator('tr[data-offer-id="900"] td.sourcing-total')).toHaveText('67');
  });
});

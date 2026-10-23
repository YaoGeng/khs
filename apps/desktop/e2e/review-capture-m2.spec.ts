/**
 * M2 门禁评审会材料自动捕获（agent 备材料部分，照 M1 review-capture.spec.ts 口径）。
 *
 * ⚠️ 本 spec 使用真实库（不设 XINGLIAN_USER_DATA → AppData/Roaming/Electron 真实
 * pilot 数据）。默认永久 skip，仅显式 `XINGLIAN_REVIEW_CAPTURE_M2=1` 时运行，
 * 绝不混入常规 e2e。
 *
 * 诚实口径与红线：
 * - 生产链路（无 DEBUG_HOOKS/无 fixture）——候选表、商品卡片、看板、偏好注记全为真实数据。
 * - **确认弹窗取证不在本 spec**：真实库下浏览器未接管时 outreach:start 走
 *   E-OUTREACH-BROWSER-DETACHED（还会自动开真浏览器窗口），弹窗只在会话建立后推出——
 *   弹窗截图由 review-capture-m2-fixture.spec.ts 以内存会话（零外呼零写）承担；
 *   真实发送验收轮仍须用户在场（红线：绝不代用户发送）。
 * - 簿记转场演示（标记已对接→进入发布→看板）为 agent 驱动（材料生成用途），
 *   演示后按合法矩阵撤回恢复原状；审计流水如实留痕（manifest 标注）。
 * - 本 spec 不产出「评审通过」结论——判定仍归用户。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;

const repoRoot = path.resolve(pkgRoot, '..', '..');
const outDir = path.join(repoRoot, '.omo', 'evidence', 'm2-gate', 'review-captures');

/** 真实库既有商品（2026-10-18 首次真实执行批次 a4f0d6fd 落库，状态=候选）；OFFER_B=1057709482335 仅注记 */
const OFFER_A = '1057816460601';

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
  console.log(`[capture-m2] ${name}`);
}

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(async ([ch, pl]) => (await window.xinglian?.invoke(ch as string, pl)) as never, [channel, payload]) as Promise<T>;
}

test.skip(!process.env.XINGLIAN_REVIEW_CAPTURE_M2, 'M2 评审材料捕获专用：需显式 XINGLIAN_REVIEW_CAPTURE_M2=1（真实库）');

test.describe.serial('M2 门禁评审材料捕获（真实链路，零对外写操作）', () => {
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    mkdirSync(outDir, { recursive: true });
    // 无 XINGLIAN_USER_DATA / DEBUG_HOOKS / fixture → 真实库 + 生产链路
    electronApp = await _electron.launch({ executablePath: electronPath, args: ['out/main.js'], cwd: pkgRoot });
    page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1366, height: 850 }); // 固定视口：真机 DPI/窗口态差异会让整页截图布局失真
    await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30000 });
  });

  test.afterAll(async () => {
    await electronApp.close();
    manifest.finishedAt = new Date().toISOString();
    writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
    console.log('[capture-m2] manifest 写入完成');
    console.log(JSON.stringify({ assertions: manifest.assertions, shots: manifest.shots.length }));
  });

  test('M2-S1 判据①：pilot-5 真实候选表（Top30 + 六维 chips + 理由）', async () => {
    await page.click('.nav-item[data-view="sourcing"]');
    await page.waitForSelector('html[data-sourcing-loaded="1"]', { timeout: 20000 });
    /* 环境探针：CSS 应用性排查（一次性取证） */
    const env = await page.evaluate(() => ({
      sheets: document.styleSheets.length,
      links: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => ({
        href: l.getAttribute('href'),
        loaded: Boolean((l as HTMLLinkElement).sheet),
      })),
      inner: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio,
    }));
    manifest.assertions.cssEnv = JSON.stringify(env);
    console.log('[capture-m2] cssEnv:', JSON.stringify(env));
    const count = await page.getAttribute('html', 'data-sourcing-count');
    manifest.assertions.sourcingCandidates = count;
    expect(Number(count)).toBe(30); // pilot-5（f627c686）Top30 全量在场

    /* 六维理由 tooltip（td.sourcing-dims title 属性）——分值与理由真实在场 */
    const reasons = (await page.locator('td.sourcing-dims').first().getAttribute('title')) ?? '';
    manifest.assertions.dimReasonsSample = reasons.slice(0, 300);
    expect(reasons).toContain('关键词相关性');
    expect(reasons).toContain('：'); // 每维「标题 分值：理由」格式
    await shot(page, '01-sourcing-candidates-top30', '#view-sourcing');
  });

  test('M2-S2 判据②卡片面：真实商品卡片网格（含原始链接打开按钮）', async () => {
    await page.waitForSelector('html[data-products-count="2"]', { timeout: 15000 });
    await expect(page.locator('.product-card')).toHaveCount(2);
    await expect(page.locator('.product-card .product-open-source')).toHaveCount(2);
    await expect(page.locator(`.product-card[data-product-id="${OFFER_A}"]`)).toHaveAttribute('data-status', '候选');
    manifest.assertions.productCards = 2;
    manifest.assertions.cardLinkButtons = 2;
    await shot(page, '04-product-cards', '#view-sourcing');
  });

  test('M2-S3 判据④转场演示（agent 驱动，演示后恢复原状）：标记已对接 → 进入发布 → 看板 → 撤回', async () => {
    const card = page.locator(`.product-card[data-product-id="${OFFER_A}"]`);
    await card.locator('.product-mark-connected').click();
    await expect(page.locator('html')).toHaveAttribute('data-product-status-action', 'done', { timeout: 20000 });
    await expect(card).toHaveAttribute('data-status', '已对接');
    await shot(page, '05-mark-connected', `.product-card[data-product-id="${OFFER_A}"]`);

    await card.locator('.product-enter-publish').click();
    await expect(page.locator('html')).toHaveAttribute('data-product-enter-publish', 'done', { timeout: 20000 });
    await expect(card).toHaveAttribute('data-status', '待发布');
    const handoff = await card.locator('.product-card-handoff').innerText();
    manifest.assertions.handoffSummary = handoff.replace(/\s+/g, ' ').slice(0, 200);
    expect(handoff).toContain('进入发布');
    expect(handoff).toContain('供应商');
    await shot(page, '06-enter-publish-handoff', `.product-card[data-product-id="${OFFER_A}"]`);

    /* 看板待发布列在场 */
    await page.click('.nav-item[data-view="dashboard"]');
    await page.waitForSelector('html[data-board-loaded="1"][data-board-total="2"]', { timeout: 20000 });
    await expect(page.locator('.kanban .col[data-stage="待发布"]')).toHaveAttribute('data-count', '1');
    await expect(page.locator(`.kanban .col[data-stage="待发布"] .kcard[data-product-id="${OFFER_A}"]`)).toBeVisible();
    await shot(page, '07-kanban-pending-publish', '.kanban');

    /* 恢复原状：待发布→已对接→候选（合法矩阵路径；审计流水如实留痕）。
       注：sourcing 商品卡 UI 只在转场按钮路径刷新，裸 setStatus 后 UI 停留旧态——
       恢复断言走数据面（products:list）；该渲染层刷新缺口如实记档（遗留）。 */
    await invoke(page, 'products:setStatus', { productId: OFFER_A, status: '已对接' });
    await invoke(page, 'products:setStatus', { productId: OFFER_A, status: '候选' });
    const list = await invoke<{ products: Array<{ productId: string; status: string }> }>(page, 'products:list', {});
    const restored = list.products.find((p) => p.productId === OFFER_A);
    manifest.assertions.restoredStatus = restored?.status ?? null;
    manifest.notes.push('渲染层缺口记档：products:setStatus 裸调用（非转场按钮路径）后 sourcing 商品卡不自动刷新——看板拖拽/按钮路径有各自刷新，仅影响绕行调用观感，数据面无虞');
    expect(restored?.status).toBe('候选');
    manifest.assertions.restoredVia = 'products:list 数据面';
    manifest.notes.push('S4 转场为 agent 驱动演示（材料生成用途），演示后已恢复「候选」原状；审计流水留 PRODUCT_ENTER_PUBLISH + setStatus 记录');
  });

  test('M2-S4 偏好回流诚实态：真实库样本不足 → 如实注记（宁缺勿臆造）', async () => {
    await page.click('.nav-item[data-view="sourcing"]');
    await page.waitForSelector('html[data-sourcing-loaded="1"]', { timeout: 20000 });
    const config = await invoke<{ preference: { adopted: number; dismissed: number; sampleInsufficient: boolean } }>(page, 'selection:config', {});
    manifest.assertions.preferenceAdopted = config.preference.adopted;
    manifest.assertions.preferenceDismissed = config.preference.dismissed;
    manifest.assertions.sampleInsufficient = config.preference.sampleInsufficient;
    expect(config.preference.sampleInsufficient).toBe(true);
    const note = await page.locator('#sourcing-preference-note').innerText();
    manifest.assertions.preferenceNote = note;
    expect(note).toContain('样本不足');
    await shot(page, '08-preference-sample-insufficient', '#view-sourcing');
  });
});

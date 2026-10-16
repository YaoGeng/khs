/**
 * 候选清单 UI e2e（05 T-M2-03；FR-6.2 权重可调 / FR-6.3 排序·筛选·置顶）。
 *
 * 场景（诚实性：候选数据经 debug 门控的 selection:insertFixture 注入真实 store，
 * 权重重算/排序/筛选/置顶/持久化全是生产渲染链路；不依赖浏览器与 1688 登录态）：
 * A. 任务卡 + 对比表格：默认权重下综合分降序（76/60/44）+ 五维 chips + 维度理由 tooltip；
 * B. 权重重算：滑杆调 relevance=100 其余 0 → 应用 → 顺序与综合分按新权重重排；
 * C. 筛选：关键词下拉收敛 + 标题/供应商模糊过滤；
 * D. 置顶：末位候选置顶 → 恒居首，且离开视图再回来仍置顶（kv 持久化）；
 * E. 排序方向切换：升序颠倒。
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

const DIMENSION_IDS = ['relevance', 'price', 'sales', 'supplier', 'gallery'] as const;

/** 显式五维分（e2e 排序可控性的前提；缺省会生成难预测的确定性分） */
function dims(scores: Record<(typeof DIMENSION_IDS)[number], number>): Array<{ name: string; title: string; score: number; weight: number; reason: string }> {
  const titles: Record<string, string> = { relevance: '关键词相关性', price: '价格竞争力', sales: '销量信号', supplier: '供应商资质', gallery: '素材完备度' };
  return DIMENSION_IDS.map((name) => ({ name, title: titles[name], score: scores[name], weight: 0, reason: `e2e 理由-${name}` }));
}

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(async ([ch, pl]) => (await window.xinglian?.invoke(ch as string, pl)) as never, [channel, payload]) as Promise<T>;
}

async function offerOrder(page: Page): Promise<string[]> {
  return page.locator('#sourcing-tbody tr[data-offer-id]').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.offerId ?? ''));
}

test.describe.serial('候选清单 UI（05 T-M2-03）', () => {
  let userData: string;
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-sourcing-ui-'));
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
    // 播种：默认权重（30/20/20/15/15）下综合分 222=76 > 333=60 > 111=44（显式维度分）
    await invoke(page, 'selection:insertFixture', {
      topic: 'e2e-防晒帽选品',
      keywords: ['防晒帽——e2e 理由', '空顶帽——e2e 理由'],
      candidates: [
        {
          offerId: '111',
          keyword: '防晒帽',
          title: '防晒帽 UPF50+ 大檐折叠',
          priceText: '12.30~15.00',
          salesText: '最近成交 3000+',
          supplierName: '义乌某帽厂',
          supplierAddress: '浙江 金华',
          sourceUrl: 'https://detail.1688.com/offer/111.html',
          dimensions: dims({ relevance: 100, price: 20, sales: 20, supplier: 20, gallery: 20 }),
        },
        {
          offerId: '222',
          keyword: '防晒帽',
          title: '防晒帽 渔夫帽 双面戴',
          priceText: '8.80',
          salesText: '已售 2万+',
          supplierName: '广州某贸易行',
          dimensions: dims({ relevance: 20, price: 100, sales: 100, supplier: 100, gallery: 100 }),
        },
        {
          offerId: '333',
          keyword: '空顶帽',
          title: '空顶帽 遮阳网球帽',
          priceText: '8.80',
          salesText: '已售 2万+',
          supplierName: '青岛某体育用品厂',
          dimensions: dims({ relevance: 60, price: 60, sales: 60, supplier: 60, gallery: 60 }),
        },
      ],
    });
    await page.click('.nav-item[data-view="sourcing"]');
    await expect(page.locator('#view-sourcing')).toHaveClass(/active/);
    await page.waitForSelector('html[data-sourcing-loaded="1"][data-sourcing-count="3"]', { timeout: 15_000 });
  });

  test.afterAll(async () => {
    await electronApp.close();
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      // tmp 目录残留无妨
    }
  });

  test('A. 任务卡 + 对比表格：默认权重综合分降序 + 五维理由 tooltip', async () => {
    await expect(page.locator('.sourcing-task-card[data-status="completed"] h3')).toHaveText('e2e-防晒帽选品');
    await expect(page.locator('.sourcing-task-card .sourcing-task-meta')).toContainText('候选 3 条');

    /* 默认排序 = 综合分降序：222(76) > 333(60) > 111(44) */
    expect(await offerOrder(page)).toEqual(['222', '333', '111']);
    await expect(page.locator('tr[data-offer-id="222"] td.sourcing-total')).toHaveText('76');
    await expect(page.locator('tr[data-offer-id="333"] td.sourcing-total')).toHaveText('60');
    await expect(page.locator('tr[data-offer-id="111"] td.sourcing-total')).toHaveText('44');

    /* 五维 chips（FR-6.2 可解释面）+ 悬停理由 tooltip */
    await expect(page.locator('tr[data-offer-id="111"] .sourcing-dim-chip[data-dimension="relevance"]')).toHaveText('相关 100');
    const reasons = (await page.locator('tr[data-offer-id="111"] td.sourcing-dims').getAttribute('title')) ?? '';
    expect(reasons).toContain('关键词相关性 100：e2e 理由-relevance');
    expect(reasons).toContain('价格竞争力 20：e2e 理由-price');

    /* 权重面板 = Agent 默认（未自定义） */
    await expect(page.locator('#sourcing-weights-note')).toContainText('Agent 默认权重');
    const relevanceSlider = page.locator('#sourcing-weight-sliders input[data-dimension="relevance"]');
    await expect(relevanceSlider).toHaveValue('30');
  });

  test('B. 权重重算（FR-6.2）：relevance=100 其余 0 → 顺序与综合分重排', async () => {
    for (const id of DIMENSION_IDS) {
      await page.locator(`#sourcing-weight-sliders input[data-dimension="${id}"]`).fill(id === 'relevance' ? '100' : '0');
    }
    await page.click('#sourcing-weights-apply');
    await page.waitForSelector('html[data-sourcing-weights="applied"]', { timeout: 15_000 });

    /* 纯相关度权重：111(100) > 333(60) > 222(20) */
    expect(await offerOrder(page)).toEqual(['111', '333', '222']);
    await expect(page.locator('tr[data-offer-id="111"]')).toHaveAttribute('data-display-total', '100');
    await expect(page.locator('tr[data-offer-id="222"] td.sourcing-total')).toHaveText('20');
    await expect(page.locator('#sourcing-weights-note')).toContainText('已保存自定义权重');
  });

  test('C. 筛选（FR-6.3）：关键词下拉 + 标题/供应商模糊过滤', async () => {
    /* 恢复默认权重，回到 222 > 333 > 111 的稳定基线 */
    await page.click('#sourcing-weights-reset');
    await page.waitForSelector('html[data-sourcing-weights="applied"]', { timeout: 15_000 });

    /* 关键词筛选：防晒帽 → 222/111 两行 */
    await page.selectOption('#sourcing-keyword-filter', '防晒帽');
    await page.waitForSelector('html[data-sourcing-count="2"]', { timeout: 10_000 });
    expect(await offerOrder(page)).toEqual(['222', '111']);

    /* 全部 + 供应商模糊：青岛 → 只剩 333 */
    await page.selectOption('#sourcing-keyword-filter', '');
    await page.fill('#sourcing-search', '青岛');
    await page.waitForSelector('html[data-sourcing-count="1"]', { timeout: 10_000 });
    expect(await offerOrder(page)).toEqual(['333']);

    /* 清空筛选回到三行 */
    await page.fill('#sourcing-search', '');
    await page.waitForSelector('html[data-sourcing-count="3"]', { timeout: 10_000 });
  });

  test('D. 置顶（FR-6.3）：末位候选置顶恒居首 + kv 持久化跨视图', async () => {
    /* 基线末位 = 111；置顶后应居首 */
    await page.locator('tr[data-offer-id="111"] .sourcing-pin-btn').click();
    await page.waitForSelector('html[data-sourcing-pin="done"]', { timeout: 10_000 });
    expect(await offerOrder(page)).toEqual(['111', '222', '333']);
    await expect(page.locator('tr[data-offer-id="111"]')).toHaveAttribute('data-pinned', 'true');

    /* 离开视图再回来：置顶经 kv 持久化仍居首 */
    await page.click('.nav-item[data-view="report"]');
    await page.click('.nav-item[data-view="sourcing"]');
    await page.waitForSelector('html[data-sourcing-loaded="1"][data-sourcing-count="3"]', { timeout: 15_000 });
    expect(await offerOrder(page)).toEqual(['111', '222', '333']);
    await expect(page.locator('tr[data-offer-id="111"]')).toHaveAttribute('data-pinned', 'true');
  });

  test('E. 排序方向：升降序切换颠倒', async () => {
    /* 取消置顶恢复纯排序面 */
    await page.locator('tr[data-offer-id="111"] .sourcing-pin-btn').click();
    await page.waitForSelector('html[data-sourcing-pin="done"]', { timeout: 10_000 });
    expect(await offerOrder(page)).toEqual(['222', '333', '111']);

    await page.click('#sourcing-sort-dir');
    await page.waitForSelector('html[data-sourcing-sort-dir="asc"]', { timeout: 10_000 });
    expect(await offerOrder(page)).toEqual(['111', '333', '222']);

    /* 换排序维度：价格升序 → 8.80 并列按 offerId 稳定定序（222 < 333 < 111@12.30） */
    await page.selectOption('#sourcing-sort', 'price');
    await page.waitForSelector('html[data-sourcing-sort="price"]', { timeout: 10_000 });
    expect(await offerOrder(page)).toEqual(['222', '333', '111']);
  });
});

/**
 * M1 门禁评审会材料自动捕获（人工白名单⑥ 的 agent 备材料部分）。
 *
 * ⚠️ 本 spec 使用真实库（不设 XINGLIAN_USER_DATA → AppData/Roaming/Electron 真实
 * pilot 数据），且会真实点击闸门「确认」并触发真实导出——因此默认永久 skip，
 * 仅在显式 `XINGLIAN_REVIEW_CAPTURE=1` 时运行，绝不混入常规 e2e。
 *
 * 诚实口径：
 * - 生产链路（无 DEBUG_HOOKS/无 fixture/无 REPORT_STEP off）——截图、导出、确认
 *   全是真实行为；闸门确认点击为 agent 驱动（材料生成用途，manifest 如实标注）。
 * - 本 spec 不产出「评审通过」结论——白名单⑥⑦判定仍归用户。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;

const repoRoot = path.resolve(pkgRoot, '..', '..');
const outDir = path.join(repoRoot, '.omo', 'evidence', 'm1-insight-plan', 'review-captures');
const dlDir = path.join(outDir, 'downloads');

const manifest: {
  startedAt: string;
  finishedAt?: string;
  shots: Array<{ name: string; file: string }>;
  downloads: Array<{ kind: string; file: string }>;
  assertions: Record<string, string | number | null>;
  notes: string[];
} = { startedAt: new Date().toISOString(), shots: [], downloads: [], assertions: {}, notes: [] };

async function shot(page: Page, name: string, locator?: string): Promise<void> {
  const file = path.join(outDir, `${name}.png`);
  const target = locator ? page.locator(locator) : page;
  await target.screenshot({ path: file });
  manifest.shots.push({ name, file: `${name}.png` });
  console.log(`[capture] ${name}`);
}

async function waitDownloaded(suffix: string, timeoutMs = 20000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const found = readdirSync(dlDir).find((f) => f.endsWith(suffix));
    if (found) return found;
    if (Date.now() - started > timeoutMs) throw new Error(`下载产物未出现：*${suffix}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test.skip(!process.env.XINGLIAN_REVIEW_CAPTURE, '评审材料捕获专用：需显式 XINGLIAN_REVIEW_CAPTURE=1（真实库 + 真实确认动作）');

test.describe.serial('M1 门禁评审材料捕获（真实链路）', () => {
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    mkdirSync(dlDir, { recursive: true });
    // 无 XINGLIAN_USER_DATA / DEBUG_HOOKS / fixture 注入 → 真实库 + 生产链路
    electronApp = await _electron.launch({ executablePath: electronPath, args: ['out/main.js'], cwd: pkgRoot });
    page = await electronApp.firstWindow();
    await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30000 });
    await electronApp.evaluate(({ session }, dirPath: string) => {
      session.defaultSession.on('will-download', (_event, item) => {
        item.setSavePath(`${dirPath}/${item.getFilename()}`);
      });
    }, dlDir);
  });

  test.afterAll(async () => {
    await electronApp.close();
    manifest.finishedAt = new Date().toISOString();
    writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
    console.log('[capture] manifest 写入完成');
    console.log(JSON.stringify({ assertions: manifest.assertions, downloads: manifest.downloads, shots: manifest.shots.length }));
  });

  test('S1-S2 应用启动 + 真实闸门卡片（awaiting_user keyword_confirm）', async () => {
    await shot(page, '01-app-start');
    manifest.assertions.appMounted = '1';

    await page.click('.nav-item[data-view="insight"]');
    await page.waitForSelector('html[data-gate-loaded="1"]', { timeout: 15000 });
    manifest.assertions.gateCount = await page.getAttribute('html', 'data-gate-count');
    manifest.assertions.gateKinds = await page.getAttribute('html', 'data-gate-kinds');
    await page.waitForSelector('.gate-item[data-gate="keyword_confirm"]', { timeout: 10000 });
    await shot(page, '02-gate-card', '.gate-item');
  });

  test('S3 闸门确认（agent 驱动）→ 卡片消失 → 日志留痕 → 选品占位 queued', async () => {
    await page.click('.gate-item .gate-confirm-btn');
    await page.waitForSelector('html[data-gate-action="done"]', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('html')?.dataset.gateCount === '0', { timeout: 15000 });
    manifest.assertions.gateConfirmed = 'done';
    manifest.notes.push('闸门确认点击由 agent 驱动（材料生成用途）；正式用户流为人工点击');
    await shot(page, '03-gate-confirmed-gone', '#view-insight');

    await page.click('.nav-item[data-view="logs"]');
    await page.selectOption('#logs-category-filter', 'user-action');
    await page.click('#logs-refresh');
    await page.waitForTimeout(800);
    const rows = await page.locator('#logs-tbody tr').allInnerTexts();
    manifest.assertions.gateLogRows = rows.filter((r) => r.includes('gate')).length;
    expect(manifest.assertions.gateLogRows).toBeGreaterThan(0);
    await shot(page, '04-logs-gate-row', '#view-logs');

    await page.click('.nav-item[data-view="sourcing"]');
    await page.waitForSelector('html[data-sourcing-loaded="1"]', { timeout: 15000 });
    manifest.assertions.sourcingCards = await page.locator('.sourcing-task-card').count();
    manifest.assertions.queuedSelectionVisible = String((await page.locator('.sourcing-task-card[data-status="queued"]').count()) > 0);
    await shot(page, '05-sourcing-queued', '#view-sourcing');
  });

  test('S4 最新报告八章节 + 真实导出 MD/PDF/CSV', async () => {
    await page.click('.nav-item[data-view="report"]');
    /* 动态取最新报告（下拉按落库顺序，value = 报告 id）——不写死编号 */
    const latestReportId = await page.locator('#report-select option').evaluateAll((options) => {
      const ids = options.map((o) => Number((o as HTMLOptionElement).value)).filter((n) => Number.isFinite(n));
      return String(Math.max(...ids));
    });
    manifest.assertions.reportId = latestReportId;
    await page.locator(`#report-select option[value="${latestReportId}"]`).waitFor({ state: 'attached', timeout: 15000 });
    await page.selectOption('#report-select', latestReportId);
    await page.waitForSelector('html[data-report-state="rendered"]', { timeout: 30000 });
    manifest.assertions.reportChapters = await page.locator('section.report-chapter').count();
    expect(manifest.assertions.reportChapters).toBe(8);
    await shot(page, '06-report-chapters', '#view-report');

    await page.click('#report-export-md');
    manifest.downloads.push({ kind: 'report-md', file: await waitDownloaded('.md') });
    await page.click('#report-export-pdf');
    manifest.downloads.push({ kind: 'report-pdf', file: await waitDownloaded('.pdf') });

    await page.click('.nav-item[data-view="insight"]');
    await page.waitForSelector('html[data-notes-loaded="1"]', { timeout: 15000 });
    await page.click('#notes-export-csv');
    manifest.downloads.push({ kind: 'notes-csv', file: await waitDownloaded('.csv') });
    await shot(page, '07-notes-csv', '#view-insight');
    expect(manifest.downloads).toHaveLength(3);
  });

  test('S6 FR-2.7 三要素 + 调用前确认 modal（截图后取消，零外呼）', async () => {
    await page.click('.nav-item[data-view="settings"]');
    await page.waitForSelector('html[data-key-masked-loaded="1"]', { timeout: 15000 });
    await shot(page, '08-settings-fr27', '#view-settings');

    await page.click('#key-precall-reset-btn');
    await page.waitForTimeout(500);
    await page.click('#key-test-btn');
    await page.waitForSelector('#precall-modal:not([hidden])', { timeout: 10000 });
    await shot(page, '09-precall-modal', '#precall-modal');
    await page.click('#precall-cancel-btn');
    manifest.assertions.precallModalShown = '1';
    manifest.notes.push('调用前 modal 截图后点取消——本捕获零真实 LLM 外呼');
  });
});

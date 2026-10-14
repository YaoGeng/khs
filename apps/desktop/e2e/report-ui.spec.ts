/**
 * 报告 UI e2e（m1-insight-plan todo 11 = T-M1-06①③；验收①③组）。
 *
 * 场景（诚实性：报告数据经 debug 门控的 report:insertFixture 注入真实 store——渲染/图表/
 * 导出/CSV/采集全是生产链路；XINGLIAN_REPORT_STEP=off 关闭报告生成步骤）：
 * A. 八章节渲染：8 个 section.report-chapter + ⑧章四字段 + 三图表 canvas≥1 各一；
 * B. 导出：MD 含 `## `≥8 处、PDF 字节数>0（printToPDF 管线）、PNG 下载>0、
 *    CSV 表头行 + UTF-8 BOM 字节头（真实 collect fixture 笔记）；
 * C. failure：缺⑧章 mock 报告 → error boundary 显式提示（不空白页）。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;
const scenarioFile = path.join(pkgRoot, 'e2e', 'fixtures', 'collect-scenario.json');

const CHAPTER_IDS = ['scenarios', 'painPoints', 'decisionFactors', 'priceBands', 'competitorPlaybook', 'contentOpportunities', 'selectionKeywords', 'methodology'];
const CHAPTER_TITLES: Record<string, string> = {
  scenarios: '① 需求场景聚类与热度',
  painPoints: '② 用户痛点 TopN',
  decisionFactors: '③ 购买决策因素',
  priceBands: '④ 价格带分布',
  competitorPlaybook: '⑤ 竞品内容打法',
  contentOpportunities: '⑥ 内容机会点',
  selectionKeywords: '⑦ 1688 选品关键词建议',
  methodology: '⑧ 数据来源与方法说明',
};

function chapterJson(id: keyof typeof CHAPTER_TITLES, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const title = CHAPTER_TITLES[id];
  return { title, summary: `${title}——摘要`, bullets: [`要点甲（${title}）`, '要点乙'], ...extra };
}

function buildValidReport(): Record<string, unknown> {
  return {
    topic: 'e2e-ui-topic',
    generatedAt: '2026-10-14T08:00:00.000Z',
    clusterRoute: 'statistical',
    clusterK: 3,
    chapters: {
      scenarios: chapterJson('scenarios'),
      painPoints: chapterJson('painPoints'),
      decisionFactors: chapterJson('decisionFactors'),
      priceBands: chapterJson('priceBands'),
      competitorPlaybook: chapterJson('competitorPlaybook'),
      contentOpportunities: chapterJson('contentOpportunities'),
      selectionKeywords: chapterJson('selectionKeywords'),
      methodology: {
        ...chapterJson('methodology'),
        chapterSampleSizes: Object.fromEntries(CHAPTER_IDS.map((id) => [CHAPTER_TITLES[id], 20])),
        dataWindow: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-14T00:00:00.000Z' },
        cleaningRules: ['去标识化：作者假名化', '仅清洗发往 LLM 的 payload'],
        confidence: '中（样本 20-49）',
      },
    },
  };
}

function buildValidMd(): string {
  const lines = ['# e2e-ui-topic · 需求洞察报告', ''];
  for (const id of CHAPTER_IDS) lines.push(`## ${id} 章节`, '', '摘要文本', '', '- 要点', '');
  lines.push('### 方法说明四要素', '', 'Token 消耗：输入 1 tokens / 输出 2 tokens');
  return lines.join('\n');
}

const DOWNLOAD_DIR_TOKEN = 'xinglian-report-ui-dl';

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(async ([ch, pl]) => (await window.xinglian?.invoke(ch as string, pl)) as never, [channel, payload]) as Promise<T>;
}

/**
 * 下载捕获（Electron 注记）：a[download] Blob 下载在本环境由 Electron 下载管理器真实落盘，
 * 但 Playwright 的 page 'download' 事件不触发（_electron + blob: 组合实测）。
 * e2e 用 will-download 钩子把保存路径重定向到本用例的临时目录，再轮询文件产物断言字节/内容。
 */
async function hookDownloadsTo(electronApp: ElectronApplication, dir: string): Promise<void> {
  await electronApp.evaluate(({ session }, dirPath) => {
    if ((session.defaultSession as unknown as { __e2eDownloadHooked?: boolean }).__e2eDownloadHooked) return;
    (session.defaultSession as unknown as { __e2eDownloadHooked?: boolean }).__e2eDownloadHooked = true;
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSavePath(`${dirPath}/${item.getFilename()}`);
    });
  }, dir);
}

async function waitForDownloaded(dir: string, fileName: string, timeoutMs = 20_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const target = path.join(dir, fileName);
    try {
      const bytes = readFileSync(target);
      if (bytes.length > 0) return target;
    } catch {
      // 尚未落盘，继续轮询
    }
    if (Date.now() - started > timeoutMs) throw new Error(`下载产物未出现：${fileName}（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test.describe.serial('报告 UI（m1 todo 11 = T-M1-06）', () => {
  let userData: string;
  let downloadDir: string;
  let electronApp: ElectronApplication;
  let page: Page;
  let validReportId: number;
  let brokenReportId: number;

  test.beforeAll(async () => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-report-ui-'));
    downloadDir = mkdtempSync(path.join(tmpdir(), DOWNLOAD_DIR_TOKEN + '-'));
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
    await hookDownloadsTo(electronApp, downloadDir);
    validReportId = (await invoke<{ id: number }>(page, 'report:insertFixture', {
      topic: 'e2e-ui-topic',
      report: buildValidReport(),
      contentMd: buildValidMd(),
    })).id;
    const broken = buildValidReport() as { chapters: Record<string, unknown> };
    delete broken.chapters.methodology;
    brokenReportId = (await invoke<{ id: number }>(page, 'report:insertFixture', {
      topic: 'e2e-ui-broken',
      report: broken,
    })).id;
  });

  test.afterAll(async () => {
    await electronApp.close();
    try {
      rmSync(userData, { recursive: true, force: true });
      rmSync(downloadDir, { recursive: true, force: true });
    } catch {
      // tmp 目录残留无妨
    }
  });

  async function openReport(reportId: number): Promise<void> {
    await page.click('.nav-item[data-view="report"]');
    await expect(page.locator('#view-report')).toHaveClass(/active/);
    /* 下拉 3s 轮询刷新——等目标报告选项出现再选择 */
    await page.locator(`#report-select option[value="${reportId}"]`).waitFor({ state: 'attached', timeout: 15_000 });
    await page.selectOption('#report-select', String(reportId));
    await page.waitForSelector('html[data-report-state="rendered"], html[data-report-state="error"]', { timeout: 20_000 });
  }

  test('A. 八章节渲染：8 个章节 section + ⑧章四字段 + 三图表 canvas≥1 各一', async () => {
    await openReport(validReportId);
    await expect(page.locator('html[data-report-state="rendered"]')).toBeAttached();

    for (const id of CHAPTER_IDS) {
      await expect(page.locator(`section.report-chapter[data-chapter="${id}"]`)).toBeVisible();
    }
    expect(await page.locator('section.report-chapter').count()).toBe(8);

    /* ⑧章数据来源四字段（各章样本量/数据窗口/清洗规则/置信度） */
    await expect(page.locator('[data-method-field="各章样本量"]')).toContainText('① 需求场景聚类与热度=20');
    await expect(page.locator('[data-method-field="数据窗口"]')).toContainText('2026-10-01');
    await expect(page.locator('[data-method-field="清洗规则"]')).toContainText('去标识化');
    await expect(page.locator('[data-method-field="置信度"]')).toContainText('样本 20-49');

    /* FR-5.3 图表：echarts 按需模块（scatter/bar/wordcloud）各渲染 canvas≥1 */
    await expect(page.locator('#report-chart-bubble canvas').first()).toBeVisible();
    await expect(page.locator('#report-chart-price canvas').first()).toBeVisible();
    await expect(page.locator('#report-chart-wordcloud canvas').first()).toBeVisible();
    expect(await page.locator('#report-chart-bubble canvas').count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator('#report-chart-price canvas').count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator('#report-chart-wordcloud canvas').count()).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#report-error')).toBeHidden();
  });

  test('B1. 导出 MD：Blob 下载文件内容含 `## `≥8 处', async () => {
    await page.click('#report-export-md');
    const mdPath = await waitForDownloaded(downloadDir, 'e2e-ui-topic-report.md');
    const md = readFileSync(mdPath, 'utf8');
    const count = md.split('## ').length - 1;
    expect(count, `## 出现 ${count} 次（≥8）`).toBeGreaterThanOrEqual(8);
    await expect(page.locator('html[data-report-export-md="done"]')).toBeAttached();
  });

  test('B2. 导出 PDF：printToPDF 管线产物字节数>0', async () => {
    await page.click('#report-export-pdf');
    const pdfPath = await waitForDownloaded(downloadDir, 'e2e-ui-topic-report.pdf');
    const bytes = readFileSync(pdfPath);
    expect(bytes.length, 'PDF 字节数>0').toBeGreaterThan(0);
    expect(bytes.slice(0, 5).toString('ascii'), 'PDF magic header').toBe('%PDF-');
    await expect(page.locator('html[data-report-export-pdf="done"]')).toBeAttached();
  });

  test('B3. 导出图表 PNG：getDataURL 下载字节>0', async () => {
    await page.click('button.chart-export[data-chart-export="bubble"]');
    const pngPath = await waitForDownloaded(downloadDir, 'report-chart-bubble.png');
    expect(readFileSync(pngPath).length).toBeGreaterThan(0);
    await expect(page.locator('html[data-chart-export="done"][data-chart-export-kind="bubble"]')).toBeAttached();
  });

  test('B4. FR-4.6 采集列表 CSV：真实 collect fixture → 表头行 + UTF-8 BOM 字节头', async () => {
    await page.click('.nav-item[data-view="insight"]');
    await expect(page.locator('#view-insight')).toHaveClass(/active/);
    await page.waitForSelector('html[data-gate-loaded="1"]', { timeout: 15_000 });

    const { taskId } = await invoke<{ taskId: string }>(page, 'collect:start', {
      inputType: 'keyword',
      keyword: '测试',
      topicId: 'e2e-ui-csv',
      targetTotal: 50,
    });
    await expect.poll(async () => {
      const tasks = (await invoke<{ tasks: Array<{ id: string; status: string }> }>(page, 'tasks:list')).tasks;
      return tasks.find((t) => t.id === taskId)?.status;
    }, { timeout: 60_000 }).toBe('completed');
    await invoke(page, 'notes:list', { limit: 100 });

    await page.waitForSelector('html[data-notes-loaded="1"][data-notes-count="20"]', { timeout: 15_000 });
    await expect(page.locator('#notes-table tbody tr')).toHaveCount(20);

    await page.click('#notes-export-csv');
    /* CSV 文件名带日期前缀（采集列表-YYYY-MM-DD.csv）——按扩展名在下载目录定位 */
    const csvName = await (async () => {
      const started = Date.now();
      for (;;) {
        const found = readdirSync(downloadDir).find((f) => f.endsWith('.csv'));
        if (found) return found;
        if (Date.now() - started > 20_000) throw new Error('CSV 下载产物未出现');
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    const csvPath = path.join(downloadDir, csvName);
    const bytes = readFileSync(csvPath);
    /* UTF-8 BOM 字节头断言（EF BB BF）+ 表头行 */
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    const firstLine = text.replace(/^\uFEFF/, '').split('\r\n')[0] ?? '';
    expect(firstLine).toContain('"note_id"');
    expect(firstLine).toContain('"title"');
    expect(firstLine).toContain('"likes"');
    expect(text.split('\r\n').length).toBeGreaterThanOrEqual(21);
  });

  test('C. failure：缺⑧章 mock 报告 → 渲染区显式错误提示（非空白页）', async () => {
    await openReport(brokenReportId);
    await expect(page.locator('html[data-report-state="error"]')).toBeAttached();
    await expect(page.locator('html[data-report-error="1"]')).toBeAttached();
    await expect(page.locator('#report-error')).toBeVisible();
    await expect(page.locator('#report-error')).toContainText('报告数据不完整');
    await expect(page.locator('#report-error')).toContainText('第⑧章');
    expect(await page.locator('#report-chapters section.report-chapter').count()).toBe(0);
    await expect(page.locator('#report-charts')).toBeHidden();
  });
});

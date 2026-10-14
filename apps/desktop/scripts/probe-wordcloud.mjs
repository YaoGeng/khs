/* 一次性探针（调试用，不入库运行面）：启动应用 → 注入 fixture 报告 → 打开报告视图 → dump 控制台与 DOM */
import { _electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const pkgRoot = path.join(process.cwd());
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron');

const CHAPTER_IDS = ['scenarios', 'painPoints', 'decisionFactors', 'priceBands', 'competitorPlaybook', 'contentOpportunities', 'selectionKeywords', 'methodology'];
const chapter = (title) => ({ title, summary: `${title}摘要`, bullets: ['a', 'b'] });

const electronApp = await _electron.launch({
  executablePath: electronPath,
  args: ['out/main.js'],
  cwd: pkgRoot,
  env: { ...process.env, XINGLIAN_USER_DATA: mkdtempSync(path.join(tmpdir(), 'probe-')), XINGLIAN_DEBUG_HOOKS: '1', XINGLIAN_REPORT_STEP: 'off' },
});
const page = await electronApp.firstWindow();
page.on('console', (msg) => {
  const text = msg.text();
  if (/wordcloud|Unknown|warn|error/i.test(text)) console.log('[console]', msg.type(), text.slice(0, 300));
});
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 400)));
await page.waitForSelector('html[data-app-mounted="1"]');
await page.click('#eula-accept-btn').catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

const insertResult = await page.evaluate((chapters) => {
  const report = {
    topic: 'probe-topic', generatedAt: '2026-10-14T08:00:00.000Z', clusterRoute: 'statistical', clusterK: 3,
    chapters: { ...chapters, methodology: { ...chapters.scenarios, chapterSampleSizes: { a: 1 }, dataWindow: { from: '2026-10-01', to: '2026-10-14' }, cleaningRules: ['x'], confidence: '低' } },
  };
  return window.xinglian.invoke('report:insertFixture', { topic: 'probe-topic', report, contentMd: '# t' });
}, Object.fromEntries(CHAPTER_IDS.map((id) => [id, chapter(id)])));
console.log('INSERT', JSON.stringify(insertResult));

await page.click('.nav-item[data-view="report"]');
await new Promise((r) => setTimeout(r, 500));
await page.click('#report-refresh');
await new Promise((r) => setTimeout(r, 1000));
console.log('LIST', JSON.stringify(await page.evaluate(() => window.xinglian.invoke('reports:list'))));
console.log('SELECT_HTML', await page.evaluate(() => document.getElementById('report-select')?.innerHTML));
const optionValue = await page.evaluate(() => {
  const select = document.getElementById('report-select');
  return select && select.options.length > 0 ? select.options[0].value : '';
});
console.log('OPTION_VALUE', optionValue);
await page.selectOption('#report-select', optionValue);
await new Promise((r) => setTimeout(r, 4000));
const dump = await page.evaluate(() => ({
  state: document.documentElement.dataset.reportState,
  bubble: document.querySelectorAll('#report-chart-bubble canvas').length,
  price: document.querySelectorAll('#report-chart-price canvas').length,
  cloud: document.querySelectorAll('#report-chart-wordcloud canvas').length,
  cloudChildren: document.getElementById('report-chart-wordcloud')?.childElementCount,
  cloudHtmlLen: document.getElementById('report-chart-wordcloud')?.innerHTML.length,
}));
console.log('DUMP', JSON.stringify(dump));

page.on('download', (d) => console.log('[download]', d.suggestedFilename()));
await electronApp.evaluate(({ BrowserWindow, session }) => {
  const win = BrowserWindow.getAllWindows()[0];
  session.defaultSession.on('will-download', (event, item) => {
    console.log('[will-download]', item.getFilename(), item.getURL().slice(0, 40));
    item.setSavePath(process.env.TEMP + '\\probe-download.md');
  });
});
console.log('hook installed');
await page.click('#report-export-md');
await new Promise((r) => setTimeout(r, 5000));
console.log('MD_FLAG', await page.evaluate(() => document.documentElement.dataset.reportExportMd));
await page.click('button.chart-export[data-chart-export="bubble"]');
await new Promise((r) => setTimeout(r, 5000));
await electronApp.close();
process.exit(0);

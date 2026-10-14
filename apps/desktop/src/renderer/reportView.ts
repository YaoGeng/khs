/**
 * 选品报告视图（m1 todo 11 = T-M1-06①③；FR-5.2/5.3/5.4 + 03:220 B-6）。
 *
 * - 八章节渲染：章节卡 section.report-chapter[data-chapter=<id>] ×8；⑧章数据来源四字段
 *   （各章样本量/数据窗口/清洗规则/置信度）以 data-method-field 锚点渲染；
 * - 失败边界：报告 JSON 缺章/缺⑧章四字段 → #report-error 显式错误提示（不空白页）；
 * - 图表：echarts 按需模块（bubble=scatter / 直方图=bar / 词云=echarts-wordcloud 插件），
 *   数据源 reports:chartData（主进程对 notes 的确定性统计）；各图 getDataURL 导出 PNG；
 * - 导出：MD（contentMd Blob 下载）+ PDF（report:exportPdf → webContents.printToPDF 管线）。
 * 渲染层不携带 zod：结构校验为本模块的显式白名单检查（validateReport）。
 */
import * as echarts from 'echarts/core';
import { BarChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import 'echarts-wordcloud';
import { base64ToBlob, downloadBlob } from './download';

echarts.use([ScatterChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const bridge = window.xinglian;
const root = document.documentElement;

const CHAPTER_IDS = ['scenarios', 'painPoints', 'decisionFactors', 'priceBands', 'competitorPlaybook', 'contentOpportunities', 'selectionKeywords', 'methodology'] as const;
type ChapterId = (typeof CHAPTER_IDS)[number];

interface ReportJson {
  topic: string;
  generatedAt: string;
  clusterRoute: string;
  clusterK: number;
  chapters: Partial<Record<ChapterId, ChapterJson>>;
}
interface ChapterJson {
  title?: string;
  summary?: string;
  bullets?: string[];
  chapterSampleSizes?: Record<string, number>;
  dataWindow?: { from?: string; to?: string };
  cleaningRules?: string[];
  confidence?: string;
}

const reportSelect = document.getElementById('report-select') as HTMLSelectElement | null;
const reportRefreshBtn = document.getElementById('report-refresh');
const reportExportMd = document.getElementById('report-export-md') as HTMLButtonElement | null;
const reportExportPdf = document.getElementById('report-export-pdf') as HTMLButtonElement | null;
const reportExportStatus = document.getElementById('report-export-status');
const reportError = document.getElementById('report-error');
const reportMeta = document.getElementById('report-meta');
const reportChapters = document.getElementById('report-chapters');
const reportCharts = document.getElementById('report-charts');
const printRoot = document.getElementById('print-root');

const charts = new Map<string, echarts.ECharts>();
let currentReport: { id: number; report: ReportJson; contentMd: string } | null = null;

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  if (!bridge) throw new Error('bridge missing');
  return (await bridge.invoke(channel, payload)) as T;
}

/** 失败边界白名单校验：非空即错误文案（缺⑧章四字段是 QA failure 组硬场景） */
export function validateReport(report: ReportJson | null | undefined): string | null {
  if (!report || typeof report !== 'object' || !report.chapters) return '报告数据缺失或格式损坏（chapters 缺失）';
  for (const id of CHAPTER_IDS) {
    const chapter = report.chapters[id];
    if (!chapter || typeof chapter.title !== 'string' || chapter.title.length === 0) return `第「${id}」章缺失：章节标题为空`;
    if (typeof chapter.summary !== 'string' || chapter.summary.length === 0) return `第「${id}」章缺失：章节摘要为空`;
    if (!Array.isArray(chapter.bullets) || chapter.bullets.length === 0) return `第「${id}」章缺失：章节要点为空`;
  }
  const methodology = report.chapters.methodology;
  if (!methodology) return '第⑧章缺失：数据来源与方法说明';
  if (!methodology.chapterSampleSizes || Object.keys(methodology.chapterSampleSizes).length === 0) return '第⑧章数据来源四字段缺失：各章样本量';
  if (!methodology.dataWindow || !methodology.dataWindow.from || !methodology.dataWindow.to) return '第⑧章数据来源四字段缺失：数据窗口';
  if (!Array.isArray(methodology.cleaningRules) || methodology.cleaningRules.length === 0) return '第⑧章数据来源四字段缺失：清洗规则';
  if (typeof methodology.confidence !== 'string' || methodology.confidence.length === 0) return '第⑧章数据来源四字段缺失：置信度';
  return null;
}

function renderChapters(report: ReportJson, keywordFilter: { allowed: string[]; removed: Array<{ bullet: string; term: string }>; wordlistVersion: string | null } | null): void {
  if (!reportChapters) return;
  reportChapters.textContent = '';
  for (const id of CHAPTER_IDS) {
    const chapter = report.chapters[id];
    if (!chapter) continue;
    const section = document.createElement('section');
    section.className = 'report-chapter';
    section.dataset.chapter = id;

    const title = document.createElement('h3');
    title.className = 'chapter-title';
    title.textContent = chapter.title ?? '';
    const summary = document.createElement('p');
    summary.className = 'chapter-summary';
    summary.textContent = chapter.summary ?? '';
    section.append(title, summary);

    const bullets = id === 'selectionKeywords' && keywordFilter ? keywordFilter.allowed : (chapter.bullets ?? []);
    const listEl = document.createElement('ul');
    listEl.className = 'chapter-bullets';
    for (const bullet of bullets) {
      const item = document.createElement('li');
      item.textContent = bullet;
      listEl.appendChild(item);
    }
    section.appendChild(listEl);

    if (id === 'selectionKeywords' && keywordFilter && keywordFilter.removed.length > 0) {
      const filterNote = document.createElement('p');
      filterNote.className = 'chapter-filter-note';
      filterNote.dataset.removedCount = String(keywordFilter.removed.length);
      filterNote.textContent = `合规注记：${keywordFilter.removed.length} 条建议词命中词库 v${keywordFilter.wordlistVersion ?? '?'} 黑名单，已剔除（keyword_hits 留痕）。`;
      section.appendChild(filterNote);
    }

    if (id === 'methodology') {
      const dl = document.createElement('dl');
      dl.className = 'method-fields';
      const addField = (field: string, text: string): void => {
        const dt = document.createElement('dt');
        dt.textContent = field;
        const dd = document.createElement('dd');
        dd.dataset.methodField = field;
        dd.textContent = text;
        dl.append(dt, dd);
      };
      addField(
        '各章样本量',
        Object.entries(chapter.chapterSampleSizes ?? {}).map(([k, v]) => `${k}=${v}`).join('，'),
      );
      addField('数据窗口', `${chapter.dataWindow?.from ?? '?'} ~ ${chapter.dataWindow?.to ?? '?'}`);
      addField('清洗规则', (chapter.cleaningRules ?? []).join('；'));
      addField('置信度', chapter.confidence ?? '');
      section.appendChild(dl);
    }
    reportChapters.appendChild(section);
  }
}

function disposeCharts(): void {
  for (const chart of charts.values()) chart.dispose();
  charts.clear();
}

function renderCharts(data: {
  clusters: Array<{ label: string; size: number; avgLikes: number; avgCollects: number }>;
  priceBuckets: { ranges: string[]; counts: number[] };
  wordcloud: Array<{ term: string; weight: number }>;
}): void {
  disposeCharts();
  const bubbleEl = document.getElementById('report-chart-bubble');
  const priceEl = document.getElementById('report-chart-price');
  const wordcloudEl = document.getElementById('report-chart-wordcloud');
  if (bubbleEl) {
    const chart = echarts.init(bubbleEl);
    chart.setOption({
      tooltip: {},
      grid: { left: 48, right: 24, top: 24, bottom: 32 },
      xAxis: { name: '赞(均)', type: 'value' },
      yAxis: { name: '藏(均)', type: 'value' },
      series: [
        {
          type: 'scatter',
          name: '场景簇',
          symbolSize: (value: number[]) => Math.max(12, Math.sqrt(value[2] ?? 1) * 6),
          data: data.clusters.map((c) => ({ name: c.label, value: [c.avgLikes, c.avgCollects, c.size] })),
        },
      ],
    });
    charts.set('bubble', chart);
  }
  if (priceEl) {
    const chart = echarts.init(priceEl);
    chart.setOption({
      tooltip: {},
      grid: { left: 48, right: 24, top: 24, bottom: 32 },
      xAxis: { type: 'category', data: data.priceBuckets.ranges },
      yAxis: { type: 'value', name: '价格点数' },
      series: [{ type: 'bar', name: '价格带', data: data.priceBuckets.counts }],
    });
    charts.set('price', chart);
  }
  if (wordcloudEl) {
    const chart = echarts.init(wordcloudEl);
    /* 词云数据兜底：notes 缺乏（空主题/fixture 报告）时用报告⑦章建议词词根兜底——
       wordcloud2 布局对空数据不产出画布；兜底词仍是报告真实内容，非编造 */
    let cloudData = data.wordcloud.map((w) => ({ name: w.term, value: w.weight }));
    if (cloudData.length === 0) {
      const bullets = currentReport?.report.chapters.selectionKeywords?.bullets ?? [];
      cloudData = bullets
        .map((bullet) => ({ name: bullet.split(/[：:]/, 1)[0]?.trim() || bullet.slice(0, 12), value: 1 }))
        .filter((entry) => entry.name.length > 0);
      if (cloudData.length === 0) cloudData = [{ name: currentReport?.report.topic ?? '报告', value: 1 }];
    }
    try {
      chart.setOption({
        series: [
          {
            type: 'wordCloud',
            shape: 'circle',
            gridSize: 8,
            sizeRange: [12, 42],
            rotationRange: [0, 0],
            data: cloudData,
          },
        ],
      });
      charts.set('wordcloud', chart);
    } catch (error) {
      console.warn('[renderer] wordcloud render failed:', error);
      chart.dispose();
    }
  }
}

function renderPrintRoot(report: ReportJson, contentMd: string): void {
  if (!printRoot) return;
  printRoot.replaceChildren();
  const pre = document.createElement('pre');
  pre.className = 'print-md';
  pre.textContent = contentMd;
  printRoot.appendChild(pre);
}

async function loadReport(reportId: number): Promise<void> {
  root.dataset.reportState = 'pending';
  try {
    const data = await invoke<{ report: ReportJson | null; contentMd: string | null; keywordFilter: { allowed: string[]; removed: Array<{ bullet: string; term: string }>; wordlistVersion: string | null } | null }>('reports:get', { reportId });
    if (reportError) reportError.hidden = true;

    if (!data.report) {
      showReportError(`报告 #${reportId} 不存在或已删除`);
      return;
    }
    const problem = validateReport(data.report);
    if (problem) {
      showReportError(`报告数据不完整，无法渲染：${problem}`);
      return;
    }
    const report = data.report;
    currentReport = { id: reportId, report, contentMd: data.contentMd ?? '' };
    if (reportError) reportError.hidden = true;
    if (reportMeta) {
      reportMeta.hidden = false;
      reportMeta.textContent = `${report.topic} · 生成于 ${report.generatedAt} · 聚类 ${report.clusterRoute === 'vector' ? '向量' : '统计'}(K=${report.clusterK})`;
    }
    renderChapters(report, data.keywordFilter);
    if (reportCharts) reportCharts.hidden = false;
    const chartData = await invoke<{ clusters: []; priceBuckets: { ranges: []; counts: [] }; wordcloud: [] }>('report:chartData', { reportId });
    renderCharts(chartData);
    renderPrintRoot(report, data.contentMd ?? '');
    if (reportExportMd) reportExportMd.disabled = false;
    if (reportExportPdf) reportExportPdf.disabled = false;
    root.dataset.reportState = 'rendered';
    root.dataset.reportError = '0';
  } catch (error) {
    showReportError(`报告加载失败：${String((error as Error).message).slice(0, 160)}`);
  }
}

function showReportError(message: string): void {
  currentReport = null;
  if (reportError) {
    reportError.hidden = false;
    reportError.textContent = `⚠ ${message}`;
  }
  if (reportMeta) reportMeta.hidden = true;
  if (reportChapters) reportChapters.textContent = '';
  if (reportCharts) reportCharts.hidden = true;
  disposeCharts();
  if (printRoot) printRoot.replaceChildren();
  if (reportExportMd) reportExportMd.disabled = true;
  if (reportExportPdf) reportExportPdf.disabled = true;
  root.dataset.reportState = 'error';
  root.dataset.reportError = '1';
}

export async function refreshReportList(): Promise<void> {
  if (!reportSelect) return;
  try {
    const result = await invoke<{ reports: Array<{ id: number; topic: string; createdAt: string }> }>('reports:list');
    const previous = reportSelect.value;
    reportSelect.textContent = '';
    if (result.reports.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '（暂无报告）';
      reportSelect.appendChild(option);
    }
    for (const report of result.reports) {
      const option = document.createElement('option');
      option.value = String(report.id);
      option.textContent = `#${report.id} ${report.topic}（${report.createdAt.slice(0, 10)}）`;
      reportSelect.appendChild(option);
    }
    if (result.reports.some((r) => String(r.id) === previous)) reportSelect.value = previous;
    root.dataset.reportListLoaded = '1';
    root.dataset.reportCount = String(result.reports.length);
  } catch (error) {
    root.dataset.reportListLoaded = 'error';
    console.warn('[renderer] reports:list failed:', error);
  }
}

reportSelect?.addEventListener('change', () => {
  const id = Number(reportSelect.value);
  if (Number.isInteger(id) && id > 0) void loadReport(id);
});

reportRefreshBtn?.addEventListener('click', () => void refreshReportList());

reportExportMd?.addEventListener('click', () => {
  if (!currentReport || !reportExportStatus) return;
  const blob = new Blob([currentReport.contentMd], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(`${currentReport.report.topic}-report.md`, blob);
  reportExportStatus.textContent = 'Markdown 已导出。';
  root.dataset.reportExportMd = 'done';
});

reportExportPdf?.addEventListener('click', () => {
  void (async () => {
    if (!currentReport || !reportExportStatus) return;
    reportExportPdf.disabled = true;
    root.dataset.reportExportPdf = 'pending';
    try {
      const result = await invoke<{ dataBase64: string }>('report:exportPdf');
      downloadBlob(`${currentReport.report.topic}-report.pdf`, base64ToBlob(result.dataBase64, 'application/pdf'));
      reportExportStatus.textContent = 'PDF 已导出（printToPDF 管线）。';
      root.dataset.reportExportPdf = 'done';
    } catch (error) {
      reportExportStatus.textContent = `PDF 导出失败：${String((error as Error).message).slice(0, 140)}`;
      root.dataset.reportExportPdf = 'failed';
    } finally {
      reportExportPdf.disabled = false;
    }
  })();
});

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('button.chart-export[data-chart-export]'))) {
  button.addEventListener('click', () => {
    const kind = button.dataset.chartExport ?? '';
    const chart = charts.get(kind);
    if (!chart) return;
    const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' });
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `report-chart-${kind}.png`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    root.dataset.chartExport = 'done';
    root.dataset.chartExportKind = kind;
  });
}

export function initReportView(): void {
  void refreshReportList();
  // 报告由 collect 管道异步生成（collect-report 步骤）——下拉轮询刷新，保证新生成报告可达
  setInterval(() => void refreshReportList(), 3000);
}

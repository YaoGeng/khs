/**
 * 智能选品视图（05 T-M2-03；FR-6.2 权重可调 / FR-6.3 候选清单对比表格）。
 *
 * - 任务卡：selection:list——报告闸门产出的选品任务（excludedJunk 高企 = 匿名检索
 *   吃到推荐流的「需登录 1688」诚实提示，不臆造候选）。
 * - 候选表格：selection:candidates + 置顶集；综合分按 selection:config 权重读时重算
 *   （相对权重归一化，Σ score×w/Σw），维度损坏行回退库内原始 total——Agent 原始
 *   rank/total 落库不动，重算纯视图行为。
 * - 权重面板：五维 0-100 滑杆 → selection:setWeights 持久化（全局）。
 * - 排序/筛选：综合分/五维/价格/销量列排序 + 检索词下拉 + 标题/供应商模糊过滤；
 *   置顶行恒定居首（FR-6.3）。
 * html data-* 标记为 e2e 断言面（沿用壳层既有模式）。
 */
const bridge = window.xinglian;
const root = document.documentElement;

const taskList = document.getElementById('sourcing-task-list');
const statusLine = document.getElementById('sourcing-status');
const weightsPanel = document.getElementById('sourcing-weights-panel');
const weightSliders = document.getElementById('sourcing-weight-sliders');
const weightsApplyBtn = document.getElementById('sourcing-weights-apply') as HTMLButtonElement | null;
const weightsResetBtn = document.getElementById('sourcing-weights-reset') as HTMLButtonElement | null;
const weightsNote = document.getElementById('sourcing-weights-note');
const toolbar = document.getElementById('sourcing-toolbar');
const keywordFilter = document.getElementById('sourcing-keyword-filter') as HTMLSelectElement | null;
const searchInput = document.getElementById('sourcing-search') as HTMLInputElement | null;
const sortSelect = document.getElementById('sourcing-sort') as HTMLSelectElement | null;
const sortDirBtn = document.getElementById('sourcing-sort-dir') as HTMLButtonElement | null;
const hintLine = document.getElementById('sourcing-hint');
const tableWrap = document.getElementById('sourcing-table-wrap');
const tbody = document.getElementById('sourcing-tbody');

type DimensionId = 'relevance' | 'price' | 'sales' | 'supplier' | 'gallery';

interface DimensionMeta {
  id: DimensionId;
  title: string;
  default: number;
}

interface DimensionScoreView {
  name: string;
  title: string;
  score: number;
  weight: number;
  reason: string;
}

interface SelectionSummaryView {
  taskId: string;
  topic: string;
  topicId: string | null;
  keywords: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
  candidateCount: number;
  excludedJunk: number | null;
  generatedAt: string | null;
}

interface CandidateView {
  id: number;
  taskId: string;
  selectionId: string;
  rank: number;
  offerId: string;
  keyword: string;
  total: number;
  dimensions: unknown;
  title: string;
  priceText: string | null;
  salesText: string | null;
  supplierName: string | null;
  supplierAddress: string | null;
  sourceUrl: string | null;
  createdAt: string;
}

/** 维度短标签（紧凑五维格用；id 集来自 selection:config，本地缩写映射） */
const DIMENSION_SHORT: Record<string, string> = {
  relevance: '相关',
  price: '价格',
  sales: '销量',
  supplier: '供应',
  gallery: '素材',
};

const state = {
  selections: [] as SelectionSummaryView[],
  activeTaskId: null as string | null,
  candidates: [] as CandidateView[],
  pinned: new Set<string>(),
  dimensions: [] as DimensionMeta[],
  weights: null as Record<DimensionId, number> | null,
  customized: false,
  keyword: '',
  search: '',
  sort: 'total',
  sortDir: 'desc' as 'asc' | 'desc',
};

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  if (!bridge) throw new Error('bridge missing');
  return (await bridge.invoke(channel, payload)) as T;
}

function parseDimensions(value: unknown): DimensionScoreView[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const dims: DimensionScoreView[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const d = item as Partial<DimensionScoreView>;
    if (typeof d.name !== 'string' || typeof d.score !== 'number' || !Number.isFinite(d.score)) continue;
    dims.push({ name: d.name, title: d.title ?? d.name, score: d.score, weight: d.weight ?? 0, reason: d.reason ?? '' });
  }
  return dims.length > 0 ? dims : null;
}

/** 读时重算综合分（与主进程 recomputeTotal 同式：Σ score × w/Σw；权重缺失回退库内 total） */
function displayTotal(candidate: CandidateView): number {
  const weights = state.weights;
  if (!weights) return candidate.total;
  const dims = parseDimensions(candidate.dimensions);
  if (!dims) return candidate.total;
  const sum = state.dimensions.reduce((acc, d) => acc + (weights[d.id] ?? 0), 0);
  if (sum <= 0) return candidate.total;
  let total = 0;
  for (const d of dims) total += d.score * ((weights[d.name as DimensionId] ?? 0) / sum);
  return Math.round(total);
}

function dimensionScore(candidate: CandidateView, name: string): number | null {
  const dims = parseDimensions(candidate.dimensions);
  return dims?.find((d) => d.name === name)?.score ?? null;
}

/** 价格排序值：首个数字（"12.30~15.00" → 12.3；缺失 null 排最后） */
function priceValue(candidate: CandidateView): number | null {
  if (!candidate.priceText) return null;
  const m = /\d+(?:\.\d+)?/.exec(candidate.priceText);
  return m ? Number(m[0]) : null;
}

/** 销量排序值：万/千/w/k 倍率（agents parseMonthlySales 的渲染侧镜像） */
function salesValue(candidate: CandidateView): number | null {
  if (!candidate.salesText) return null;
  const m = /([\d.]+)\s*(万|w|千|k)?/i.exec(candidate.salesText);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2]?.toLowerCase();
  if (unit === '万' || unit === 'w') return n * 10_000;
  if (unit === '千' || unit === 'k') return n * 1_000;
  return n;
}

function sortValue(candidate: CandidateView, key: string): number | null {
  if (key === 'total') return displayTotal(candidate);
  if (key === 'price') return priceValue(candidate);
  if (key === 'sales') return salesValue(candidate);
  return dimensionScore(candidate, key);
}

function visibleCandidates(): CandidateView[] {
  const search = state.search.trim().toLowerCase();
  const filtered = state.candidates.filter((c) => {
    if (state.keyword && c.keyword !== state.keyword) return false;
    if (search) {
      const haystack = `${c.title} ${c.supplierName ?? ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  const dir = state.sortDir === 'desc' ? -1 : 1;
  filtered.sort((a, b) => {
    // 置顶恒定居首（FR-6.3），置顶组内与普通组内同序
    const pa = state.pinned.has(a.offerId) ? 0 : 1;
    const pb = state.pinned.has(b.offerId) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const va = sortValue(a, state.sort);
    const vb = sortValue(b, state.sort);
    if (va === null && vb === null) return a.offerId < b.offerId ? -1 : 1;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (va !== vb) return (va - vb) * dir;
    return a.offerId < b.offerId ? -1 : 1;
  });
  return filtered;
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    completed: '已完成',
    running: '选品中…',
    queued: '排队中（下次启动执行）',
    failed: '失败',
    suspended: '已挂起',
    paused: '已暂停',
  };
  return map[status] ?? status;
}

function renderTaskCards(): void {
  if (!taskList || !statusLine) return;
  taskList.textContent = '';
  if (state.selections.length === 0) {
    statusLine.textContent = '尚无选品任务——在「市场洞察」视图确认报告⑦章关键词闸门后生成（FR-6 链路）。';
    return;
  }
  statusLine.textContent = `共 ${state.selections.length} 个选品任务`;
  for (const selection of state.selections) {
    const card = document.createElement('article');
    card.className = 'sourcing-task-card';
    card.dataset.taskId = selection.taskId;
    card.dataset.status = selection.status;
    card.classList.toggle('active', selection.taskId === state.activeTaskId);

    const title = document.createElement('h3');
    title.textContent = selection.topic;
    const meta = document.createElement('p');
    meta.className = 'sourcing-task-meta';
    const terms = selection.keywords.map((k) => k.split('——')[0]).join('、');
    meta.textContent = `${new Date(selection.createdAt).toLocaleString()} · ${statusBadge(selection.status)} · 候选 ${selection.candidateCount} 条${terms ? ` · ${terms}` : ''}`;
    card.append(title, meta);

    // 匿名检索推荐流的诚实信号（T-M2-01 取证）：剔除高企 → 提示登录，不臆造
    if ((selection.excludedJunk ?? 0) > 0) {
      const warn = document.createElement('p');
      warn.className = 'sourcing-task-warn';
      warn.dataset.excludedJunk = String(selection.excludedJunk);
      warn.textContent = `检索剔除疑似推荐流卡片 ${selection.excludedJunk} 张——匿名检索命中率有限，登录 1688（受控浏览器）后重新选品可提高相关性。`;
      card.appendChild(warn);
    }

    card.addEventListener('click', () => {
      void selectTask(selection.taskId);
    });
    taskList.appendChild(card);
  }
}

function renderWeightSliders(): void {
  if (!weightSliders || !weightsPanel || !weightsNote) return;
  const weights = state.weights;
  weightsPanel.hidden = state.selections.length === 0 || !weights;
  if (!weights) return;
  weightSliders.textContent = '';
  for (const dim of state.dimensions) {
    const row = document.createElement('label');
    row.className = 'sourcing-weight-row';
    row.dataset.dimension = dim.id;
    const label = document.createElement('span');
    label.className = 'sourcing-weight-label';
    label.textContent = dim.title;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = String(weights[dim.id] ?? dim.default);
    input.dataset.dimension = dim.id;
    input.setAttribute('aria-label', `${dim.title}权重`);
    const value = document.createElement('span');
    value.className = 'sourcing-weight-value';
    value.dataset.dimension = dim.id;
    value.textContent = String(weights[dim.id] ?? dim.default);
    input.addEventListener('input', () => {
      value.textContent = input.value;
    });
    row.append(label, input, value);
    weightSliders.appendChild(row);
  }
  weightsNote.textContent = state.customized ? '已保存自定义权重（相对值：等比放大不改变结果）' : '当前为 Agent 默认权重';
}

function renderKeywordOptions(): void {
  if (!keywordFilter) return;
  const current = state.keyword;
  keywordFilter.textContent = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部';
  keywordFilter.appendChild(all);
  for (const kw of [...new Set(state.candidates.map((c) => c.keyword))]) {
    const option = document.createElement('option');
    option.value = kw;
    option.textContent = kw;
    keywordFilter.appendChild(option);
  }
  keywordFilter.value = current;
  if (keywordFilter.value !== current) {
    keywordFilter.value = '';
    state.keyword = '';
  }
}

function dimensionCell(candidate: CandidateView): HTMLElement {
  const cell = document.createElement('td');
  cell.className = 'sourcing-dims';
  const dims = parseDimensions(candidate.dimensions);
  if (!dims) {
    cell.textContent = '（维度数据缺失）';
    return cell;
  }
  const reasons: string[] = [];
  for (const d of dims) {
    const chip = document.createElement('span');
    chip.className = 'sourcing-dim-chip';
    chip.dataset.dimension = d.name;
    chip.textContent = `${DIMENSION_SHORT[d.name] ?? d.name} ${Math.round(d.score)}`;
    cell.appendChild(chip);
    reasons.push(`${d.title} ${Math.round(d.score)}：${d.reason || '（无理由）'}`);
  }
  // FR-6.2 可解释：悬停看各维理由（title 原生 tooltip，无弹层依赖）
  cell.title = reasons.join('\n');
  return cell;
}

function renderTable(): void {
  if (!tbody || !tableWrap || !hintLine) return;
  const rows = state.activeTaskId ? visibleCandidates() : [];
  tbody.textContent = '';
  tableWrap.hidden = rows.length === 0;
  hintLine.hidden = rows.length > 0 || !state.activeTaskId;
  if (state.activeTaskId && rows.length === 0) {
    hintLine.textContent = '当前筛选条件下无候选（调整关键词/搜索条件，或任务尚未产出候选）。';
  }
  for (const [index, candidate] of rows.entries()) {
    const tr = document.createElement('tr');
    tr.dataset.offerId = candidate.offerId;
    tr.dataset.rank = String(candidate.rank);
    tr.dataset.displayTotal = String(displayTotal(candidate));
    const pinned = state.pinned.has(candidate.offerId);
    tr.dataset.pinned = String(pinned);

    const pinTd = document.createElement('td');
    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'btn btn-ghost sourcing-pin-btn';
    pinBtn.dataset.offerId = candidate.offerId;
    pinBtn.dataset.pinned = String(pinned);
    pinBtn.textContent = pinned ? '📌 已置顶' : '📌 置顶';
    pinBtn.setAttribute('aria-label', pinned ? `取消置顶 ${candidate.title.slice(0, 20)}` : `置顶 ${candidate.title.slice(0, 20)}`);
    pinBtn.addEventListener('click', () => {
      void togglePin(candidate.offerId, !state.pinned.has(candidate.offerId));
    });
    pinTd.appendChild(pinBtn);

    const rankTd = document.createElement('td');
    rankTd.textContent = String(index + 1);

    const titleTd = document.createElement('td');
    titleTd.className = 'sourcing-title';
    const titleText = document.createElement('span');
    titleText.textContent = candidate.title;
    titleTd.appendChild(titleText);
    if (candidate.sourceUrl) {
      const url = document.createElement('span');
      url.className = 'sourcing-offer-id';
      url.textContent = `offer ${candidate.offerId}`;
      url.title = candidate.sourceUrl;
      titleTd.appendChild(url);
    }

    const keywordTd = document.createElement('td');
    keywordTd.textContent = candidate.keyword;
    const priceTd = document.createElement('td');
    priceTd.textContent = candidate.priceText ?? '—';
    const salesTd = document.createElement('td');
    salesTd.textContent = candidate.salesText ?? '—';
    const supplierTd = document.createElement('td');
    supplierTd.textContent = candidate.supplierName ? `${candidate.supplierName}${candidate.supplierAddress ? `（${candidate.supplierAddress}）` : ''}` : '—';
    supplierTd.title = candidate.supplierAddress ?? '';

    const totalTd = document.createElement('td');
    totalTd.className = 'sourcing-total';
    totalTd.textContent = String(displayTotal(candidate));

    tr.append(pinTd, rankTd, titleTd, keywordTd, priceTd, salesTd, supplierTd, dimensionCell(candidate), totalTd);
    tbody.appendChild(tr);
  }
  root.dataset.sourcingCount = String(rows.length);
  root.dataset.sourcingSort = state.sort;
  root.dataset.sourcingSortDir = state.sortDir;
  root.dataset.sourcingKeyword = state.keyword;
}

async function selectTask(taskId: string): Promise<void> {
  state.activeTaskId = taskId;
  state.keyword = '';
  if (searchInput) searchInput.value = '';
  state.search = '';
  try {
    const result = await invoke<{ candidates: CandidateView[]; pinned: string[] }>('selection:candidates', { taskId });
    state.candidates = result.candidates;
    state.pinned = new Set(result.pinned);
    root.dataset.sourcingLoaded = '1';
  } catch (error) {
    console.warn('[renderer] selection:candidates failed:', error);
    state.candidates = [];
    state.pinned = new Set();
    root.dataset.sourcingLoaded = 'error';
  }
  renderTaskCards();
  renderKeywordOptions();
  if (toolbar) toolbar.hidden = state.candidates.length === 0;
  renderTable();
}

async function togglePin(offerId: string, pinned: boolean): Promise<void> {
  if (!state.activeTaskId) return;
  root.dataset.sourcingPin = 'pending';
  try {
    const result = await invoke<{ taskId: string; offerIds: string[] }>('selection:setPinned', {
      taskId: state.activeTaskId,
      offerId,
      pinned,
    });
    state.pinned = new Set(result.offerIds);
    root.dataset.sourcingPin = 'done';
    renderTable();
  } catch (error) {
    console.warn('[renderer] selection:setPinned failed:', error);
    root.dataset.sourcingPin = 'failed';
  }
}

async function applyWeights(weights: Record<DimensionId, number>): Promise<void> {
  if (!weightsApplyBtn) return;
  weightsApplyBtn.disabled = true;
  root.dataset.sourcingWeights = 'pending';
  try {
    const config = await invoke<{ dimensions: DimensionMeta[]; weights: Record<DimensionId, number>; customized: boolean }>(
      'selection:setWeights',
      { weights },
    );
    state.weights = config.weights;
    state.customized = config.customized;
    root.dataset.sourcingWeights = 'applied';
    renderWeightSliders();
    renderTable();
  } catch (error) {
    console.warn('[renderer] selection:setWeights failed:', error);
    root.dataset.sourcingWeights = 'failed';
  } finally {
    weightsApplyBtn.disabled = false;
  }
}

/** 收集滑杆当前值；全零非法（契约 refine 同口径，前端先拦） */
function collectSliderWeights(): Record<DimensionId, number> | null {
  const weights = {} as Record<DimensionId, number>;
  let sum = 0;
  for (const dim of state.dimensions) {
    const input = weightSliders?.querySelector<HTMLInputElement>(`input[type="range"][data-dimension="${dim.id}"]`);
    const value = input ? Number(input.value) : (state.weights?.[dim.id] ?? dim.default);
    if (!Number.isFinite(value)) return null;
    weights[dim.id] = Math.max(0, Math.min(100, Math.trunc(value)));
    sum += weights[dim.id];
  }
  return sum > 0 ? weights : null;
}

export async function refreshSourcingView(): Promise<void> {
  try {
    const [listResult, config] = await Promise.all([
      invoke<{ selections: SelectionSummaryView[] }>('selection:list'),
      invoke<{ dimensions: DimensionMeta[]; weights: Record<DimensionId, number>; customized: boolean }>('selection:config'),
    ]);
    state.selections = listResult.selections;
    state.dimensions = config.dimensions;
    state.weights = config.weights;
    state.customized = config.customized;
    root.dataset.sourcingLoaded = '1';
  } catch (error) {
    console.warn('[renderer] selection:list/config failed:', error);
    root.dataset.sourcingLoaded = 'error';
    if (statusLine) statusLine.textContent = `选品数据读取失败：${String(error).slice(0, 120)}`;
    return;
  }
  renderTaskCards();
  renderWeightSliders();
  const activeExists = state.selections.some((s) => s.taskId === state.activeTaskId);
  const target = activeExists ? state.activeTaskId : (state.selections[0]?.taskId ?? null);
  if (target) {
    await selectTask(target);
  } else {
    if (toolbar) toolbar.hidden = true;
    if (tableWrap) tableWrap.hidden = true;
    renderTable();
  }
}

export function initSourcingView(): void {
  weightsApplyBtn?.addEventListener('click', () => {
    const weights = collectSliderWeights();
    if (!weights) {
      if (weightsNote) weightsNote.textContent = '权重不能全为 0（至少一维 > 0）';
      root.dataset.sourcingWeights = 'invalid';
      return;
    }
    void applyWeights(weights);
  });

  weightsResetBtn?.addEventListener('click', () => {
    const defaults = {} as Record<DimensionId, number>;
    for (const dim of state.dimensions) defaults[dim.id] = dim.default;
    void applyWeights(defaults);
  });

  keywordFilter?.addEventListener('change', () => {
    state.keyword = keywordFilter.value;
    renderTable();
  });

  searchInput?.addEventListener('input', () => {
    state.search = searchInput.value;
    renderTable();
  });

  sortSelect?.addEventListener('change', () => {
    state.sort = sortSelect.value;
    renderTable();
  });

  sortDirBtn?.addEventListener('click', () => {
    state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
    sortDirBtn.dataset.dir = state.sortDir;
    sortDirBtn.textContent = state.sortDir === 'desc' ? '降序 ↓' : '升序 ↑';
    renderTable();
  });

  void refreshSourcingView();
}

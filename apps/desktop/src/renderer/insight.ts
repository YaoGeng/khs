/**
 * 市场洞察视图（m1 todo 11 = T-M1-06②④；FR-4.6 + 02:274 E 步闸门）。
 *
 * - 闸门卡片：gate:list 轮询渲染 awaiting_user 闸门——keyword_confirm 显示⑦章过滤后
 *   建议词 + 确认/拒绝；llm_key_config 显示「配置 Key 后恢复」引导（恢复 = tasks:resume
 *   重跑 collect-report 步骤）。
 * - 爆款清单（M2 产品卡② = FR-4.7）：viral:list 读面 + 重算/解读按钮（解读 = 真实
 *   BYOK 单次调用，按钮文案明示）。
 * - 采集列表：notes:list → 表格 + 导出 CSV（UTF-8 BOM 表头行，禁造假 .xlsx）。
 * html data-* 标记为 e2e 断言面（沿用壳层既有模式）。
 */
import { buildCsv, downloadBlob } from './download';

const bridge = window.xinglian;
const root = document.documentElement;

const gateStatus = document.getElementById('gate-status');
const gateList = document.getElementById('gate-list');
const viralStatus = document.getElementById('viral-status');
const viralList = document.getElementById('viral-list');
const viralRefreshBtn = document.getElementById('viral-refresh') as HTMLButtonElement | null;
const viralRationaleBtn = document.getElementById('viral-rationale') as HTMLButtonElement | null;
const notesStatus = document.getElementById('notes-status');
const notesTable = document.getElementById('notes-table');
const notesTbody = document.getElementById('notes-tbody');
const notesExportCsv = document.getElementById('notes-export-csv') as HTMLButtonElement | null;
const notesCsvStatus = document.getElementById('notes-csv-status');

interface KeywordFilterView {
  allowed: string[];
  removed: Array<{ bullet: string; term: string; kind: string; category: string | null }>;
  wordlistVersion: string | null;
  persisted: number;
}

interface GateView {
  taskId: string;
  kind: string;
  status: string;
  gate: 'keyword_confirm' | 'llm_key_config';
  reportId: number | null;
  topicId: string | null;
  topic: string | null;
  createdAt: string;
  keywords: KeywordFilterView | null;
}

interface NoteView {
  id: number;
  noteId: string;
  title: string | null;
  likes: number;
  collects: number;
  comments: number;
  publishedAt: string | null;
  collectedAt: string;
}

interface ViralItemView {
  noteId: string;
  title: string | null;
  likes: number;
  collects: number;
  comments: number;
  publishedAt: string | null;
  engagement: number;
  recencyFactor: number;
  score: number;
}

interface ViralSnapshotView {
  topicId: string;
  generatedAt: string;
  topN: number;
  sampleSize: number;
  items: ViralItemView[];
  rationale: { notes: Record<string, string>; generatedAt: string; model: string | null } | null;
}

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  if (!bridge) throw new Error('bridge missing');
  return (await bridge.invoke(channel, payload)) as T;
}

function gateCard(gate: GateView): HTMLElement {
  const card = document.createElement('article');
  card.className = 'gate-item';
  card.dataset.taskId = gate.taskId;
  card.dataset.gate = gate.gate;
  card.dataset.status = gate.status;

  const head = document.createElement('p');
  head.className = 'gate-item-head';
  head.textContent = `主题：${gate.topic ?? gate.topicId ?? '-'} · 报告 #${gate.reportId ?? '-'} · 任务 ${gate.taskId.slice(0, 8)}…`;
  card.appendChild(head);

  if (gate.gate === 'keyword_confirm' && gate.keywords) {
    const note = document.createElement('p');
    note.className = 'gate-filter-note';
    note.dataset.removedCount = String(gate.keywords.removed.length);
    note.textContent =
      `建议词已经词库 v${gate.keywords.wordlistVersion ?? '?'} 黑名单过滤：` +
      `保留 ${gate.keywords.allowed.length} 条，剔除 ${gate.keywords.removed.length} 条` +
      `（命中留痕 keyword_hits ${gate.keywords.persisted} 行）`;
    card.appendChild(note);

    const listEl = document.createElement('ul');
    listEl.className = 'gate-keyword-list';
    for (const bullet of gate.keywords.allowed) {
      const item = document.createElement('li');
      item.className = 'gate-keyword';
      item.textContent = bullet;
      listEl.appendChild(item);
    }
    card.appendChild(listEl);

    if (gate.keywords.removed.length > 0) {
      const removedEl = document.createElement('p');
      removedEl.className = 'gate-removed-note';
      removedEl.textContent = `已剔除：${gate.keywords.removed.map((r) => `「${r.term}」(${r.kind})`).join('、')}`;
      card.appendChild(removedEl);
    }

    const actions = document.createElement('div');
    actions.className = 'gate-actions';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn btn-primary gate-confirm-btn';
    confirmBtn.dataset.taskId = gate.taskId;
    confirmBtn.textContent = '确认建议词（推进选品任务占位）';
    confirmBtn.addEventListener('click', () => void runGateAction(confirmBtn, 'gate:confirm', gate.taskId));
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'btn btn-ghost gate-reject-btn';
    rejectBtn.dataset.taskId = gate.taskId;
    rejectBtn.textContent = '拒绝（取消该采集任务）';
    rejectBtn.addEventListener('click', () => void runGateAction(rejectBtn, 'gate:reject', gate.taskId));
    actions.append(confirmBtn, rejectBtn);
    card.appendChild(actions);
  } else {
    const hint = document.createElement('p');
    hint.className = 'gate-hint';
    hint.textContent =
      gate.gate === 'llm_key_config'
        ? '未检测到可用的 LLM API Key：请前往「设置 → LLM 服务商与 API Key」保存 Key，然后点「恢复报告步骤」。'
        : '闸门等待中。';
    card.appendChild(hint);
    const actions = document.createElement('div');
    actions.className = 'gate-actions';
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'btn btn-primary gate-resume-btn';
    resumeBtn.dataset.taskId = gate.taskId;
    resumeBtn.textContent = '恢复报告步骤（Key 已配置）';
    resumeBtn.addEventListener('click', () => void runGateAction(resumeBtn, 'tasks:resume', gate.taskId));
    actions.appendChild(resumeBtn);
    card.appendChild(actions);
  }
  return card;
}

async function runGateAction(button: HTMLButtonElement, channel: string, taskId: string): Promise<void> {
  button.disabled = true;
  root.dataset.gateAction = 'pending';
  try {
    await invoke(channel, { taskId });
    root.dataset.gateAction = 'done';
    root.dataset.gateLastAction = `${channel}:${taskId.slice(0, 8)}`;
  } catch (error) {
    root.dataset.gateAction = 'failed';
    root.dataset.gateActionError = String((error as Error).message).slice(0, 160);
  } finally {
    button.disabled = false;
    void refreshGates();
  }
}

export async function refreshGates(): Promise<void> {
  if (!bridge || !gateList || !gateStatus) return;
  try {
    const result = await invoke<{ gates: GateView[] }>('gate:list');
    gateList.textContent = '';
    for (const gate of result.gates) gateList.appendChild(gateCard(gate));
    gateStatus.textContent = result.gates.length === 0 ? '闸门状态：当前无等待确认的闸门。' : `闸门状态：${result.gates.length} 个闸门等待人工确认。`;
    root.dataset.gateLoaded = '1';
    root.dataset.gateCount = String(result.gates.length);
    root.dataset.gateKinds = result.gates.map((g) => g.gate).join(',');
  } catch (error) {
    gateStatus.textContent = `闸门状态：读取失败 ${String((error as Error).message).slice(0, 120)}`;
    root.dataset.gateLoaded = 'error';
  }
}

async function refreshNotes(): Promise<void> {
  if (!bridge || !notesStatus || !notesTable || !notesTbody) return;
  try {
    const result = await invoke<{ notes: NoteView[] }>('notes:list', { limit: 100 });
    notesTbody.textContent = '';
    for (const note of result.notes.slice(0, 50)) {
      const tr = document.createElement('tr');
      for (const cell of [note.title ?? '（无标题）', String(note.likes), String(note.collects), String(note.comments), note.publishedAt ?? '-', note.collectedAt]) {
        const td = document.createElement('td');
        td.textContent = cell;
        tr.appendChild(td);
      }
      notesTbody.appendChild(tr);
    }
    notesTable.hidden = result.notes.length === 0;
    notesStatus.textContent = result.notes.length === 0 ? '（暂无采集笔记）' : `最近 ${result.notes.length} 条采集笔记。`;
    root.dataset.notesLoaded = '1';
    root.dataset.notesCount = String(result.notes.length);
  } catch (error) {
    notesStatus.textContent = `采集列表读取失败：${String((error as Error).message).slice(0, 120)}`;
    root.dataset.notesLoaded = 'error';
  }
}

notesExportCsv?.addEventListener('click', () => {
  void (async () => {
    if (!bridge || !notesCsvStatus) return;
    notesExportCsv.disabled = true;
    root.dataset.notesCsv = 'pending';
    try {
      const result = await invoke<{ notes: NoteView[] }>('notes:list', { limit: 500 });
      const csv = buildCsv(
        ['note_id', 'title', 'likes', 'collects', 'comments', 'published_at', 'collected_at'],
        result.notes.map((n) => [n.noteId, n.title ?? '', n.likes, n.collects, n.comments, n.publishedAt ?? '', n.collectedAt]),
      );
      downloadBlob(`采集列表-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      notesCsvStatus.textContent = `已导出 ${result.notes.length} 行（UTF-8 BOM）。`;
      root.dataset.notesCsv = 'done';
      root.dataset.notesCsvRows = String(result.notes.length);
    } catch (error) {
      notesCsvStatus.textContent = `导出失败：${String((error as Error).message).slice(0, 140)}`;
      root.dataset.notesCsv = 'failed';
    } finally {
      notesExportCsv.disabled = false;
    }
  })();
});

/* ---- 爆款清单（M2 产品卡② = FR-4.7）：读面渲染 + 重算/解读动作 ---- */

function renderViral(snapshot: ViralSnapshotView): void {
  if (!viralList || !viralStatus) return;
  viralList.textContent = '';
  if (snapshot.items.length === 0) {
    viralStatus.textContent = snapshot.topicId
      ? `暂无爆款清单（主题 ${snapshot.topicId} 采集样本 ${snapshot.sampleSize} 条，热度分全 0 或未采集）。`
      : '暂无爆款清单（尚无采集任务）。';
  } else {
    const covered = snapshot.rationale ? Object.keys(snapshot.rationale.notes).length : 0;
    viralStatus.textContent =
      `主题 ${snapshot.topicId} · 样本 ${snapshot.sampleSize} 条 · Top ${snapshot.items.length}` +
      (snapshot.rationale ? ` · 解读 ${covered} 条（${snapshot.rationale.generatedAt.slice(0, 16).replace('T', ' ')}）` : ' · 未生成解读');
  }
  for (const [index, item] of snapshot.items.entries()) {
    const li = document.createElement('li');
    li.className = 'viral-item';
    li.dataset.noteId = item.noteId;
    li.dataset.score = String(item.score);
    const head = document.createElement('p');
    head.className = 'viral-item-head';
    const scoreChip = document.createElement('span');
    scoreChip.className = 'viral-score-chip';
    scoreChip.textContent = `热度 ${item.score}`;
    const titleSpan = document.createElement('span');
    titleSpan.className = 'viral-item-title';
    titleSpan.textContent = `${index + 1}. ${item.title ?? '（无标题）'}`;
    head.append(scoreChip, titleSpan);
    li.appendChild(head);
    const meta = document.createElement('p');
    meta.className = 'viral-item-meta';
    meta.textContent = `赞 ${item.likes} · 藏 ${item.collects} · 评 ${item.comments} · 互动加权 ${item.engagement} · 衰减 ×${item.recencyFactor} · 发布 ${item.publishedAt ?? '未知'}`;
    li.appendChild(meta);
    const reason = snapshot.rationale?.notes[item.noteId];
    if (reason) {
      const reasonEl = document.createElement('p');
      reasonEl.className = 'viral-item-reason';
      reasonEl.textContent = `为什么会爆：${reason}`;
      li.appendChild(reasonEl);
    }
    viralList.appendChild(li);
  }
  root.dataset.viralLoaded = '1';
  root.dataset.viralCount = String(snapshot.items.length);
  root.dataset.viralTopic = snapshot.topicId;
}

async function refreshViral(): Promise<void> {
  if (!bridge || !viralStatus) return;
  try {
    const result = await invoke<{ snapshot: ViralSnapshotView }>('viral:list', {});
    renderViral(result.snapshot);
  } catch (error) {
    viralStatus.textContent = `爆款清单读取失败：${String((error as Error).message).slice(0, 120)}`;
    root.dataset.viralLoaded = 'error';
  }
}

async function runViralAction(button: HTMLButtonElement, channel: 'viral:refresh' | 'viral:generateRationale'): Promise<void> {
  if (!bridge || !viralStatus) return;
  button.disabled = true;
  root.dataset.viralAction = `pending:${channel}`;
  try {
    const result = await invoke<{ snapshot: ViralSnapshotView; llmCall?: boolean; reason?: string | null }>(channel, {});
    renderViral(result.snapshot);
    root.dataset.viralAction = `done:${channel}`;
    if (channel === 'viral:generateRationale') {
      root.dataset.viralLlmCall = String(result.llmCall ?? false);
      if (result.reason) viralStatus.textContent += `（${result.reason}）`;
    }
  } catch (error) {
    root.dataset.viralAction = `failed:${channel}`;
    root.dataset.viralActionError = String((error as Error).message).slice(0, 160);
    viralStatus.textContent = `${channel === 'viral:refresh' ? '重算' : '解读'}失败：${String((error as Error).message).slice(0, 140)}`;
  } finally {
    button.disabled = false;
  }
}

viralRefreshBtn?.addEventListener('click', () => void runViralAction(viralRefreshBtn, 'viral:refresh'));
viralRationaleBtn?.addEventListener('click', () => void runViralAction(viralRationaleBtn, 'viral:generateRationale'));

/** 刷新洞察视图三块数据（闸门 + 爆款清单 + 采集列表）——视图激活时与周期轮询共用 */
export function refreshInsightView(): void {
  void refreshGates();
  void refreshViral();
  void refreshNotes();
}

export function initInsightView(): void {
  refreshInsightView();
  /* 采集在后台推进时列表/闸门需自行跟上（无推送通道；gates 2s 先例，notes 同轮询）；
     爆款快照在 collect-viral 步骤后更新，8s 轮询足够跟上且不与重算动作打架 */
  setInterval(() => void refreshGates(), 2000);
  setInterval(() => void refreshViral(), 8000);
  setInterval(() => void refreshNotes(), 3000);
}

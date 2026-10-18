/**
 * 工作流看板 v1（T-M2-06；FR-7.3 工作流总览页 + 卡片拖拽流转）。
 *
 * - 数据面：products:list（无 status 过滤，上限 500 与 worker 收口一致）——不新增看板通道；
 * - 分列：选品中 = {候选,对接中,已对接}，待发布/推广中/已完成 一一同名（store 六态映射）；
 * - 拖拽流转（P1）：跨列 drop 按矩阵映射通道——→待发布 走 enterPublish（FR-7.2 上下文携带），
 *   其余走 setStatus；同列 drop = no-op；非法迁移主进程稳定错误（E-PRODUCT-*）如实回显并刷新，
 *   不做客户端预判之外的静默兜底。
 * html data-* 标记为 e2e 断言面（沿用壳层既有模式）。
 */
const bridge = window.xinglian;
const root = document.documentElement;

const kanbanEl = document.getElementById('board-kanban');
const statusEl = document.getElementById('board-status');

export interface BoardCard {
  productId: string;
  title: string;
  priceMin: number | null;
  priceMax: number | null;
  sales: number | null;
  supplier: { name: string | null; address: string | null } | null;
  link: string;
  status: string;
  taskId: string;
  keyword: string | null;
  imagePaths: string[];
  updatedAt: string;
}

/** 看板四列（FR-7.3）与商品状态的映射（选品中列 = 选品阶段三内态） */
export const BOARD_COLUMNS: Array<{ stage: string; statuses: string[] }> = [
  { stage: '选品中', statuses: ['候选', '对接中', '已对接'] },
  { stage: '待发布', statuses: ['待发布'] },
  { stage: '推广中', statuses: ['推广中'] },
  { stage: '已完成', statuses: ['已完成'] },
];

function stageOf(status: string): string | null {
  return BOARD_COLUMNS.find((c) => c.statuses.includes(status))?.stage ?? null;
}

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  if (!bridge) throw new Error('bridge missing');
  return (await bridge.invoke(channel, payload)) as T;
}

/** drop 目标列 → (channel, status) 映射；null = 同列/不可判（no-op） */
export function dropAction(fromStatus: string, targetStage: string): { channel: 'products:setStatus' | 'products:enterPublish'; status?: string } | null {
  const fromStage = stageOf(fromStatus);
  if (fromStage === null || fromStage === targetStage) return null;
  if (targetStage === '待发布') {
    // FR-7.2：→待发布 唯一入口 enterPublish（已对接卡；其他前置态由主进程稳定错误拒绝）
    return { channel: 'products:enterPublish' };
  }
  if (targetStage === '选品中') {
    // 撤回语义：拖回选品中 = 回到「已对接」待跟进；矩阵外组合（推广中/已完成 回选品中）
    // 由主进程转场矩阵拒绝并如实回显
    return { channel: 'products:setStatus', status: '已对接' };
  }
  // 推广中/已完成：手动推进（setStatus；矩阵外组合由主进程拒绝）
  return { channel: 'products:setStatus', status: targetStage };
}

function renderCard(card: BoardCard): HTMLElement {
  const el = document.createElement('article');
  el.className = 'kcard';
  el.dataset.productId = card.productId;
  el.dataset.status = card.status;
  el.draggable = true;

  const title = document.createElement('div');
  title.className = 'kt';
  title.textContent = card.title;
  el.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'km';
  const price = card.priceMin !== null ? `¥${card.priceMin}` : '价格—';
  const sales = card.sales !== null ? `${card.sales >= 10_000 ? `${(card.sales / 10_000).toFixed(1)}万` : card.sales}件` : '销量—';
  const bits = [price, sales];
  if (card.supplier?.name) bits.push(card.supplier.name);
  meta.textContent = bits.join(' · ');
  el.appendChild(meta);

  const foot = document.createElement('div');
  foot.className = 'kf';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.dataset.status = card.status;
  tag.textContent = card.status;
  foot.appendChild(tag);
  if (card.imagePaths.length > 0) {
    const mats = document.createElement('span');
    mats.className = 'km-mats';
    mats.textContent = `素材 ${card.imagePaths.length} 张`;
    foot.appendChild(mats);
  }
  el.appendChild(foot);

  el.addEventListener('dragstart', (event) => {
    (event.target as HTMLElement).classList.add('dragging');
    event.dataTransfer?.setData('text/x-product-id', card.productId);
    event.dataTransfer?.setData('text/x-from-status', card.status);
    event.dataTransfer!.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
  });
  return el;
}

function renderColumn(stage: string, cards: BoardCard[]): HTMLElement {
  const col = document.createElement('div');
  col.className = 'col';
  col.dataset.stage = stage;
  col.dataset.count = String(cards.length);

  const head = document.createElement('div');
  head.className = 'col-h';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = stage;
  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = String(cards.length);
  head.append(t, n);
  col.appendChild(head);

  for (const card of cards) col.appendChild(renderCard(card));

  col.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    col.classList.add('drag-over');
  });
  col.addEventListener('dragleave', () => {
    col.classList.remove('drag-over');
  });
  col.addEventListener('drop', (event) => {
    event.preventDefault();
    col.classList.remove('drag-over');
    const productId = event.dataTransfer?.getData('text/x-product-id');
    const fromStatus = event.dataTransfer?.getData('text/x-from-status');
    if (!productId || !fromStatus) return;
    const action = dropAction(fromStatus, stage);
    if (!action) return;
    void moveCard(productId, action);
  });
  return col;
}

/** 拖拽落点执行：非法迁移/未对接等稳定错误如实回显（不静默），成功后刷新全板 */
async function moveCard(productId: string, action: { channel: 'products:setStatus' | 'products:enterPublish'; status?: string }): Promise<void> {
  root.dataset.boardMove = 'pending';
  try {
    await invoke(action.channel, action.channel === 'products:enterPublish' ? { productId } : { productId, status: action.status });
    root.dataset.boardMove = 'done';
  } catch (error) {
    const message = String((error as Error).message);
    root.dataset.boardMove = 'failed';
    root.dataset.boardMoveError = message.slice(0, 200);
    if (statusEl) statusEl.textContent = `流转被拒绝：${message.slice(0, 120)}`;
  }
  await refreshBoardView();
}

export async function refreshBoardView(): Promise<void> {
  if (!kanbanEl) return;
  try {
    const result = await invoke<{ products: BoardCard[] }>('products:list', { limit: 500 });
    const byStage = new Map<string, BoardCard[]>(BOARD_COLUMNS.map((c) => [c.stage, []]));
    for (const card of result.products) {
      const stage = stageOf(card.status);
      if (stage) byStage.get(stage)?.push(card);
    }
    kanbanEl.textContent = '';
    for (const col of BOARD_COLUMNS) {
      kanbanEl.appendChild(renderColumn(col.stage, byStage.get(col.stage) ?? []));
    }
    if (statusEl) statusEl.textContent = `共 ${result.products.length} 个商品卡片——拖拽卡片流转工作流阶段`;
    root.dataset.boardLoaded = '1';
    root.dataset.boardTotal = String(result.products.length);
  } catch (error) {
    console.warn('[renderer] products:list (board) failed:', error);
    root.dataset.boardLoaded = 'error';
    if (statusEl) statusEl.textContent = `看板数据读取失败：${String(error).slice(0, 120)}`;
  }
}

export function initBoardView(): void {
  void refreshBoardView();
}

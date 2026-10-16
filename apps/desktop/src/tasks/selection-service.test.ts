/**
 * selection 管道单测（T-M2-03 + T-M2-03b 工程面；内存 store + 真 runner 状态机 + fake 检索端口）：
 * - 关键词解析："词——理由" 拆分 / 去重 / 上限 5 / 空词过滤；
 * - 端到端：queued 占位任务（gate confirm 产物形态）→ startQueued 起跑 →
 *   三步检查点 completed → sourcing_candidates 落库（rank/维度分 JSON）+ stats kv；
 * - 登录守卫（T-M2-03b）：全推荐流 → awaiting_user + sourcing_login 三值闸门 + 通知 +
 *   stats 证据保留；登录后 resume → completed + 挂起指针清理；混合/全空不触发；
 * - runner.startQueued 守卫：非 queued 拒绝 / 未注册 kind 拒绝。
 */
import { describe, expect, it } from 'vitest';
import type { Logger } from '@xinglian/logger';
import type { SourcingCandidate } from '@xinglian/agents';
import {
  SelectionService,
  SELECTION_KIND,
  createFixtureSearchPort,
  normalizeSelectionKeywords,
  parseSelectionKeyword,
} from './selection-service';
import { createTaskRunner } from './runner';
import type { StoreClient, SourcingCandidateInput, SourcingCandidateRowView, TaskRowView } from '../store';

const silentLogger: Logger = {
  log: () => {},
  userAction: () => {},
  automationStep: () => {},
  llmCall: () => {},
  networkMeta: () => {},
  systemError: () => {},
  child: () => silentLogger,
  startSpan: () => ({ spanId: 'span', logger: silentLogger, end: () => {} }),
  categories: [],
  getBuffer: () => [],
  enforceRetention: async () => ({ prunedFiles: 0, freedBytes: 0 }),
  flush: async () => {},
  close: async () => {},
} as unknown as Logger;

/* ------------------------------ 内存 store（selection 面最小镜像） ------------------------------ */

function makeMemoryStore(): { store: StoreClient; state: { candidates: SourcingCandidateRowView[]; kv: Map<string, string | Buffer>; steps: Map<string, Array<{ stepId: string; status: string; output: unknown }>> } } {
  const tasks = new Map<string, TaskRowView>();
  const events: Array<{ taskId: string; type: string }> = [];
  const kv = new Map<string, string | Buffer>();
  const steps = new Map<string, Array<{ stepId: string; status: string; output: unknown }>>();
  const candidates: SourcingCandidateRowView[] = [];
  let idSeq = 1;
  const store = {
    whenReady: async () => 4,
    createTask: async (task: { id: string; kind: string; payload?: unknown }) => {
      const nowIso = new Date().toISOString();
      tasks.set(task.id, { id: task.id, kind: task.kind, status: 'idle', payload: task.payload ?? null, createdAt: nowIso, updatedAt: nowIso });
      return { created: true, taskId: task.id };
    },
    updateTaskStatus: async (u: { taskId: string; status: string }) => {
      const t = tasks.get(u.taskId);
      if (t) t.status = u.status as TaskRowView['status'];
      return { updated: true, taskId: u.taskId, status: u.status as TaskRowView['status'] };
    },
    writeTaskEvent: async (e: { taskId: string; type: string }) => {
      events.push({ taskId: e.taskId, type: e.type });
      return { written: true };
    },
    upsertStep: async (s: { taskId: string; stepId: string; status: string; output?: unknown }) => {
      const list = steps.get(s.taskId) ?? [];
      const existing = list.find((x) => x.stepId === s.stepId);
      if (existing) {
        existing.status = s.status;
        existing.output = s.output ?? existing.output;
      } else {
        list.push({ stepId: s.stepId, status: s.status, output: s.output ?? null });
      }
      steps.set(s.taskId, list);
      return { upserted: true };
    },
    getTask: async (taskId: string) => tasks.get(taskId) ?? null,
    listTasks: async (status?: string) => [...tasks.values()].filter((t) => status === undefined || t.status === status),
    listSteps: async (taskId: string) =>
      (steps.get(taskId) ?? []).map((s, i) => ({ taskId, stepId: s.stepId, seq: i + 1, status: s.status as 'running' | 'completed' | 'failed', output: s.output, checkpointAt: null })),
    listTaskEvents: async () => [],
    kvSet: async (k: string, v: string | Buffer) => {
      kv.set(k, v);
      return { set: true };
    },
    kvGet: async (k: string) => kv.get(k) ?? null,
    kvDel: async (k: string) => ({ deleted: kv.delete(k) }),
    insertSourcingCandidates: async (rows: SourcingCandidateInput[]) => {
      // 幂等替换语义镜像：同 taskId 先删后插
      for (let i = candidates.length - 1; i >= 0; i -= 1) if (candidates[i].taskId === rows[0]?.taskId) candidates.splice(i, 1);
      for (const r of rows) {
        candidates.push({
          id: idSeq++,
          taskId: r.taskId,
          selectionId: r.selectionId,
          rank: r.rank,
          offerId: r.offerId,
          keyword: r.keyword,
          total: r.total,
          dimensions: r.dimensions,
          title: r.title,
          priceText: r.priceText ?? null,
          salesText: r.salesText ?? null,
          supplierName: r.supplierName ?? null,
          supplierAddress: r.supplierAddress ?? null,
          sourceUrl: r.sourceUrl ?? null,
          createdAt: new Date().toISOString(),
        });
      }
      return { inserted: rows.length };
    },
    listSourcingCandidates: async (filter?: { taskId?: string; limit?: number }) =>
      candidates
        .filter((c) => filter?.taskId === undefined || c.taskId === filter.taskId)
        .sort((a, b) => a.rank - b.rank)
        .slice(0, filter?.limit ?? 50),
  } as unknown as StoreClient;
  return { store, state: { candidates, kv, steps } };
}

/* ------------------------------ 用例 ------------------------------ */

function cand(offerId: string, title: string, over: Partial<SourcingCandidate> = {}): SourcingCandidate {
  return {
    offerId,
    title,
    priceText: '¥10.00',
    salesText: '月销100+',
    supplierName: '义乌市某某服饰有限公司',
    supplierAddress: '浙江 金华 义乌市',
    galleryCount: 5,
    sourceUrl: `https://detail.1688.com/offer/${offerId}.html`,
    ...over,
  };
}

describe('selection-service（T-M2-03）', () => {
  it('关键词解析：「词——理由」拆分；去重/上限 5/空词过滤', () => {
    expect(parseSelectionKeyword('防晒帽 UPF50+——选购攻略类笔记把国标列为核心门槛')).toEqual({
      term: '防晒帽 UPF50+',
      rationale: '选购攻略类笔记把国标列为核心门槛',
    });
    expect(parseSelectionKeyword('无分隔符的词')).toEqual({ term: '无分隔符的词' });
    expect(parseSelectionKeyword('——前空')).toEqual({ term: '——前空' });

    const normalized = normalizeSelectionKeywords(['防晒衣——主词根', '防晒衣——重复词', '', '  ', '冰丝防晒衣', '防晒帽', '防晒裙', '防晒口罩', '防晒四件套']);
    expect(normalized.map((k) => k.term)).toEqual(['防晒衣', '冰丝防晒衣', '防晒帽', '防晒裙', '防晒口罩']);
  });

  it('端到端：queued 占位任务起跑 → completed；候选落库（rank+维度 JSON）+ stats kv + 三步检查点', async () => {
    const { store, state } = makeMemoryStore();
    const runner = createTaskRunner({ store, logger: silentLogger, stepDelayMs: 0, delay: async () => {} });
    // gate confirm 产物形态：createTask + queued 占位（report-service confirmGate 同款）
    await store.createTask({
      id: 'sel-1',
      kind: SELECTION_KIND,
      payload: { selection: { topic: 'pilot-1', topicId: 'pilot-1', reportId: 5, idempotencyKey: 'k1', keywords: ['冰丝防晒衣——主词根', '防晒帽——配饰'] } },
    });
    await store.updateTaskStatus({ taskId: 'sel-1', status: 'queued' });

    const port = createFixtureSearchPort({
      冰丝防晒衣: [cand('8801', '冰丝防晒衣女夏季UPF50+'), cand('8802', '冰丝防晒衣男款透气', { priceText: '¥15.00 ~ 20.00' })],
      防晒帽: [cand('9901', '防晒帽大檐折叠')],
    });
    const service = new SelectionService({ store, runner, logger: silentLogger, searchPort: port, topN: 30 });

    const started = await service.startQueued();
    expect(started).toEqual(['sel-1']);
    // 驱动完成（drive 异步；stepDelayMs=0 很快收敛）
    await new Promise((r) => setTimeout(r, 50));
    const task = await store.getTask('sel-1');
    expect(task?.status).toBe('completed');

    // 候选落库：TopN 3 条，rank 连续，维度 JSON 可回放
    const rows = state.candidates.filter((c) => c.taskId === 'sel-1');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.rank).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    const dims = rows[0].dimensions as Array<{ name: string; score: number; reason: string }>;
    expect(dims.map((d) => d.name)).toEqual(['relevance', 'price', 'sales', 'supplier', 'gallery']);
    expect(dims.every((d) => d.reason.length > 2)).toBe(true);

    // stats kv + 三步检查点
    const statsRaw = state.kv.get('selection:stats:sel-1');
    expect(statsRaw).toBeTruthy();
    const stats = JSON.parse(statsRaw as string);
    expect(stats.stats.totalScored).toBe(3);
    expect(stats.stats.keywords.map((k: { term: string }) => k.term)).toEqual(['冰丝防晒衣', '防晒帽']);
    const steps = state.steps.get('sel-1') ?? [];
    expect(steps.filter((s) => s.status === 'completed').map((s) => s.stepId)).toEqual([
      'selection-retrieve',
      'selection-score',
      'selection-persist',
    ]);
  });

  it('登录守卫（T-M2-03b）：端口全返无关卡片（推荐流铁证）→ awaiting_user + sourcing_login 闸门 + 通知 + stats 证据保留', async () => {
    const { store, state } = makeMemoryStore();
    const runner = createTaskRunner({ store, logger: silentLogger, stepDelayMs: 0, delay: async () => {} });
    await store.createTask({
      id: 'sel-2',
      kind: SELECTION_KIND,
      payload: { selection: { topic: 'pilot-1', topicId: 'pilot-1', reportId: 5, idempotencyKey: 'k2', keywords: ['冰丝防晒衣'] } },
    });
    await store.updateTaskStatus({ taskId: 'sel-2', status: 'queued' });

    const port = createFixtureSearchPort({
      冰丝防晒衣: [cand('junk1', '手持松土两齿叉种花工具'), cand('junk2', '不锈钢豆芽叉子套装')],
    });
    const notified: Array<{ title: string; body: string }> = [];
    const service = new SelectionService({
      store, runner, logger: silentLogger, searchPort: port,
      notify: (title, body) => notified.push({ title, body }),
    });

    await service.startQueued();
    await new Promise((r) => setTimeout(r, 50));
    const task = await store.getTask('sel-2');
    expect(task?.status).toBe('awaiting_user');
    // 闸门挂起记录（三值枚举第三值）+ 候选零行
    const pending = JSON.parse((state.kv.get('gate:pending:sel-2') as string) ?? 'null');
    expect(pending?.gate).toBe('sourcing_login');
    expect(pending?.topic).toBe('pilot-1');
    expect(state.candidates.filter((c) => c.taskId === 'sel-2')).toHaveLength(0);
    // 可观测证据保留：excludedJunk 计数 + loginGate 标记
    const stats = JSON.parse((state.kv.get('selection:stats:sel-2') as string) ?? '{}');
    expect(stats.loginGate).toBe(true);
    expect(stats.stats.keywords[0].excludedJunk).toBe(2);
    // 桌面通知引导（含「不接触账号密码」口径）
    expect(notified).toHaveLength(1);
    expect(notified[0]!.title).toContain('登录 1688');
    expect(notified[0]!.body).toContain('不接触账号密码');
  });

  it('登录守卫恢复链：登录后 resume → 检索真实结果 → completed + 候选落库 + 挂起指针清理', async () => {
    const { store, state } = makeMemoryStore();
    const runner = createTaskRunner({ store, logger: silentLogger, stepDelayMs: 0, delay: async () => {} });
    await store.createTask({
      id: 'sel-5',
      kind: SELECTION_KIND,
      payload: { selection: { topic: 'pilot-1', topicId: 'pilot-1', reportId: 5, idempotencyKey: 'k5', keywords: ['冰丝防晒衣'] } },
    });
    await store.updateTaskStatus({ taskId: 'sel-5', status: 'queued' });

    // 可变端口：首轮全推荐流（匿名）→ 模拟用户登录后返回真实相关卡
    let loggedIn = false;
    const port = {
      async search(keyword: string, limit: number) {
        const rows = loggedIn
          ? [cand('8801', '冰丝防晒衣女夏季UPF50+ 冰丝凉感'), cand('8802', '冰丝防晒衣男款透气轻薄')]
          : [cand('junk1', '手持松土两齿叉种花工具')];
        return rows.slice(0, limit);
      },
    };
    const service = new SelectionService({ store, runner, logger: silentLogger, searchPort: port });

    await service.startQueued();
    await new Promise((r) => setTimeout(r, 50));
    expect((await store.getTask('sel-5'))?.status).toBe('awaiting_user');

    loggedIn = true;
    await runner.resume('sel-5');
    await new Promise((r) => setTimeout(r, 80));
    expect((await store.getTask('sel-5'))?.status).toBe('completed');
    expect(state.candidates.filter((c) => c.taskId === 'sel-5')).toHaveLength(2);
    // 正常完成收尾：挂起指针清理（幂等）
    expect(state.kv.has('gate:pending:sel-5')).toBe(false);
  });

  it('混合口径：同词 junk + 真实卡并存（retained>0）→ 不触发登录闸门，正常 completed', async () => {
    const { store, state } = makeMemoryStore();
    const runner = createTaskRunner({ store, logger: silentLogger, stepDelayMs: 0, delay: async () => {} });
    await store.createTask({
      id: 'sel-6',
      kind: SELECTION_KIND,
      payload: { selection: { topic: 't', topicId: 't', reportId: 1, idempotencyKey: 'k6', keywords: ['冰丝防晒衣'] } },
    });
    await store.updateTaskStatus({ taskId: 'sel-6', status: 'queued' });

    const port = createFixtureSearchPort({
      冰丝防晒衣: [cand('junk1', '手持松土两齿叉种花工具'), cand('8801', '冰丝防晒衣女夏季UPF50+')],
    });
    const service = new SelectionService({ store, runner, logger: silentLogger, searchPort: port });
    await service.startQueued();
    await new Promise((r) => setTimeout(r, 50));
    expect((await store.getTask('sel-6'))?.status).toBe('completed');
    expect(state.candidates.filter((c) => c.taskId === 'sel-6')).toHaveLength(1);
    expect(state.kv.has('gate:pending:sel-6')).toBe(false);
  });

  it('全空检索（candidates=0，登录墙中止/确无结果）→ 不臆造不挂闸门，completed + 零候选（诚实口径保留）', async () => {
    const { store, state } = makeMemoryStore();
    const runner = createTaskRunner({ store, logger: silentLogger, stepDelayMs: 0, delay: async () => {} });
    await store.createTask({
      id: 'sel-7',
      kind: SELECTION_KIND,
      payload: { selection: { topic: 't', topicId: 't', reportId: 1, idempotencyKey: 'k7', keywords: ['冷门词xyz'] } },
    });
    await store.updateTaskStatus({ taskId: 'sel-7', status: 'queued' });

    const service = new SelectionService({ store, runner, logger: silentLogger, searchPort: createFixtureSearchPort({}) });
    await service.startQueued();
    await new Promise((r) => setTimeout(r, 50));
    expect((await store.getTask('sel-7'))?.status).toBe('completed');
    expect(state.candidates.filter((c) => c.taskId === 'sel-7')).toHaveLength(0);
    expect(state.kv.has('gate:pending:sel-7')).toBe(false);
  });

  it('runner.startQueued 守卫：非 queued 拒绝；未注册 kind 拒绝', async () => {
    const { store } = makeMemoryStore();
    const runner = createTaskRunner({ store, logger: silentLogger, stepDelayMs: 0, delay: async () => {} });
    await store.createTask({ id: 'sel-3', kind: SELECTION_KIND, payload: { selection: { topic: 't', topicId: 't', reportId: 1, idempotencyKey: 'k', keywords: ['词'] } } });
    await store.updateTaskStatus({ taskId: 'sel-3', status: 'completed' });
    await expect(runner.startQueued('sel-3')).rejects.toThrow(/仅 queued 可起跑/);

    await store.createTask({ id: 'sel-4', kind: 'unknown-kind', payload: {} });
    await store.updateTaskStatus({ taskId: 'sel-4', status: 'queued' });
    await expect(runner.startQueued('sel-4')).rejects.toThrow(/未注册处理器/);
  });

  it('幂等替换：同任务重跑（resume completed 不可达，直接再造同 id 场景经 insertSourcingCandidates）候选不叠行', async () => {
    const { store, state } = makeMemoryStore();
    const rows1: SourcingCandidateInput[] = [
      { taskId: 'sel-x', selectionId: 's1', rank: 1, offerId: 'a', keyword: 'k', total: 80, dimensions: [], title: 'A' },
      { taskId: 'sel-x', selectionId: 's1', rank: 2, offerId: 'b', keyword: 'k', total: 70, dimensions: [], title: 'B' },
    ];
    await store.insertSourcingCandidates(rows1);
    const rows2: SourcingCandidateInput[] = [
      { taskId: 'sel-x', selectionId: 's2', rank: 1, offerId: 'c', keyword: 'k', total: 90, dimensions: [], title: 'C' },
    ];
    await store.insertSourcingCandidates(rows2);
    expect(state.candidates.filter((c) => c.taskId === 'sel-x')).toHaveLength(1);
    expect(state.candidates[0].offerId).toBe('c');
  });
});

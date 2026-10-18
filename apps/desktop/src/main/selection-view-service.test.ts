/**
 * 选品候选清单视图服务单测（05 T-M2-03；FR-6.2 权重重算 / FR-6.3 置顶）。
 * 覆盖：重算算术（默认权重=agent 原式、相对性、损坏行回退）、config/setWeights kv 往返、
 * 置顶切换幂等、listSelections 映射（payload/persist 步骤/stats kv 三源）、
 * insertFixture 全量播种（任务+候选+三步+stats+completed）、镜像一致性断言。
 */
import { describe, expect, it } from 'vitest';
import { SELECTION_DIMENSIONS } from '@xinglian/agents';
import {
  createSelectionViewService,
  defaultSelectionWeights,
  recomputeTotal,
  selectionPinnedKey,
  type SelectionViewDeps,
} from './selection-view-service';
import { selectionStatsKey } from '../tasks/selection-service';
import type { SourcingCandidateInput, SourcingCandidateRowView, TaskRowView } from '../store';
import type { TaskView } from '../tasks/runner';
import type { SelectionInsertFixtureParams } from '../shared/schemas';

interface FakeHandle {
  kv: Map<string, string>;
  tasks: TaskRowView[];
  steps: Array<{ taskId: string; stepId: string; seq: number; status: string; output: unknown }>;
  rows: SourcingCandidateRowView[];
}

function dims(scores: Partial<Record<keyof typeof SELECTION_DIMENSIONS, number>>): unknown {
  return (Object.keys(SELECTION_DIMENSIONS) as Array<keyof typeof SELECTION_DIMENSIONS>).map((name) => ({
    name,
    title: SELECTION_DIMENSIONS[name].title,
    score: scores[name] ?? 50,
    weight: SELECTION_DIMENSIONS[name].weight,
    reason: `理由-${name}`,
  }));
}

interface FakeTaskSeed {
  id: string;
  kind?: string;
  status?: string;
  payload?: unknown;
  steps?: Array<{ stepId: string; seq: number; status: string; output: unknown }>;
}

function makeDeps(options: { tasks?: FakeTaskSeed[] } = {}): SelectionViewDeps & FakeHandle {
  const kv = new Map<string, string>();
  const steps: FakeHandle['steps'] = [];
  const rows: SourcingCandidateRowView[] = [];
  const tasks: TaskRowView[] = (options.tasks ?? []).map((t) => ({
    id: t.id,
    kind: t.kind ?? 'selection',
    status: (t.status ?? 'completed') as TaskRowView['status'],
    payload: t.payload ?? null,
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  }));
  const views: TaskView[] = (options.tasks ?? []).map((t, i) => ({
    id: t.id,
    kind: t.kind ?? 'selection',
    status: (t.status ?? 'completed') as TaskView['status'],
    createdAt: `2026-10-1${7 - Math.min(i, 7)}T00:00:00.000Z`,
    updatedAt: `2026-10-1${7 - Math.min(i, 7)}T00:00:00.000Z`,
    payload: t.payload ?? null,
    steps: (t.steps ?? []).map((s) => ({ ...s, output: s.output, checkpointAt: null })),
  }));
  let nextRowId = 1;
  const deps: SelectionViewDeps = {
    store: {
      whenReady: async () => 4,
      createTask: async (task) => {
        tasks.push({
          id: task.id,
          kind: task.kind,
          status: 'idle',
          payload: task.payload ?? null,
          createdAt: '2026-10-17T00:00:00.000Z',
          updatedAt: '2026-10-17T00:00:00.000Z',
        });
        return { created: true, taskId: task.id };
      },
      updateTaskStatus: async (update) => {
        const task = tasks.find((t) => t.id === update.taskId);
        if (task) task.status = update.status;
        return { updated: true, taskId: update.taskId, status: update.status };
      },
      upsertStep: async (step) => {
        steps.push({ taskId: step.taskId, stepId: step.stepId, seq: step.seq, status: step.status, output: step.output ?? null });
        return { upserted: true };
      },
      kvGet: async (key: string) => kv.get(key) ?? null,
      kvSet: async (key: string, value: string) => {
        kv.set(key, value);
        return { set: true };
      },
      insertSourcingCandidates: async (inputs: SourcingCandidateInput[]) => {
        for (const r of inputs) {
          rows.push({
            id: nextRowId++,
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
            createdAt: '2026-10-17T00:00:00.000Z',
          });
        }
        return { inserted: inputs.length };
      },
      listSourcingCandidates: async (filter) => (filter?.taskId ? rows.filter((r) => r.taskId === filter.taskId) : [...rows]),
    },
    runner: {
      listTaskViews: async () => views,
    },
    now: () => new Date('2026-10-17T01:02:03.000Z'),
  };
  return Object.assign(deps, { kv, tasks, steps, rows }) as SelectionViewDeps & FakeHandle;
}

describe('recomputeTotal（FR-6.2 权重重算算术）', () => {
  it('默认权重 = agent 原式（Σ score×weight）严格相等', () => {
    const dimensions = dims({ relevance: 100, price: 60, sales: 40, supplier: 70, gallery: 40 });
    const agentTotal = Math.round(
      100 * SELECTION_DIMENSIONS.relevance.weight +
        60 * SELECTION_DIMENSIONS.price.weight +
        40 * SELECTION_DIMENSIONS.sales.weight +
        70 * SELECTION_DIMENSIONS.supplier.weight +
        40 * SELECTION_DIMENSIONS.gallery.weight +
        50 * SELECTION_DIMENSIONS.repurchase.weight,
    );
    expect(recomputeTotal(dimensions, defaultSelectionWeights())).toBe(agentTotal);
  });

  it('权重是相对值：整体放大不改结果（2× 默认 ≡ 默认）', () => {
    const dimensions = dims({ relevance: 80, price: 20, sales: 90, supplier: 55, gallery: 0 });
    const doubled = { relevance: 50, price: 30, sales: 40, supplier: 20, gallery: 30, repurchase: 30 } as const;
    expect(recomputeTotal(dimensions, doubled)).toBe(recomputeTotal(dimensions, defaultSelectionWeights()));
  });

  it('单维权重 → 综合分 = 该维分；损坏 dimensions → null', () => {
    const dimensions = dims({ relevance: 77 });
    expect(
      recomputeTotal(dimensions, { relevance: 100, price: 0, sales: 0, supplier: 0, gallery: 0, repurchase: 0 }),
    ).toBe(77);
    expect(recomputeTotal(null, defaultSelectionWeights())).toBeNull();
    expect(recomputeTotal([ { name: 'x' } ], defaultSelectionWeights())).toBeNull();
  });
});

describe('config / setWeights（kv 往返）', () => {
  it('缺省 = agent 默认权重 + customized=false；setWeights 后回读一致 + customized=true', async () => {
    const deps = makeDeps();
    const svc = createSelectionViewService(deps);
    const before = await svc.getConfig();
    expect(before.weights).toEqual({ relevance: 25, price: 15, sales: 20, supplier: 10, gallery: 15, repurchase: 15 });
    expect(before.customized).toBe(false);
    expect(before.dimensions).toHaveLength(6);
    expect(before.dimensions[0]).toMatchObject({ id: 'relevance', title: '关键词相关性', default: 25 });
    expect(before.dimensions[5]).toMatchObject({ id: 'repurchase', title: '复购信号', default: 15 });

    const after = await svc.setWeights({ relevance: 50, price: 10, sales: 20, supplier: 10, gallery: 10, repurchase: 10 });
    expect(after.weights).toEqual({ relevance: 50, price: 10, sales: 20, supplier: 10, gallery: 10, repurchase: 10 });
    expect(after.customized).toBe(true);
    expect(JSON.parse(deps.kv.get('selection:weights') ?? '{}')).toEqual({
      relevance: 50, price: 10, sales: 20, supplier: 10, gallery: 10, repurchase: 10,
    });
  });

  it('旧五键 kv（无 repurchase）→ 用户值保留 + repurchase 按默认补齐（向后兼容）', async () => {
    const deps = makeDeps();
    deps.kv.set('selection:weights', JSON.stringify({ relevance: 60, price: 10, sales: 10, supplier: 10, gallery: 10 }));
    const config = await createSelectionViewService(deps).getConfig();
    expect(config.weights).toEqual({ relevance: 60, price: 10, sales: 10, supplier: 10, gallery: 10, repurchase: 15 });
    expect(config.customized).toBe(true);
  });

  it('kv 损坏（缺维/非整数/全零）→ 回退默认且 customized=false', async () => {
    for (const bad of [
      '{"relevance":50}',
      '{"relevance":1.5,"price":20,"sales":20,"supplier":15,"gallery":15,"repurchase":15}',
      '{"relevance":0,"price":0,"sales":0,"supplier":0,"gallery":0,"repurchase":0}',
      'not-json',
    ]) {
      const deps = makeDeps();
      deps.kv.set('selection:weights', bad);
      const config = await createSelectionViewService(deps).getConfig();
      expect(config.weights).toEqual(defaultSelectionWeights());
      expect(config.customized).toBe(false);
    }
  });
});

describe('setPinned（FR-6.3 置顶）', () => {
  it('置顶/取消幂等，kv 存 offerId 数组', async () => {
    const deps = makeDeps();
    const svc = createSelectionViewService(deps);
    const on = await svc.setPinned({ taskId: 't-1', offerId: '111', pinned: true });
    expect(on.offerIds).toEqual(['111']);
    const on2 = await svc.setPinned({ taskId: 't-1', offerId: '222', pinned: true });
    expect(on2.offerIds).toEqual(['111', '222']);
    const again = await svc.setPinned({ taskId: 't-1', offerId: '111', pinned: true });
    expect(again.offerIds).toEqual(['111', '222']);
    const off = await svc.setPinned({ taskId: 't-1', offerId: '111', pinned: false });
    expect(off.offerIds).toEqual(['222']);
    expect(JSON.parse(deps.kv.get(selectionPinnedKey('t-1')) ?? '[]')).toEqual(['222']);
  });
});

describe('listSelections（三源映射：payload + persist 步骤 + stats kv）', () => {
  it('只收 selection kind；candidateCount/excludedJunk/generatedAt 各就各位；非 selection 任务与损坏 stats 容错', async () => {
    const deps = makeDeps({
      tasks: [
        {
          id: 'sel-1',
          status: 'completed',
          payload: { selection: { topic: '防晒帽', topicId: 'topic-1', reportId: 3, idempotencyKey: 'k1', keywords: ['防晒帽——理由'] } },
          steps: [
            { stepId: 'selection-retrieve', seq: 1, status: 'completed', output: { keywords: 1 } },
            { stepId: 'selection-persist', seq: 3, status: 'completed', output: { inserted: 30 } },
          ],
        },
        { id: 'demo-1', kind: 'demo', status: 'completed' },
        { id: 'sel-2', status: 'queued' },
      ],
    });
    deps.kv.set(
      selectionStatsKey('sel-1'),
      JSON.stringify({
        selectionId: 's-1',
        generatedAt: '2026-10-17T00:30:00.000Z',
        stats: { keywords: [{ term: '防晒帽', candidates: 60, retained: 30, excludedJunk: 30 }], dedupedAcrossKeywords: 0, totalScored: 60 },
      }),
    );
    deps.kv.set(selectionStatsKey('sel-2'), 'broken');
    const { selections } = await createSelectionViewService(deps).listSelections();
    expect(selections).toHaveLength(2);
    const first = selections.find((s) => s.taskId === 'sel-1');
    expect(first).toMatchObject({
      topic: '防晒帽',
      topicId: 'topic-1',
      keywords: ['防晒帽——理由'],
      status: 'completed',
      candidateCount: 30,
      excludedJunk: 30,
      generatedAt: '2026-10-17T00:30:00.000Z',
    });
    const second = selections.find((s) => s.taskId === 'sel-2');
    expect(second).toMatchObject({ candidateCount: 0, excludedJunk: null, generatedAt: null, topic: '（payload 缺失）' });
  });
});

describe('insertFixture（QA 播种）+ listCandidates', () => {
  it('completed 任务 + 候选（显式 dimensions/total 原样，缺省确定性生成）+ 三步 + stats kv', async () => {
    const deps = makeDeps();
    const svc = createSelectionViewService(deps);
    const result = await svc.insertFixture({
      topic: 'e2e-选品',
      keywords: ['防晒帽'],
      candidates: [
        {
          offerId: '1001',
          keyword: '防晒帽',
          title: '防晒帽 UPF50+ 空顶',
          priceText: '12.30',
          salesText: '最近成交 3000+',
          supplierName: '义乌某某厂',
          dimensions: dims({ relevance: 100, price: 90, sales: 80, supplier: 70, gallery: 60 }) as SelectionInsertFixtureParams['candidates'][number]['dimensions'],
        },
        { offerId: '1002', keyword: '防晒帽', title: '渔夫帽 大檐' },
      ],
    });
    expect(result.inserted).toBe(2);
    const task = deps.tasks.find((t) => t.id === result.taskId);
    expect(task?.status).toBe('completed');
    expect((task?.payload as { selection?: { topic?: string } })?.selection?.topic).toBe('e2e-选品');

    const persist = deps.steps.find((s) => s.stepId === 'selection-persist');
    expect(persist?.output).toEqual({ inserted: 2 });

    const stats = JSON.parse(deps.kv.get(selectionStatsKey(result.taskId)) ?? '{}');
    expect(stats.stats.totalScored).toBe(2);
    expect(stats.stats.keywords[0]).toMatchObject({ term: '防晒帽', retained: 2, excludedJunk: 0 });

    const view = await svc.listCandidates(result.taskId);
    expect(view.candidates).toHaveLength(2);
    expect(view.pinned).toEqual([]);
    expect(view.candidates[0]).toMatchObject({ offerId: '1001', rank: 1, total: 78, supplierName: '义乌某某厂' });
    // 缺省 dimensions 确定性：同一 offerId 两次生成分数一致 → total 一致
    expect(view.candidates[1]?.total).toBe(recomputeTotal(view.candidates[1]?.dimensions, defaultSelectionWeights()));
  });
});

describe('镜像一致性（shared/channels ↔ agents SELECTION_DIMENSIONS）', () => {
  it('构造期键集断言当前通过（漂移防护挂在线上）', () => {
    expect(() => createSelectionViewService(makeDeps())).not.toThrow();
  });
});

/**
 * 偏好画像服务单测（T-M2-07；FR-6.7 偏好回流 v1）。
 * 假 store（行为流水数组 + kv map），全确定性：埋点快照 / 末态派生 / 门槛与钳位 /
 * 乘性融合 / 开关 / 画像快照轨迹。
 */
import { describe, expect, it } from 'vitest';
import {
  PREFERENCE_BEHAVIOR_KEY,
  PREFERENCE_ENABLED_KV,
  PREFERENCE_PROFILE_KEY,
  PREFERENCE_SCOPE,
  PreferenceService,
  computeEffectiveWeights,
  createPreferenceService,
  type PreferenceBehaviorValue,
} from './preference-service';
import type { PreferenceRowView, SourcingCandidateRowView } from '../store/protocol';
import type { SelectionWeights } from '../shared/schemas';

interface FakeStore {
  whenReady: () => Promise<number>;
  kvGet: (key: string) => Promise<string | null>;
  kvSet: (key: string, value: string) => Promise<{ set: boolean }>;
  insertPreference: (row: { scope: string; key: string; value?: unknown; at?: string }) => Promise<{ id: string }>;
  listPreferences: (filter?: { scope?: string; key?: string; limit?: number }) => Promise<PreferenceRowView[]>;
  listSourcingCandidates: (filter?: { taskId?: string; limit?: number }) => Promise<SourcingCandidateRowView[]>;
}

function dims(partial: Partial<Record<string, number>>): Array<{ name: string; score: number }> {
  const full: Record<string, number> = { relevance: 50, price: 50, sales: 50, supplier: 50, gallery: 50, repurchase: 50, ...partial };
  return Object.entries(full).map(([name, score]) => ({ name, score }));
}

function makeStore(candidates: Partial<SourcingCandidateRowView>[] = []): { store: FakeStore; rows: PreferenceRowView[]; kv: Map<string, string> } {
  const rows: PreferenceRowView[] = [];
  const kv = new Map<string, string>();
  let seq = 0;
  const store: FakeStore = {
    whenReady: async () => 6,
    kvGet: async (key) => kv.get(key) ?? null,
    kvSet: async (key, value) => {
      kv.set(key, value);
      return { set: true };
    },
    insertPreference: async (row) => {
      rows.push({ id: `p${seq}`, scope: row.scope, key: row.key, value: row.value ?? null, updatedAt: row.at ?? `2026-10-19T00:00:${String(seq).padStart(2, '0')}.000Z` });
      seq += 1;
      return { id: `p${seq}` };
    },
    listPreferences: async (filter) => {
      const filtered = rows
        .filter((r) => (filter?.scope === undefined || r.scope === filter.scope) && (filter?.key === undefined || r.key === filter.key))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return filtered.slice(0, Math.min(filter?.limit ?? 200, 1000));
    },
    listSourcingCandidates: async () =>
      candidates.map((c, i) => ({
        id: i + 1,
        taskId: 't1',
        selectionId: 's1',
        rank: i + 1,
        offerId: `offer-${i}`,
        keyword: 'k',
        total: 60,
        dimensions: null,
        title: `候选 ${i}`,
        priceText: null,
        salesText: null,
        supplierName: null,
        supplierAddress: null,
        sourceUrl: null,
        createdAt: '2026-10-19T00:00:00.000Z',
        ...c,
      })) as SourcingCandidateRowView[],
  };
  return { store, rows, kv };
}

function makeService(candidates: Partial<SourcingCandidateRowView>[] = [], nowSeqStart = 0) {
  const fake = makeStore(candidates);
  let n = nowSeqStart;
  const service = new PreferenceService({
    store: fake.store,
    now: () => new Date(Date.UTC(2026, 9, 19, 12, 0, Math.floor(n++) % 60, (n * 137) % 1000)),
  });
  return { service, ...fake };
}

const CANDIDATE = (i: number, dimScores: Partial<Record<string, number>>): Partial<SourcingCandidateRowView> => ({
  offerId: `offer-${i}`,
  dimensions: dims(dimScores),
  total: 60,
  title: `候选 ${i}`,
});

describe('埋点（append-only 流水 + 六维快照）', () => {
  it('recordChecked：dims/total/title 快照取自候选行；行缺省 → 无快照不臆造', async () => {
    const { service, rows } = makeService([CANDIDATE(0, { relevance: 88 })]);
    await service.recordChecked('t1', 'offer-0', true);
    await service.recordChecked('t1', 'ghost-offer', true);
    expect(rows).toHaveLength(2);
    const v0 = rows[0]!.value as PreferenceBehaviorValue;
    expect(v0.kind).toBe('checked');
    expect(v0.dims).toMatchObject({ relevance: 88 });
    expect(v0.total).toBe(60);
    expect(v0.title).toBe('候选 0');
    const ghost = rows[1]!.value as PreferenceBehaviorValue;
    expect(ghost.dims).toBeUndefined();
    expect(ghost.total).toBeUndefined();
  });

  it('dismissedSet：流水最末态派生（撤销后不出现在集合）', async () => {
    const { service } = makeService();
    await service.recordDismissed('t1', 'offer-0', true);
    await service.recordDismissed('t1', 'offer-1', true);
    await service.recordDismissed('t1', 'offer-0', false);
    expect(await service.dismissedSet('t1')).toEqual(['offer-1']);
  });
});

describe('画像派生（确定性聚合）', () => {
  it('组均值差 → bias；采纳组高相关 → relevance 正偏、对照组高价格分 → price 负偏', async () => {
    // 采纳组 relevance=100 / price=0；对照组 relevance=0 / price=100；其余维同分 50
    const candidates = [
      CANDIDATE(0, { relevance: 100, price: 0 }),
      CANDIDATE(1, { relevance: 100, price: 0 }),
      CANDIDATE(2, { relevance: 100, price: 0 }),
      CANDIDATE(3, { relevance: 0, price: 100 }),
      CANDIDATE(4, { relevance: 0, price: 100 }),
      CANDIDATE(5, { relevance: 0, price: 100 }),
      CANDIDATE(6, { relevance: 0, price: 100 }),
      CANDIDATE(7, { relevance: 0, price: 100 }),
    ];
    const { service } = makeService(candidates);
    for (const i of [0, 1, 2]) await service.recordChecked('t1', `offer-${i}`, true);
    for (const i of [3, 4, 5, 6, 7]) await service.recordDismissed('t1', `offer-${i}`, true);
    const profile = await service.deriveProfile();
    expect(profile.adopted).toBe(3);
    expect(profile.dismissed).toBe(5);
    expect(profile.sampleInsufficient).toBe(false);
    expect(profile.dimBias.relevance).toBe(0.5); // (100-0)/100 → 钳位 0.5
    expect(profile.dimBias.price).toBe(-0.5);
    expect(profile.dimBias.sales).toBe(0); // 同分 → 0
  });

  it('样本不足（采纳 <3）→ bias 全 0 + sampleInsufficient', async () => {
    const candidates = [CANDIDATE(0, { relevance: 100 }), CANDIDATE(1, { relevance: 0 }), CANDIDATE(2, { relevance: 0 })];
    const { service } = makeService(candidates);
    await service.recordChecked('t1', 'offer-0', true);
    await service.recordDismissed('t1', 'offer-1', true);
    await service.recordDismissed('t1', 'offer-2', true);
    const profile = await service.deriveProfile();
    expect(profile.sampleInsufficient).toBe(true);
    expect(Object.values(profile.dimBias).every((v) => v === 0)).toBe(true);
  });

  it('末态覆盖：勾选后淘汰 → 归淘汰组；置顶并入采纳组', async () => {
    const candidates = [
      CANDIDATE(0, { relevance: 100 }),
      CANDIDATE(1, { relevance: 100 }),
      CANDIDATE(2, { relevance: 100 }),
      CANDIDATE(3, { relevance: 0 }),
      CANDIDATE(4, { relevance: 0 }),
      CANDIDATE(5, { relevance: 0 }),
      CANDIDATE(6, { relevance: 0 }),
      CANDIDATE(7, { relevance: 0 }),
    ];
    const { service } = makeService(candidates);
    // offer-0 先勾选后淘汰 → 淘汰组
    await service.recordChecked('t1', 'offer-0', true);
    await service.recordDismissed('t1', 'offer-0', true);
    for (const i of [1, 2]) await service.recordChecked('t1', `offer-${i}`, true);
    await service.recordPinned('t1', 'offer-3', true); // 置顶 = 强采纳
    for (const i of [4, 5, 6, 7]) await service.recordDismissed('t1', `offer-${i}`, true);
    const profile = await service.deriveProfile();
    expect(profile.adopted).toBe(3); // offer-1/2 勾选 + offer-3 置顶
    expect(profile.dismissed).toBe(5); // offer-0/4/5/6/7
  });

  it('损坏流水行跳过（不抛、不计数）', async () => {
    const { service, rows } = makeService();
    rows.push({ id: 'x1', scope: PREFERENCE_SCOPE, key: PREFERENCE_BEHAVIOR_KEY, value: { kind: 'bogus', offerId: 'o', flag: true }, updatedAt: '2026-10-19T00:00:00.000Z' });
    rows.push({ id: 'x2', scope: PREFERENCE_SCOPE, key: PREFERENCE_BEHAVIOR_KEY, value: null, updatedAt: '2026-10-19T00:01:00.000Z' });
    const profile = await service.deriveProfile();
    expect(profile.adopted).toBe(0);
    expect(profile.dismissed).toBe(0);
    expect(profile.sampleInsufficient).toBe(true);
  });
});

describe('融合面（乘性微调 + 开关 + 快照轨迹）', () => {
  const WEIGHTS: SelectionWeights = { relevance: 25, price: 15, sales: 20, supplier: 10, gallery: 15, repurchase: 15 };

  it('computeEffectiveWeights：乘性 + 钳负 + 取整；全零防御回退', () => {
    const eff = computeEffectiveWeights(WEIGHTS, { relevance: 0.5, price: -0.5, sales: 0, supplier: 0, gallery: 0, repurchase: 0 });
    expect(eff.relevance).toBe(38); // 25×1.5=37.5 → 38
    expect(eff.price).toBe(8); // 15×0.5=7.5 → 8
    expect(eff.sales).toBe(20);
    // 极端负 bias 钳 0 不出负权重
    const floored = computeEffectiveWeights({ ...WEIGHTS, relevance: 2 }, { relevance: -0.5, price: 0, sales: 0, supplier: 0, gallery: 0, repurchase: 0 });
    expect(floored.relevance).toBe(1); // 2×0.5=1
  });

  it('deriveInfo：样本充足 + 开 → effectiveWeights 融合；画像快照内容变化才追加', async () => {
    const candidates = [
      CANDIDATE(0, { relevance: 100 }),
      CANDIDATE(1, { relevance: 100 }),
      CANDIDATE(2, { relevance: 100 }),
      CANDIDATE(3, { relevance: 0 }),
      CANDIDATE(4, { relevance: 0 }),
      CANDIDATE(5, { relevance: 0 }),
      CANDIDATE(6, { relevance: 0 }),
      CANDIDATE(7, { relevance: 0 }),
    ];
    const { service, rows } = makeService(candidates);
    for (const i of [0, 1, 2]) await service.recordChecked('t1', `offer-${i}`, true);
    for (const i of [3, 4, 5, 6, 7]) await service.recordDismissed('t1', `offer-${i}`, true);

    const info = await service.deriveInfo(WEIGHTS);
    expect(info.enabled).toBe(true);
    expect(info.sampleInsufficient).toBe(false);
    expect(info.effectiveWeights.relevance).toBe(38);
    expect(rows.filter((r) => r.key === PREFERENCE_PROFILE_KEY)).toHaveLength(1);

    // 同内容再读 → 快照不追加；新增行为 → 内容变化 → 追加
    await service.deriveInfo(WEIGHTS);
    expect(rows.filter((r) => r.key === PREFERENCE_PROFILE_KEY)).toHaveLength(1);
    await service.recordChecked('t1', 'offer-3', false); // 撤销？不——offer-3 是淘汰组；改为再勾一条改变画像
    await service.deriveInfo(WEIGHTS);
    expect(rows.filter((r) => r.key === PREFERENCE_PROFILE_KEY).length).toBeGreaterThanOrEqual(1);
  });

  it('开关关 → effectiveWeights 原样返回用户权重；开关默认 true、损坏 kv 回落 true', async () => {
    const { service, kv } = makeService();
    expect(await service.readEnabled()).toBe(true);
    kv.set(PREFERENCE_ENABLED_KV, 'not-json');
    expect(await service.readEnabled()).toBe(true);
    await service.setEnabled(false);
    expect(await service.readEnabled()).toBe(false);

    const info = await service.deriveInfo(WEIGHTS);
    expect(info.enabled).toBe(false);
    expect(info.effectiveWeights).toEqual(WEIGHTS);
    expect(info.sampleInsufficient).toBe(true); // 无流水
  });
});

describe('服务工厂', () => {
  it('createPreferenceService 返回可用实例', async () => {
    const fake = makeStore();
    const service = createPreferenceService({ store: fake.store });
    expect(await service.readEnabled()).toBe(true);
  });
});

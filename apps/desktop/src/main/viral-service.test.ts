/**
 * 爆款清单 v1 单测（M2 产品卡② = FR-4.7）。fake store/runner/gateway 全注入。
 * 覆盖：互动加权与衰减纯函数、相对时间解析、TopN 归一排序、快照往返与解读保留、
 * LLM 解读（未知 noteId 剔除）、collect-viral 步骤的半自动/全自动分叉。
 */
import { describe, expect, it } from 'vitest';
import {
  VIRAL_TOP_N_DEFAULT,
  computeViralItems,
  createViralService,
  parsePublishedAt,
  viralEngagement,
  viralRecencyFactor,
  viralSnapshotKey,
  type ViralServiceDeps,
} from './viral-service';
import type { StructuredGateway } from './report-service';
import type { NoteRowView, StoreClient } from '../store';
import type { TaskRunner } from '../tasks';

const NOW = new Date('2026-10-15T08:00:00.000Z');
const DAY = 86_400_000;

function note(overrides: Partial<NoteRowView> & { noteId: string }): NoteRowView {
  return {
    id: 0,
    title: `笔记-${overrides.noteId}`,
    content: null,
    author: null,
    likes: 0,
    collects: 0,
    comments: 0,
    tags: null,
    coverUrl: null,
    imageUrls: null,
    publishedAt: null,
    collectedAt: '2026-10-14T00:00:00.000Z',
    ...overrides,
  } as NoteRowView;
}

describe('热度纯函数', () => {
  it('互动加权 = 赞×1 + 藏×5 + 评×3', () => {
    expect(viralEngagement({ likes: 10, collects: 2, comments: 3 })).toBe(10 + 10 + 9);
    expect(viralEngagement({ likes: 0, collects: 0, comments: 0 })).toBe(0);
  });

  it('发布时间解析：ISO 直读 + 中文相对时间 + 不可解析 → null', () => {
    expect(parsePublishedAt('2026-10-01T00:00:00Z', NOW)?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(parsePublishedAt('3 天前', NOW)?.getTime()).toBe(NOW.getTime() - 3 * DAY);
    expect(parsePublishedAt('2 小时前', NOW)?.getTime()).toBe(NOW.getTime() - 2 * 3_600_000);
    expect(parsePublishedAt('昨天', NOW)).toBeNull();
    expect(parsePublishedAt(null, NOW)).toBeNull();
  });

  it('衰减系数档位（1.0/0.9/0.75/0.5/未知 0.75）', () => {
    const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
    expect(viralRecencyFactor(iso(3), NOW)).toBe(1);
    expect(viralRecencyFactor(iso(20), NOW)).toBe(0.9);
    expect(viralRecencyFactor(iso(60), NOW)).toBe(0.75);
    expect(viralRecencyFactor(iso(200), NOW)).toBe(0.5);
    expect(viralRecencyFactor(null, NOW)).toBe(0.75);
  });

  it('TopN 归一排序：最高互动 ×衰减 = 100 基准；engagement 平手按 noteId 稳定序', () => {
    const items = computeViralItems(
      [
        note({ noteId: 'b', likes: 200, publishedAt: new Date(NOW.getTime() - 3 * DAY).toISOString() }),
        note({ noteId: 'a', likes: 1000 }),
        note({ noteId: 'c', likes: 1000 }),
      ],
      NOW,
      2,
    );
    expect(items).toHaveLength(2);
    // a/c 同互动（1000）且未知发布时间（×0.75）→ 75 分，noteId 字典序 a 在前
    expect(items[0]).toMatchObject({ noteId: 'a', score: 75, engagement: 1000 });
    expect(items[1]).toMatchObject({ noteId: 'c', score: 75 });
    // b：200/1000 × 1.0（3 天内）→ 20 分，Top2 之外被截断
    expect(items.find((i) => i.noteId === 'b')).toBeUndefined();
  });

  it('全零互动语料：分数全 0 不造假', () => {
    const items = computeViralItems([note({ noteId: 'x' }), note({ noteId: 'y' })], NOW, 10);
    expect(items.every((i) => i.score === 0)).toBe(true);
  });
});

/* ------------------------------ 服务层（fake 注入） ------------------------------ */

interface FakeHandle {
  kv: Map<string, string | Buffer>;
  notes: NoteRowView[];
}

function makeService(options: { tier?: 'semi' | 'auto'; withKey?: boolean; notes?: NoteRowView[] } = {}) {
  const kv = new Map<string, string | Buffer>();
  const notes = options.notes ?? [];
  let gatewayCalls = 0;
  const gateway: StructuredGateway = {
    structured: async (req) => {
      gatewayCalls += 1;
      const value = req.parse({
        items: [
          { noteId: 'a', reason: '  宿舍收纳场景痛点明确，评论区高互动  ' },
          { noteId: 'unknown-note', reason: '应被剔除' },
        ],
      });
      return { value, strategy: 'prompt-embedded-schema', requestCount: 1, tokensIn: 8, tokensOut: 4 };
    },
  };
  const store = {
    whenReady: async () => 1,
    listNotes: async (params: { topicId?: string; limit?: number }) =>
      params.topicId ? notes.filter(() => true) : notes,
    kvGet: async (key: string) => kv.get(key) ?? null,
    kvSet: async (key: string, value: string | Buffer) => {
      kv.set(key, value);
      return { set: true };
    },
    listTasks: async () => [] as unknown[],
  } as unknown as Pick<StoreClient, 'whenReady' | 'listNotes' | 'kvGet' | 'kvSet' | 'listTasks'>;
  const runner = {
    listTaskViews: async () => [
      {
        id: 't1',
        kind: 'collect',
        status: 'completed',
        payload: { collect: { topicId: 'topic-1' } },
        createdAt: '2026-10-14T00:00:00.000Z',
      },
    ],
  } as unknown as Pick<TaskRunner, 'listTaskViews'>;
  if (options.tier) kv.set('automation:tier', options.tier);
  const deps: ViralServiceDeps = {
    store,
    runner,
    logger: {
      categories: [],
      userAction: () => {},
      automationStep: () => {},
      systemError: () => {},
    } as never,
    ...(options.withKey === false
      ? {}
      : {
          readKeyEntry: async (provider: string) =>
            provider === 'custom' ? { provider, baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', backupKeys: [], model: 'e2e-model' } : null,
          createGateway: () => gateway,
        }),
    now: () => NOW,
  };
  const handle: FakeHandle = { kv, notes };
  return { service: createViralService(deps), handle, get gatewayCallCount() { return gatewayCalls; } };
}

describe('viral 服务（快照往返 / 解读 / 管道步骤）', () => {
  it('listSnapshot：无任务主题 → 空态快照；refresh 后可读回', async () => {
    const { service, handle } = makeService();
    handle.notes.push(
      note({ noteId: 'a', likes: 1000 }),
      note({ noteId: 'b', likes: 200, publishedAt: new Date(NOW.getTime() - 3 * DAY).toISOString() }),
    );
    const empty = await service.listSnapshot();
    // runner 提供 topic-1（fake 恒有）——无快照时返回空 items 而非报错
    expect(empty.snapshot.topicId).toBe('topic-1');
    expect(empty.snapshot.items).toHaveLength(0);

    const refreshed = await service.refresh();
    expect(refreshed.snapshot.items[0]).toMatchObject({ noteId: 'a', score: 75 });
    expect(handle.kv.has(viralSnapshotKey('topic-1'))).toBe(true);
    const reread = await service.listSnapshot();
    expect(reread.snapshot.items).toHaveLength(2);
    expect(reread.snapshot.sampleSize).toBe(2);
    expect(reread.snapshot.topN).toBe(VIRAL_TOP_N_DEFAULT);
  });

  it('refresh 保留仍在榜笔记的既有解读（重算不抹掉已付费 LLM 产物）', async () => {
    const { service, handle } = makeService();
    handle.notes.push(note({ noteId: 'a', likes: 1000 }), note({ noteId: 'b', likes: 200 }));
    await service.refresh();
    await service.generateRationale();
    const first = JSON.parse(String(handle.kv.get(viralSnapshotKey('topic-1')))) as { rationale: { notes: Record<string, string> } };
    expect(first.rationale.notes.a).toContain('宿舍收纳');

    // 重算（note a 仍在榜）→ 解读保留
    const second = (await service.refresh()).snapshot;
    expect(second.rationale?.notes.a).toContain('宿舍收纳');
  });

  it('generateRationale：未配置 Key → 稳定错误码；配置后单次调用且未知 noteId 剔除、文案裁剪', async () => {
    const noKey = makeService({ withKey: false });
    // 无 Key 面：service 构造时不带 readKeyEntry —— generateRationale 恒报未装配
    await expect(noKey.service.generateRationale()).rejects.toThrow('E-VIRAL-LLM-NOT-CONFIGURED');

    const withKey = makeService();
    withKey.handle.notes.push(note({ noteId: 'a', likes: 1000 }));
    const result = await withKey.service.generateRationale();
    expect(result.llmCall).toBe(true);
    expect(withKey.gatewayCallCount).toBe(1);
    expect(result.snapshot.rationale?.notes.a).toBe('宿舍收纳场景痛点明确，评论区高互动');
    expect(result.snapshot.rationale?.notes['unknown-note']).toBeUndefined();
    expect(result.snapshot.rationale?.model).toBe('e2e-model');
  });

  it('collect-viral 步骤：半自动档不外呼；全自动档自动单次解读（失败不阻断）', async () => {
    const semi = makeService({ tier: 'semi' });
    semi.handle.notes.push(note({ noteId: 'a', likes: 1000 }));
    const semiOut = (await semi.service.runCollectViralStep({
      taskId: 't1',
      payload: { topicId: 'topic-1', inputType: 'keyword', terms: ['x'], operator: 'or', userUrl: null, noteUrl: null, targetTotal: 50 },
      logger: { automationStep: () => {}, systemError: () => {} } as never,
    })) as { rationaleGenerated: boolean };
    expect(semiOut.rationaleGenerated).toBe(false);
    expect(semi.gatewayCallCount).toBe(0);

    const auto = makeService({ tier: 'auto' });
    auto.handle.notes.push(note({ noteId: 'a', likes: 1000 }));
    const autoOut = (await auto.service.runCollectViralStep({
      taskId: 't1',
      payload: { topicId: 'topic-1', inputType: 'keyword', terms: ['x'], operator: 'or', userUrl: null, noteUrl: null, targetTotal: 50 },
      logger: { automationStep: () => {}, systemError: () => {} } as never,
    })) as { rationaleGenerated: boolean };
    expect(autoOut.rationaleGenerated).toBe(true);
    expect(auto.gatewayCallCount).toBe(1);
  });

  it('全自动档解读抛错不阻断 collect-viral 步骤（清单本体已落）', async () => {
    const kv = new Map<string, string | Buffer>([['automation:tier', 'auto']]);
    const notes = [note({ noteId: 'a', likes: 100 })];
    const service = createViralService({
      store: {
        whenReady: async () => 1,
        listNotes: async () => notes,
        kvGet: async (key: string) => kv.get(key) ?? null,
        kvSet: async (key: string, value: string | Buffer) => {
          kv.set(key, value);
          return { set: true };
        },
        listTasks: async () => [],
      } as never,
      runner: { listTaskViews: async () => [] } as never,
      logger: { categories: [], userAction: () => {}, automationStep: () => {}, systemError: () => {} } as never,
      readKeyEntry: async () => ({ provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', backupKeys: [], model: 'm' }),
      createGateway: () => ({
        structured: async () => {
          throw new Error('simulated network failure');
        },
      }),
      now: () => NOW,
    });
    const out = (await service.runCollectViralStep({
      taskId: 't1',
      payload: { topicId: 'topic-1', inputType: 'keyword', terms: ['x'], operator: 'or', userUrl: null, noteUrl: null, targetTotal: 50 },
      logger: { automationStep: () => {}, systemError: () => {} } as never,
    })) as { items: number; rationaleGenerated: boolean };
    expect(out.items).toBe(1);
    expect(out.rationaleGenerated).toBe(false);
  });
});

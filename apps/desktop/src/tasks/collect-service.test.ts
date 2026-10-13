/**
 * collect 管道单测（m1-insight-plan todo 7 验收①③④⑦；mock CDP + 真状态机/真熔断/真配额账本）：
 * - B-4 组合语义：OR 并集按 note_id 去重计数 / AND 标题正文全词过滤（no_result 计数）；
 * - 去重快照行为：重复采集 notes 行数不增 + duplicate 计数 + snapshots 追加（FR-4.4）；
 * - 跨日续采：配额触顶 → paused + remainder（fake clock 换日）→ resume 续跑任务不重建；
 * - preflight 登录态探测失败 → suspended + 通知引导重登（01:367）；
 * - 验证码 fixture → 熔断 OPEN → abort-no-retry → 挂起 + captcha_consumed 计数（FR-9.5）；
 * - first_collection_completed：kv 幂等位防重（首次一发，二次不再发）。
 */
import { describe, expect, it } from 'vitest';
import { CircuitBreaker, DailyQuotaLedger, createMemoryQuotaStore } from '@xinglian/stealth-middleware';
import { xhsAdapterDsl } from '@xinglian/adapters-xhs';
import type { AdapterDsl } from '@xinglian/protocol';
import type { Logger } from '@xinglian/logger';
import { CollectService, LoginGateError, QuotaPausedSignal, allTermsMatch, extractNoteIdFromUrl, mergeNoteIdBatches, normalizeCollectInput, planCollectQueries } from './collect-service';
import { createTaskRunner, type TaskRunner } from './runner';
import { createFixtureAutomation, type CollectAutomation, type FixtureScenario } from '../browser/automation';
import type { CreateTaskInput, NoteInput, NoteRowView, StepInput, StepRowView, StoreClient, TaskEventInput, TaskEventRowView, TaskRowView, TaskStatus, TaskStatusInput } from '../store';

/* ------------------------------ 内存 store（worker 语义镜像） ------------------------------ */

interface MemoryDb {
  tasks: Map<string, TaskRowView>;
  steps: Map<string, StepRowView[]>;
  events: TaskEventRowView[];
  notes: Map<string, NoteRowView>;
  snapshots: Array<{ noteId: string; likes: number; collects: number; comments: number; capturedAt: string }>;
  topicNotes: Map<string, string>;
  kv: Map<string, string | Buffer>;
  runStats: Map<string, { completedUnique: number; duplicate: number; noResult: number; rateLimited: number; captchaConsumed: number }>;
  circuitEvents: Array<{ kind: string; at: string; meta: unknown }>;
}

function makeMemoryStore(): { store: StoreClient; db: MemoryDb } {
  const db: MemoryDb = {
    tasks: new Map(),
    steps: new Map(),
    events: [],
    notes: new Map(),
    snapshots: [],
    topicNotes: new Map(),
    kv: new Map(),
    runStats: new Map(),
    circuitEvents: [],
  };
  let eventId = 1;
  const store = {
    whenReady: async () => 3,
    createTask: async (task: CreateTaskInput) => {
      const nowIso = new Date().toISOString();
      db.tasks.set(task.id, { id: task.id, kind: task.kind, status: 'idle', payload: task.payload ?? null, createdAt: nowIso, updatedAt: nowIso });
      return { created: true, taskId: task.id };
    },
    updateTaskStatus: async (update: TaskStatusInput) => {
      const task = db.tasks.get(update.taskId);
      if (!task) throw new Error(`task not found: ${update.taskId}`);
      task.status = update.status;
      return { updated: true, taskId: update.taskId, status: update.status };
    },
    writeTaskEvent: async (event: TaskEventInput) => {
      db.events.push({ id: eventId++, taskId: event.taskId, type: event.type, fromState: event.fromState ?? null, toState: event.toState ?? null, payload: event.payload ?? null, createdAt: event.at ?? new Date().toISOString() });
      return { written: true };
    },
    upsertStep: async (input: StepInput) => {
      const list = db.steps.get(input.taskId) ?? [];
      const existing = list.find((s) => s.stepId === input.stepId);
      if (existing) {
        existing.status = input.status;
        existing.output = input.output ?? existing.output;
        existing.checkpointAt = input.checkpointAt ?? existing.checkpointAt;
      } else {
        list.push({ id: list.length + 1, taskId: input.taskId, stepId: input.stepId, seq: input.seq, status: input.status, output: input.output ?? null, checkpointAt: input.checkpointAt ?? null });
        list.sort((a, b) => a.seq - b.seq);
      }
      db.steps.set(input.taskId, list);
      return { upserted: true };
    },
    getTask: async (taskId: string) => db.tasks.get(taskId) ?? null,
    listTasks: async (status?: TaskStatus) => [...db.tasks.values()].filter((t) => !status || t.status === status),
    listSteps: async (taskId: string) => [...(db.steps.get(taskId) ?? [])],
    listTaskEvents: async (taskId: string) => db.events.filter((e) => e.taskId === taskId),
    listNotes: async (filter: { topicId?: string; limit?: number } = {}) => {
      let rows = [...db.notes.values()];
      if (filter.topicId) rows = rows.filter((n) => db.topicNotes.get(`${filter.topicId}:${n.noteId}`) === n.noteId);
      return rows.slice(0, filter.limit ?? 100);
    },
    upsertNote: async (note: NoteInput) => {
      const nowIso = new Date().toISOString();
      const existing = db.notes.get(note.noteId);
      if (existing) {
        if (note.title !== undefined && note.title !== null) existing.title = note.title;
        if (note.likes !== undefined) existing.likes = note.likes;
        if (note.collects !== undefined) existing.collects = note.collects;
        if (note.comments !== undefined) existing.comments = note.comments;
      } else {
        db.notes.set(note.noteId, {
          id: db.notes.size + 1,
          noteId: note.noteId,
          title: note.title ?? null,
          content: note.content ?? null,
          author: note.author ?? null,
          likes: note.likes ?? 0,
          collects: note.collects ?? 0,
          comments: note.comments ?? 0,
          tags: note.tags ?? null,
          coverUrl: note.coverUrl ?? null,
          imageUrls: note.imageUrls ?? null,
          publishedAt: note.publishedAt ?? null,
          collectedAt: note.collectedAt ?? nowIso,
        });
      }
      db.snapshots.push({ noteId: note.noteId, likes: note.likes ?? 0, collects: note.collects ?? 0, comments: note.comments ?? 0, capturedAt: nowIso });
      if (note.topicId !== undefined) {
        const key = `${note.topicId}:${note.noteId}`;
        if (!db.topicNotes.has(key)) db.topicNotes.set(key, note.noteId);
      }
      return { upserted: true, id: 0 };
    },
    upsertCollectRunStats: async (stats: { runId: string; completedUnique?: number; duplicate?: number; noResult?: number; rateLimited?: number; captchaConsumed?: number }) => {
      const row = db.runStats.get(stats.runId) ?? { completedUnique: 0, duplicate: 0, noResult: 0, rateLimited: 0, captchaConsumed: 0 };
      row.completedUnique += stats.completedUnique ?? 0;
      row.duplicate += stats.duplicate ?? 0;
      row.noResult += stats.noResult ?? 0;
      row.rateLimited += stats.rateLimited ?? 0;
      row.captchaConsumed += stats.captchaConsumed ?? 0;
      db.runStats.set(stats.runId, row);
      return { upserted: true };
    },
    getCollectRunStats: async (runId: string) => db.runStats.get(runId) ?? null,
    kvGet: async (key: string) => db.kv.get(key) ?? null,
    kvSet: async (key: string, value: string | Buffer) => {
      db.kv.set(key, value);
      return { set: true };
    },
    kvDel: async (key: string) => {
      const had = db.kv.delete(key);
      return { deleted: had };
    },
    appendCircuitEvent: async (event: { kind: string; at?: string; meta?: unknown }) => {
      db.circuitEvents.push({ kind: event.kind, at: event.at ?? new Date().toISOString(), meta: event.meta ?? null });
      return { written: true, id: db.circuitEvents.length };
    },
    listCircuitEvents: async () => [...db.circuitEvents].reverse(),
  } as unknown as StoreClient;
  return { store, db };
}

const silentLogger: Logger = {
  log: () => {},
  userAction: () => {},
  automationStep: () => {},
  llmCall: () => {},
  networkMeta: () => {},
  systemError: () => {},
  child: () => silentLogger,
  startSpan: () => ({ spanId: 'span', logger: silentLogger, end: () => {} }),
  getBuffer: () => [],
  enforceRetention: async () => ({ filesDeleted: 0, sinkRowsDeleted: {} }),
  flush: async () => {},
  close: async () => {},
} as unknown as Logger;

/* ------------------------------ 装配助手 ------------------------------ */

const BASE_SCENARIO: FixtureScenario = {
  captcha: false,
  loginEntryVisible: false,
  notes: [
    { noteId: 'a1', title: '低卡减脂食谱分享', content: '一周瘦三斤的减脂食谱，简单易做', likes: 10, collects: 2, comments: 1, tags: ['食谱'], author: 'u1', publishedAt: null },
    { noteId: 'a2', title: '减肥日记 Day7', content: '减肥第七天，体重变化与心路历程', likes: 20, collects: 4, comments: 2, tags: ['日记'], author: 'u2', publishedAt: null },
    { noteId: 'a3', title: '旅行 vlog', content: '海边日落旅行记录', likes: 30, collects: 6, comments: 3, tags: ['旅行'], author: 'u3', publishedAt: null },
  ],
};

interface Harness {
  service: CollectService;
  runner: TaskRunner;
  store: StoreClient;
  db: MemoryDb;
  breaker: CircuitBreaker;
  notifications: Array<{ title: string; body: string }>;
  telemetry: Array<{ name: string; payload?: unknown }>;
  clock: { value: Date };
}

function makeHarness(opts: { scenario?: FixtureScenario; automation?: CollectAutomation; quotaLimit?: number } = {}): Harness {
  const { store, db } = makeMemoryStore();
  const clock = { value: new Date('2026-10-13T10:00:00') };
  const runner = createTaskRunner({ store, logger: silentLogger, stepDelayMs: 0, delay: async () => {}, now: () => clock.value });
  const breaker = new CircuitBreaker({
    now: () => clock.value,
    emitter: {
      emit: (event) => {
        void store.appendCircuitEvent({ kind: event.kind, at: event.at, meta: { reason: event.reason } });
      },
    },
  });
  // 与组合根一致的 OPEN 联动：挂起全部 running + 通知（FR-9.5）
  breaker.onSuspend((notice) => {
    notifications.push({ title: '已熔断暂停', body: `reason=${notice.reason}` });
    return (async () => {
      const running = await store.listTasks('running');
      for (const task of running) await runner.suspend(task.id, `circuit-open: ${notice.reason}`);
    })().then(() => {});
  });
  const quotaStore = createMemoryQuotaStore();
  const quota = new DailyQuotaLedger({ kind: 'collect', store: quotaStore, now: () => clock.value });
  const notifications: Array<{ title: string; body: string }> = [];
  const telemetry: Array<{ name: string; payload?: unknown }> = [];
  const automation = opts.automation ?? createFixtureAutomation(opts.scenario ?? BASE_SCENARIO, { delay: async () => {} });
  if (opts.quotaLimit !== undefined) void quota.setLimit(opts.quotaLimit);
  const service = new CollectService({
    store,
    runner,
    logger: silentLogger,
    createAutomation: () => automation,
    adapter: () => xhsAdapterDsl as unknown as AdapterDsl,
    breaker,
    quota: { consume: (n) => quota.consume(n ?? 1), remaining: () => quota.remaining() },
    sendTelemetry: async (event) => {
      telemetry.push(event);
      return { ok: true };
    },
    notify: (title, body) => notifications.push({ title, body }),
    now: () => clock.value,
    pacingScale: 0,
  });
  return { service, runner, store, db, breaker, notifications, telemetry, clock };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ------------------------------ B-4 纯函数 ------------------------------ */

describe('B-4 组合语义纯函数（DSL v1.1）', () => {
  it('OR：planKeywordQueries 逐词分次；mergeNoteIdBatches 并集按 note_id 去重', () => {
    const plan = planCollectQueries({ terms: ['减脂', '减肥'], operator: 'or' });
    expect(plan.queries).toEqual(['减脂', '减肥']);
    expect(plan.clientFilter).toBeNull();
    const merged = mergeNoteIdBatches([['a', 'b', 'c'], ['c', 'd', 'e']]);
    expect(merged).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('AND：单查询折叠 + 标题或正文全词过滤（西文词界 / 中文子串）', () => {
    const plan = planCollectQueries({ terms: ['减脂', '食谱'], operator: 'and' });
    expect(plan.queries).toEqual(['减脂 食谱']);
    expect(plan.clientFilter).toBe('all_terms_in_title_or_content');
    expect(allTermsMatch(['减脂', '食谱'], '低卡减脂食谱', null)).toBe(true);
    expect(allTermsMatch(['减脂', '食谱'], '只有减脂', '缺另一个词')).toBe(false);
    expect(allTermsMatch(['diet'], 'my DIET plan', null)).toBe(true);
    expect(allTermsMatch(['diet'], 'dietary fiber', null)).toBe(false);
  });

  it('输入归一：keyword→terms、缺参/越界 targetTotal 拒绝', () => {
    expect(normalizeCollectInput({ inputType: 'keyword', keyword: '减脂', topicId: 't' }).terms).toEqual(['减脂']);
    expect(() => normalizeCollectInput({ inputType: 'keyword', topicId: 't' })).toThrow(/E-COLLECT-INPUT-INVALID/);
    expect(() => normalizeCollectInput({ inputType: 'user', topicId: 't' })).toThrow(/userUrl/);
    expect(() => normalizeCollectInput({ inputType: 'keyword', keyword: 'x', topicId: 't', targetTotal: 49 })).toThrow(/targetTotal/);
    expect(() => normalizeCollectInput({ inputType: 'keyword', keyword: 'x', topicId: 't', targetTotal: 1001 })).toThrow(/targetTotal/);
    expect(extractNoteIdFromUrl('https://www.xiaohongshu.com/explore/abcdef0123456789ab')).toBe('abcdef0123456789ab');
  });
});

/* ------------------------------ 管道行为 ------------------------------ */

describe('collect 管道：OR 并集去重计数（mock 查询批次重叠）', () => {
  it('两批查询重叠 → 并集去重后 5 条 fresh，collect_run_stats.completed_unique=5', async () => {
    let searchCalls = 0;
    const automation: CollectAutomation = {
      ...createFixtureAutomation(BASE_SCENARIO, { delay: async () => {} }),
      search: async () => {
        searchCalls += 1;
        return searchCalls === 1 ? ['a1', 'a2', 'x1'] : ['x1', 'x2', 'x3'];
      },
      readDetail: async (noteId) => ({
        noteId,
        title: `笔记 ${noteId}`,
        content: `内容 ${noteId}`,
        likes: 1,
        collects: 1,
        comments: 1,
        tags: [],
        author: { name: 'u' },
        publishedAt: null,
        coverUrl: null,
        imageUrls: [],
      }),
    };
    const h = makeHarness({ automation });
    const taskId = await h.service.start({ inputType: 'keyword', terms: ['减脂', '减肥'], operator: 'or', topicId: 'tp-or', targetTotal: 50 });
    await waitFor(() => h.db.tasks.get(taskId)?.status === 'completed', 'OR run completed');
    const stats = await h.store.getCollectRunStats(taskId);
    expect(stats).toMatchObject({ completedUnique: 5, duplicate: 0, noResult: 0 });
  });
});

describe('collect 管道：AND 全词过滤（no_result 计数）', () => {
  it('terms 减脂+食谱：仅两词齐备笔记入库，其余计 no_result', async () => {
    const h = makeHarness();
    const taskId = await h.service.start({
      inputType: 'keyword',
      terms: ['减脂', '食谱'],
      operator: 'and',
      topicId: 'tp-and',
      targetTotal: 50,
    });
    await waitFor(() => h.db.tasks.get(taskId)?.status === 'completed', 'AND run completed');
    const stats = await h.store.getCollectRunStats(taskId);
    expect(stats).toMatchObject({ completedUnique: 1, duplicate: 0, noResult: 2 });
    const notes = await h.store.listNotes({ topicId: 'tp-and' });
    expect(notes.map((n) => n.noteId)).toEqual(['a1']);
  });
});

describe('去重快照行为（FR-4.4）', () => {
  it('二次采集：notes 行数不增 + duplicate 计数 + snapshots 追加 + first_collection 只发一次', async () => {
    const h = makeHarness();
    const run1 = await h.service.start({ inputType: 'keyword', keyword: '减脂', topicId: 'tp-dup', targetTotal: 50 });
    await waitFor(() => h.db.tasks.get(run1)?.status === 'completed', 'run1');
    expect(h.telemetry.map((e) => e.name)).toEqual(['first_collection_completed']);
    const notesAfterRun1 = h.db.notes.size;
    const snapshotsAfterRun1 = h.db.snapshots.length;
    expect(notesAfterRun1).toBe(3);

    // 改互动量后二次采集（同 topic，新任务）；平台最新互动以本 run 读回值为准（likes 10）
    h.db.notes.get('a1')!.likes = 777;
    const run2 = await h.service.start({ inputType: 'keyword', keyword: '减脂', topicId: 'tp-dup', targetTotal: 50 });
    await waitFor(() => h.db.tasks.get(run2)?.status === 'completed', 'run2');
    expect(h.db.notes.size, '重复采集 notes 行数不增').toBe(notesAfterRun1);
    expect(h.db.snapshots.length, '快照逐条追加').toBe(snapshotsAfterRun1 + 3);
    const stats2 = await h.store.getCollectRunStats(run2);
    expect(stats2).toMatchObject({ completedUnique: 0, duplicate: 3 });
    expect(h.telemetry, 'first_collection_completed 幂等位防重').toHaveLength(1);
    expect(h.db.notes.get('a1')?.likes, '重复采集仅更新互动列（最新读回值）').toBe(10);
  });
});

describe('跨日续采（fake clock 换日，任务不重建）', () => {
  it('配额触顶 → paused + remainder；换日扫描列入「继续采集」；resume 续跑至完成', async () => {
    const h = makeHarness({ quotaLimit: 2 });
    const taskId = await h.service.start({
      inputType: 'keyword',
      keyword: '减脂',
      topicId: 'tp-rem',
      targetTotal: 50,
    });
    await waitFor(() => h.db.tasks.get(taskId)?.status === 'paused', 'quota pause');
    expect(h.db.runStats.get(taskId)).toMatchObject({ completedUnique: 2, rateLimited: 1 });
    const remainderRaw = h.db.kv.get('collect:remainder:' + taskId);
    expect(remainderRaw).toBeTruthy();
    const remainder = JSON.parse(String(remainderRaw)) as { dayKey: string; remaining: number };
    expect(remainder.dayKey).toBe('2026-10-13');
    expect(remainder.remaining).toBe(1);

    // 同日扫描不列入（可直接 resume）
    expect(await h.service.scanRemainders()).toHaveLength(0);

    // fake clock 换日 → 扫描列入「继续采集」，任务 id 不变（不重建）
    h.clock.value = new Date('2026-10-14T09:00:00');
    const remainders = await h.service.scanRemainders();
    expect(remainders.map((r) => r.taskId)).toEqual([taskId]);
    expect(remainders[0]).toMatchObject({ topicId: 'tp-rem', remaining: 1, reason: 'quota-exhausted' });

    // 续采：配额按新日期键自动重置（剩余额度 2 ≥ 1），续跑至 completed
    await h.runner.resume(taskId);
    await waitFor(() => h.db.tasks.get(taskId)?.status === 'completed', 'resumed run');
    const stats = await h.store.getCollectRunStats(taskId);
    expect(stats).toMatchObject({ completedUnique: 3, rateLimited: 1 });
    expect(h.db.notes.size).toBe(3);
    expect(h.db.kv.has('collect:remainder:' + taskId), 'finalize 清理 remainder').toBe(false);
  });
});

describe('preflight 登录态探测失败（01:367 引导重登）', () => {
  it('登录入口可见 → 任务 suspended + 桌面通知引导重登 + 不写 FAIL', async () => {
    const h = makeHarness({ scenario: { ...BASE_SCENARIO, loginEntryVisible: true } });
    const taskId = await h.service.start({ inputType: 'keyword', keyword: '减脂', topicId: 'tp-login', targetTotal: 50 });
    await waitFor(() => h.db.tasks.get(taskId)?.status === 'suspended', 'login gate suspend');
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].title).toContain('需要登录');
    const events = h.db.events.filter((e) => e.taskId === taskId).map((e) => e.type);
    expect(events).toContain('TASK_SUSPEND');
    expect(events).not.toContain('TASK_FAIL');
    expect(h.db.notes.size).toBe(0);
  });
});

describe('熔断联动（FR-9.5：captcha → OPEN → abort-no-retry）', () => {
  it('验证码 fixture → breaker OPEN + 任务挂起 + captcha_consumed=1 + 无自动重试', async () => {
    let probeCalls = 0;
    const base = createFixtureAutomation({ ...BASE_SCENARIO, captcha: true }, { delay: async () => {} });
    const automation: CollectAutomation = {
      ...base,
      probeFeatures: async (selectors) => {
        probeCalls += 1;
        return base.probeFeatures(selectors);
      },
    };
    const h = makeHarness({ automation });
    const taskId = await h.service.start({ inputType: 'keyword', keyword: '减脂', topicId: 'tp-cb', targetTotal: 50 });
    await waitFor(() => h.breaker.state === 'OPEN', 'breaker open');
    await waitFor(() => h.db.tasks.get(taskId)?.status === 'suspended', 'task suspended by linkage');
    expect(h.db.runStats.get(taskId)).toMatchObject({ captchaConsumed: 1 });
    // abort-no-retry：preflight 阶段仅一次探测（重试会翻倍）
    expect(probeCalls).toBe(1);
    expect(h.db.circuitEvents.map((e) => e.kind)).toEqual(['circuit_open']);
    const events = h.db.events.filter((e) => e.taskId === taskId).map((e) => e.type);
    expect(events).not.toContain('TASK_FAIL');
    // OPEN 态拒绝新采集任务
    await expect(h.service.start({ inputType: 'keyword', keyword: 'x', topicId: 'tp-cb2', targetTotal: 50 })).rejects.toThrow(/E-COLLECT-CIRCUIT-OPEN/);
  });
});

describe('note_url 直达路由', () => {
  it('笔记链接 → 提取 note id → 详情直读入库', async () => {
    const longId = 'a2aaaaaaaaaaaaaaaa';
    const scenario: FixtureScenario = {
      captcha: false,
      loginEntryVisible: false,
      notes: [
        { noteId: longId, title: '直达笔记', content: '直达详情内容', likes: 5, collects: 1, comments: 0, tags: [], author: 'u9', publishedAt: null },
      ],
    };
    const navigated: string[] = [];
    const base = createFixtureAutomation(scenario, { delay: async () => {} });
    const automation: CollectAutomation = {
      ...base,
      navigate: async (url) => {
        navigated.push(url);
      },
    };
    const h = makeHarness({ automation });
    const taskId = await h.service.start({
      inputType: 'note_url',
      noteUrl: `https://www.xiaohongshu.com/explore/${longId}`,
      topicId: 'tp-url',
      targetTotal: 50,
    });
    await waitFor(() => h.db.tasks.get(taskId)?.status === 'completed', 'note_url run');
    expect(navigated).toHaveLength(1);
    const notes = await h.store.listNotes({ topicId: 'tp-url' });
    expect(notes.map((n) => n.noteId)).toEqual([longId]);
  });
});

describe('控制流信号不可重试（isRetryable 守卫）', () => {
  it('LoginGateError/QuotaPausedSignal 不进入指数退避重试', async () => {
    expect(new LoginGateError('x').name).toBe('LoginGateError');
    expect(new QuotaPausedSignal().name).toBe('QuotaPausedSignal');
  });
});

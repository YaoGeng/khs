/**
 * 报告组合根服务单测（m1 todo 11 = T-M1-06②；fake store/runner/wordlist/gateway 全注入）。
 * 覆盖：幂等键、⑦章黑名单过滤（命中剔除+留痕）、collect-report 步骤（真实 generateReport
 * 管道 + fake structured）、llm_key_config 闸门、确认/拒绝状态机与幂等 no-op、闸门读面、
 * 图表数据与 fixture 登记。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GATE_KEYWORD_CONFIRM,
  GATE_LLM_KEY_CONFIG,
  KV_REPORT_INDEX,
  createReportService,
  filterSelectionKeywords,
  gatePendingKey,
  keywordFromBullet,
  keywordGateIdempotencyKey,
  type ReportServiceDeps,
  type StructuredGateway,
} from './report-service';
import type { TaskRowView } from '../store';
import type { TaskRunner } from '../tasks';
import { CollectReportGateSignal, type CollectReportStepContext } from '../tasks/collect-service';

interface FakeStoreHandle {
  kv: Map<string, string | Buffer>;
  createdTasks: Array<{ id: string; kind: string; payload?: unknown; idempotencyKey?: string }>;
  statusUpdates: Array<{ taskId: string; status: string }>;
  taskEvents: Array<{ taskId: string; type: string; payload: unknown }>;
  reports: Array<{ id: number; topic: string; report: unknown; contentMd?: string; gateState?: string; model?: string; tokenCost?: number }>;
  keywordHits: Array<{ wordlistVersion: string; term: string; category?: string; topicId?: string }>;
  llmCalls: unknown[];
  tasks: TaskRowView[];
  setKv(key: string, value: unknown): Promise<void>;
}

function makeStore(options: { tasks?: Array<{ id: string; kind?: string; status?: string; payload?: unknown }>; notes?: Array<{ noteId: string; title?: string | null; content?: string | null; likes?: number; collects?: number; comments?: number }> }): { store: ReportServiceDeps['store'] } & FakeStoreHandle {
  const kv = new Map<string, string | Buffer>();
  const createdTasks: FakeStoreHandle['createdTasks'] = [];
  const statusUpdates: FakeStoreHandle['statusUpdates'] = [];
  const taskEvents: FakeStoreHandle['taskEvents'] = [];
  const reports: FakeStoreHandle['reports'] = [];
  const keywordHits: FakeStoreHandle['keywordHits'] = [];
  const llmCalls: unknown[] = [];
  let nextReportId = 1;

  const tasks: TaskRowView[] = (options.tasks ?? []).map((t) => ({
    id: t.id,
    kind: t.kind ?? 'collect',
    status: (t.status ?? 'awaiting_user') as TaskRowView['status'],
    payload: t.payload ?? null,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
  }));
  const notes = (options.notes ?? []).map((n, i) => ({
    id: i + 1,
    noteId: n.noteId,
    title: n.title ?? null,
    content: n.content ?? null,
    author: null,
    likes: n.likes ?? 0,
    collects: n.collects ?? 0,
    comments: n.comments ?? 0,
    tags: null,
    coverUrl: null,
    imageUrls: null,
    publishedAt: '2026-10-01T00:00:00.000Z',
    collectedAt: '2026-10-14T00:00:00.000Z',
  }));

  const store = {
    whenReady: async () => 3,
    kvGet: async (key: string) => kv.get(key) ?? null,
    kvSet: async (key: string, value: string | Buffer) => {
      kv.set(key, value);
      return { set: true };
    },
    kvDel: async (key: string) => ({ deleted: kv.delete(key) }),
    getTask: async (taskId: string) => tasks.find((t) => t.id === taskId) ?? null,
    listTasks: async () => [...tasks],
    listNotes: async () => notes,
    insertReport: async (input: { topic: string; report: unknown; contentMd?: string; gateState?: string; model?: string; tokenCost?: number }) => {
      const id = nextReportId;
      nextReportId += 1;
      reports.push({ id, ...input });
      return { written: true, id };
    },
    getReport: async (reportId: number) => {
      const row = reports.find((r) => r.id === reportId);
      return row ? { ...row, createdAt: '2026-10-14T00:00:00.000Z' } : null;
    },
    insertLlmCall: async (call: unknown) => {
      llmCalls.push(call);
      return { written: true, id: llmCalls.length };
    },
    insertKeywordHit: async (hit: { wordlistVersion: string; term: string }) => {
      keywordHits.push(hit);
      return { written: true, id: keywordHits.length };
    },
    createTask: async (task: { id: string; kind: string; payload?: unknown; idempotencyKey?: string }) => {
      createdTasks.push(task);
      tasks.push({
        id: task.id,
        kind: task.kind,
        status: 'idle',
        payload: task.payload ?? null,
        createdAt: '2026-10-14T00:00:00.000Z',
        updatedAt: '2026-10-14T00:00:00.000Z',
      });
      return { created: true, taskId: task.id };
    },
    updateTaskStatus: async (update: { taskId: string; status: TaskRowView['status'] }) => {
      statusUpdates.push({ taskId: update.taskId, status: update.status });
      const task = tasks.find((t) => t.id === update.taskId);
      if (task) task.status = update.status;
      return { updated: true, taskId: update.taskId, status: update.status };
    },
    writeTaskEvent: async (event: { taskId: string; type: string; payload?: unknown }) => {
      taskEvents.push({ taskId: event.taskId, type: event.type, payload: event.payload });
      return { written: true };
    },
  };

  return {
    store: store as unknown as ReportServiceDeps['store'],
    kv,
    createdTasks,
    statusUpdates,
    taskEvents,
    reports,
    keywordHits,
    llmCalls,
    tasks,
    setKv: async (key, value) => {
      kv.set(key, JSON.stringify(value));
    },
  };
}

function makeRunner() {
  return {
    awaitUser: vi.fn(async (_taskId: string, _reason?: string) => 'awaiting_user'),
    cancel: vi.fn(async (_taskId: string, _reason?: string) => 'cancelled'),
    resume: vi.fn(async (_taskId: string) => 'running'),
  };
}

type FakeWordlist = ReturnType<typeof makeWordlist>;

function makeWordlist(hitsFor: (keyword: string) => Array<{ term: string; category: string | null; kind: 'extreme' | 'redirect' | 'blacklist' }>, ready = true): ReportServiceDeps['wordlist'] {
  return {
    whenReady: Promise.resolve(ready ? '1.0.0' : null),
    activeVersion: () => (ready ? '1.0.0' : null),
    scanText: () => [],
    scanKeywords: (keywords: string[]) => keywords.flatMap(hitsFor),
  } as unknown as ReportServiceDeps['wordlist'];
}

function makeGateway(): StructuredGateway {
  return {
    structured: async (req) => {
      const title = req.name === 'report-chapter-methodology' ? '数据来源与方法说明' : req.name.replace('report-chapter-', '');
      const value = req.parse({ title, summary: `${title}摘要`, bullets: ['要点一', '要点二'] });
      return { value, strategy: 'prompt-embedded-schema', requestCount: 1, tokensIn: 10, tokensOut: 5 };
    },
  };
}

function notesFixture() {
  return Array.from({ length: 6 }, (_, i) => ({
    noteId: `n${i}`,
    title: `收纳好物测评第${i}篇`,
    content: `场景${i}：桌面收纳盒价格 1${i}0 元，宿舍收纳推荐。`,
    likes: 100 + i,
    collects: 50 + i,
    comments: 10 + i,
  }));
}

function makeDeps(options: { tasks?: Parameters<typeof makeStore>[0]['tasks']; notes?: Parameters<typeof makeStore>[0]['notes']; wordlist?: FakeWordlist; gateway?: StructuredGateway; withKey?: boolean } = {}) {
  const fake = makeStore({ tasks: options.tasks, notes: options.notes });
  const runner = makeRunner();
  const gateway = options.gateway ?? makeGateway();
  const telemetry: Array<{ name: string; payload?: unknown }> = [];
  const logger = {
    automationStep: () => {},
    userAction: () => {},
    systemError: () => {},
    child: () => logger,
  };
  const deps: ReportServiceDeps = {
    store: fake.store,
    runner: runner as unknown as TaskRunner,
    logger: logger as never,
    wordlist: options.wordlist ?? makeWordlist(() => []),
    createGateway: () => gateway,
    sendTelemetry: async (event) => {
      telemetry.push(event);
    },
    readKeyEntry: options.withKey === false
      ? async () => null
      : async (provider) => (provider === 'custom' ? { provider, baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', model: 'e2e-model' } : null),
    salt: 'unit-salt',
    seed: 7,
    now: () => new Date('2026-10-14T08:00:00.000Z'),
  };
  return { deps, runner, gateway, telemetry, ...fake };
}

const ctxBase: CollectReportStepContext = {
  taskId: 'task-1',
  payload: { topicId: 'topic-1', inputType: 'keyword', terms: ['x'], operator: 'or', userUrl: null, noteUrl: null, targetTotal: 50 },
  logger: { automationStep: () => {} } as never,
};

describe('关键词闸门纯函数', () => {
  it('幂等键 = sha256(topic:reportId)，同输入同值、异输入异值', () => {
    expect(keywordGateIdempotencyKey('t', 1)).toBe(keywordGateIdempotencyKey('t', 1));
    expect(keywordGateIdempotencyKey('t', 1)).not.toBe(keywordGateIdempotencyKey('t', 2));
    expect(keywordGateIdempotencyKey('t1', 2)).not.toBe(keywordGateIdempotencyKey('t', 12));
    expect(keywordGateIdempotencyKey('t', 1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keywordFromBullet 取词根段（冒号前），无分隔符取整条', () => {
    expect(keywordFromBullet('收纳好物源头工厂：直供价低')).toBe('收纳好物源头工厂');
    expect(keywordFromBullet(' pets supply words ')).toBe('pets supply words');
  });

  it('filterSelectionKeywords：命中词剔除且 keyword_hits 留痕；词库未就绪 fail-closed', async () => {
    const persisted: Array<{ wordlistVersion: string; term: string; topicId?: string }> = [];
    const wordlist = makeWordlist((keyword) => (keyword.includes('最好') ? [{ term: '最好', category: 'extreme-advertising', kind: 'extreme' }] : []));
    const outcome = await filterSelectionKeywords(wordlist, ['最好用的收纳柜：理由', '收纳好物源头工厂：理由'], 'topic-1', async (hit) => {
      persisted.push(hit);
    });
    expect(outcome.allowed).toEqual(['收纳好物源头工厂：理由']);
    expect(outcome.removed).toHaveLength(1);
    expect(outcome.removed[0]?.term).toBe('最好');
    expect(outcome.wordlistVersion).toBe('1.0.0');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.topicId).toBe('topic-1');

    const notReady = await filterSelectionKeywords(makeWordlist(() => [], false), ['任意词'], undefined, async () => {});
    expect(notReady.allowed).toEqual([]);
    expect(notReady.wordlistVersion).toBeNull();
  });
});

describe('collect-report 步骤（组合接线）', () => {
  it('happy：Key 已配置 → reports 落库（gateState=awaiting_keyword_confirm）+ 遥测 + keyword_confirm 闸门 + awaitUser', async () => {
    const handle = makeDeps({ notes: notesFixture() });
    const service = createReportService(handle.deps);
    const result = await service.runCollectReportStep(ctxBase);

    expect(result.gate).toBe(GATE_KEYWORD_CONFIRM);
    expect(result.reportId).toBe(1);
    expect(handle.reports).toHaveLength(1);
    expect(handle.reports[0]?.gateState).toBe('awaiting_keyword_confirm');
    expect(handle.telemetry.some((e) => e.name === 'first_report_generated')).toBe(true);
    expect(handle.runner.awaitUser).toHaveBeenCalledWith('task-1', expect.stringContaining('keyword-confirm-gate'));
    expect(handle.taskEvents.some((e) => e.type === 'REPORT_GATE_SET')).toBe(true);

    const pending = JSON.parse(String(handle.kv.get(gatePendingKey('task-1')))) as { gate: string; reportId: number; mono?: string };
    expect(pending.gate).toBe(GATE_KEYWORD_CONFIRM);
    expect(pending.reportId).toBe(1);
    expect(pending.mono).toMatch(/^\d+$/);
  });

  it('Key 未配置 → CollectReportGateSignal(llm_key_config) + gate 挂起记录，不调用 awaitUser', async () => {
    const handle = makeDeps({ notes: notesFixture(), withKey: false });
    const service = createReportService(handle.deps);
    await expect(service.runCollectReportStep(ctxBase)).rejects.toBeInstanceOf(CollectReportGateSignal);
    expect(handle.runner.awaitUser).not.toHaveBeenCalled();
    const pending = JSON.parse(String(handle.kv.get(gatePendingKey('task-1')))) as { gate: string };
    expect(pending.gate).toBe(GATE_LLM_KEY_CONFIG);
  });

  it('⑦章建议词在落闸门前过词库黑名单：命中剔除 + keyword_hits 留痕 + 过滤面缓存', async () => {
    const gateway = makeGateway();
    const wordlist = makeWordlist((keyword) => (keyword.includes('最好') ? [{ term: '最好', category: 'extreme-advertising', kind: 'extreme' }] : []));
    const handle = makeDeps({ notes: notesFixture(), wordlist, gateway: {
      structured: async (req) => {
        if (req.name === 'report-chapter-selectionKeywords') {
          const value = req.parse({ title: '⑦', summary: 's', bullets: ['最好用的收纳柜：理由', '收纳好物源头工厂：理由'] });
          return { value, strategy: 'prompt-embedded-schema', requestCount: 1, tokensIn: 1, tokensOut: 1 };
        }
        return gateway.structured(req);
      },
    } });
    const service = createReportService(handle.deps);
    await service.runCollectReportStep(ctxBase);

    expect(handle.keywordHits).toHaveLength(1);
    expect(handle.keywordHits[0]?.term).toBe('最好');
    expect(handle.keywordHits[0]?.topicId).toBe('topic-1');
    const filter = JSON.parse(String(handle.kv.get('report:kwfilter:1'))) as { allowed: string[]; removed: unknown[] };
    expect(filter.allowed).toEqual(['收纳好物源头工厂：理由']);
    expect(filter.removed).toHaveLength(1);
  });
});

describe('闸门状态机（确认/拒绝/幂等）', () => {
  async function seedKeywordGate() {
    const handle = makeDeps({ tasks: [{ id: 'task-1' }], notes: notesFixture() });
    const service = createReportService(handle.deps);
    await service.runCollectReportStep(ctxBase);
    return { service, ...handle };
  }

  it('确认 → selection 占位任务（queued + idempotency_key）+ collect 任务 resume 收口', async () => {
    const handle = await seedKeywordGate();
    const result = await handle.service.confirmGate('task-1');

    expect(result.created).toBe(true);
    expect(result.selectionTaskId).toBeTruthy();
    expect(result.idempotencyKey).toBe(keywordGateIdempotencyKey('topic-1', 1));
    expect(handle.createdTasks).toHaveLength(1);
    expect(handle.createdTasks[0]?.kind).toBe('selection');
    expect(handle.createdTasks[0]?.idempotencyKey).toBe(result.idempotencyKey);
    expect(handle.statusUpdates).toContainEqual({ taskId: result.selectionTaskId, status: 'queued' });
    expect(handle.taskEvents.some((e) => e.type === 'TASK_ENQUEUE')).toBe(true);
    expect(handle.runner.resume).toHaveBeenCalledWith('task-1');
  });

  it('重复确认幂等 no-op：不新建任务（created=false，selectionTaskId 不变）', async () => {
    const handle = await seedKeywordGate();
    const first = await handle.service.confirmGate('task-1');
    const second = await handle.service.confirmGate('task-1');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.selectionTaskId).toBe(first.selectionTaskId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(handle.createdTasks).toHaveLength(1);
  });

  it('拒绝 → runner.cancel（awaiting_user → cancelled）+ 挂起指针清除；重复拒绝幂等', async () => {
    const handle = await seedKeywordGate();
    handle.runner.cancel.mockImplementation(async (taskId: string) => {
      const task = handle.tasks.find((t) => t.id === taskId);
      if (task) task.status = 'cancelled';
      return 'cancelled' as const;
    });
    const first = await handle.service.rejectGate('task-1');
    expect(first.status).toBe('cancelled');
    expect(handle.runner.cancel).toHaveBeenCalledWith('task-1', expect.stringContaining('gate-rejected'));
    expect(handle.kv.has(gatePendingKey('task-1'))).toBe(false);
    const second = await handle.service.rejectGate('task-1');
    expect(second.status).toBe('cancelled');
    expect(handle.runner.cancel).toHaveBeenCalledTimes(1);
  });

  it('非 awaiting_user 态确认 → E-GATE-NOT-AWAITING 稳定错误码', async () => {
    const handle = makeDeps({ tasks: [{ id: 'task-x', status: 'completed' }] });
    const service = createReportService(handle.deps);
    await expect(service.confirmGate('task-x')).rejects.toThrow('E-GATE-NOT-AWAITING');
  });
});

describe('读面（gates/reports/chartData/fixture）', () => {
  it('listGates：awaiting_user × pending kv → 两值 gate 枚举视图 + 过滤面', async () => {
    const handle = makeDeps({ tasks: [{ id: 'task-1' }] });
    await handle.setKv(gatePendingKey('task-1'), { gate: GATE_KEYWORD_CONFIRM, reportId: 3, topicId: 'topic-1', topic: 'topic-1', createdAt: '2026-10-14T00:00:00.000Z' });
    await handle.setKv('gate:keywords:task-1', { allowed: ['a'], removed: [], wordlistVersion: '1.0.0', persisted: 0 });
    const result = await createReportService(handle.deps).listGates();
    expect(result.gates).toHaveLength(1);
    expect(result.gates[0]?.gate).toBe('keyword_confirm');
    expect(result.gates[0]?.reportId).toBe(3);
    expect(result.gates[0]?.keywords?.allowed).toEqual(['a']);
  });

  it('chartData：聚类气泡/价格带直方/词云来自 notes 确定性统计', async () => {
    const handle = makeDeps({ notes: notesFixture() });
    await handle.setKv('report:meta:9', { topicId: 'topic-1' });
    const data = await createReportService(handle.deps).chartData(9);
    expect(data.sampleSize).toBe(6);
    expect(data.clusters.length).toBeGreaterThanOrEqual(1);
    expect(data.priceBuckets.ranges).toEqual(['<100', '100-200', '200-300', '300+']);
    expect(data.priceBuckets.counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(data.wordcloud.length).toBeGreaterThan(0);
  });

  it('listReports 走 report:index kv；insertFixtureReport 登记索引', async () => {
    const handle = makeDeps({});
    const service = createReportService(handle.deps);
    const fixture = await service.insertFixtureReport({ topic: 'bad-topic', report: { broken: true } });
    expect(fixture.id).toBe(1);
    const list = await service.listReports();
    expect(list.reports).toHaveLength(1);
    expect(list.reports[0]?.topic).toBe('bad-topic');
    expect(JSON.parse(String(handle.kv.get(KV_REPORT_INDEX)))).toHaveLength(1);
  });

  it('getReportView 返回报告 + ⑦章过滤面；不存在 → report=null', async () => {
    const handle = makeDeps({});
    const service = createReportService(handle.deps);
    const missing = await service.getReportView(5);
    expect(missing.report).toBeNull();
    expect(missing.keywordFilter).toBeNull();
    await handle.deps.store.insertReport({ topic: 't', report: { chapters: {} } });
    const existing = await service.getReportView(1);
    expect(existing.report).toEqual({ chapters: {} });
  });
});

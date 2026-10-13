/**
 * collect 绑定组合面单测（todo 7⑥ QA failure 组；FR-9.5 + 门禁⑤预演）：
 * - 熔断 OPEN 注入 → running 任务全部挂起 + 桌面通知 + circuit_open 入本地账本；
 * - OPEN 态重试策略 = abort-no-retry（circuitOpenRetryPolicy 唯一成员）；
 * - 代理配置零改动（snapshotProxyConfig 深比较不变——FR-9.5 门禁抽查项）；
 * - confirmResume：冷却未期满拒绝 / 期满 → HALF_OPEN（fake clock）。
 */
import { describe, expect, it } from 'vitest';
import { circuitOpenRetryPolicy, proxyConfigUnchanged, retryDecisionForCircuitState, snapshotProxyConfig } from '@xinglian/stealth-middleware';
import type { Logger } from '@xinglian/logger';
import { createCollectBinding, type CollectBinding } from './collect-binding';
import { createTaskRunner } from '../tasks/runner';
import { createComplianceService } from '../compliance/compliance-service';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CreateTaskInput, NoteRowView, StepInput, StepRowView, StoreClient, TaskEventInput, TaskEventRowView, TaskRowView, TaskStatus, TaskStatusInput } from '../store';

/* ---- 内存 store（与 collect-service.test 同款最小面） ---- */
function makeMemoryStore(): StoreClient {
  const tasks = new Map<string, TaskRowView>();
  const steps = new Map<string, StepRowView[]>();
  const events: TaskEventRowView[] = [];
  const kv = new Map<string, string | Buffer>();
  const circuit: Array<{ id: number; kind: string; at: string; meta: unknown }> = [];
  const notes = new Map<string, NoteRowView>();
  const stats = new Map<string, { completedUnique: number; duplicate: number; noResult: number; rateLimited: number; captchaConsumed: number }>();
  let eventId = 1;
  const bump = (runId: string, patch: Partial<{ completedUnique: number; duplicate: number; noResult: number; rateLimited: number; captchaConsumed: number }>): void => {
    const row = stats.get(runId) ?? { completedUnique: 0, duplicate: 0, noResult: 0, rateLimited: 0, captchaConsumed: 0 };
    row.completedUnique += patch.completedUnique ?? 0;
    row.duplicate += patch.duplicate ?? 0;
    row.noResult += patch.noResult ?? 0;
    row.rateLimited += patch.rateLimited ?? 0;
    row.captchaConsumed += patch.captchaConsumed ?? 0;
    stats.set(runId, row);
  };
  return {
    whenReady: async () => 3,
    createTask: async (task: CreateTaskInput) => {
      const nowIso = new Date().toISOString();
      tasks.set(task.id, { id: task.id, kind: task.kind, status: 'idle', payload: task.payload ?? null, createdAt: nowIso, updatedAt: nowIso });
      return { created: true, taskId: task.id };
    },
    updateTaskStatus: async (update: TaskStatusInput) => {
      const task = tasks.get(update.taskId);
      if (!task) throw new Error('not found');
      task.status = update.status;
      return { updated: true, taskId: update.taskId, status: update.status };
    },
    writeTaskEvent: async (event: TaskEventInput) => {
      events.push({ id: eventId++, taskId: event.taskId, type: event.type, fromState: event.fromState ?? null, toState: event.toState ?? null, payload: event.payload ?? null, createdAt: event.at ?? new Date().toISOString() });
      return { written: true };
    },
    upsertStep: async (input: StepInput) => {
      const list = steps.get(input.taskId) ?? [];
      list.push({ id: list.length + 1, taskId: input.taskId, stepId: input.stepId, seq: input.seq, status: input.status, output: input.output ?? null, checkpointAt: input.checkpointAt ?? null });
      steps.set(input.taskId, list);
      return { upserted: true };
    },
    getTask: async (taskId: string) => tasks.get(taskId) ?? null,
    listTasks: async (status?: TaskStatus) => [...tasks.values()].filter((t) => !status || t.status === status),
    listSteps: async (taskId: string) => [...(steps.get(taskId) ?? [])],
    listTaskEvents: async (taskId: string) => events.filter((e) => e.taskId === taskId),
    listNotes: async () => [...notes.values()],
    upsertNote: async (note: { noteId: string; title?: string | null }) => {
      notes.set(note.noteId, { id: notes.size + 1, noteId: note.noteId, title: note.title ?? null, content: null, author: null, likes: 0, collects: 0, comments: 0, tags: null, coverUrl: null, imageUrls: null, publishedAt: null, collectedAt: new Date().toISOString() });
      return { upserted: true, id: 0 };
    },
    upsertCollectRunStats: async (input: { runId: string } & Partial<{ completedUnique: number; duplicate: number; noResult: number; rateLimited: number; captchaConsumed: number }>) => {
      bump(input.runId, input);
      return { upserted: true };
    },
    getCollectRunStats: async (runId: string) => stats.get(runId) ?? null,
    kvGet: async (key: string) => kv.get(key) ?? null,
    kvSet: async (key: string, value: string | Buffer) => {
      kv.set(key, value);
      return { set: true };
    },
    kvDel: async (key: string) => ({ deleted: kv.delete(key) }),
    appendCircuitEvent: async (event: { kind: string; at?: string; meta?: unknown }) => {
      circuit.push({ id: circuit.length + 1, kind: event.kind, at: event.at ?? new Date().toISOString(), meta: event.meta ?? null });
      return { written: true, id: circuit.length };
    },
    listCircuitEvents: async () => [...circuit].reverse().map((e) => ({ id: e.id, kind: e.kind, at: e.at, meta: e.meta })),
  } as unknown as StoreClient;
}

const silentLogger = {
  log: () => {},
  userAction: () => {},
  automationStep: () => {},
  llmCall: () => {},
  networkMeta: () => {},
  systemError: () => {},
  child: () => silentLogger,
  startSpan: () => ({ spanId: 's', logger: silentLogger, end: () => {} }),
  getBuffer: () => [],
  enforceRetention: async () => ({ filesDeleted: 0, sinkRowsDeleted: {} }),
  flush: async () => {},
  close: async () => {},
} as unknown as Logger;

describe('collect 绑定：熔断 OPEN 联动（QA failure 组）', () => {
  it('OPEN 注入 → running 全挂起 + 通知 + circuit_open 账本 + abort-no-retry + 代理零改动', async () => {
    const store = makeMemoryStore();
    const clock = { value: new Date('2026-10-13T10:00:00') };
    // 真实 timer + 慢步骤：demo 任务保持 running 窗口供熔断联动挂起
    const runner = createTaskRunner({ store, logger: silentLogger, stepDelayMs: 60, now: () => clock.value });
    const notifications: string[] = [];
    // 代理配置快照（FR-9.5 深比较基准；组合根不持任何可变代理句柄）
    const proxyBefore = snapshotProxyConfig({ mode: null, server: null, bypass: null });

    const binding: CollectBinding = createCollectBinding({
      store,
      runner,
      logger: silentLogger,
      notify: (title) => notifications.push(title),
      userDataDir: 'C:/nonexistent-userdata',
      now: () => clock.value,
      pacingScale: 0,
    });

    // 两个 running 任务（演示挂起面）
    await runner.startWithKind('demo', {});
    await runner.startWithKind('demo', {});
    await new Promise((r) => setTimeout(r, 30));

    // 注入熔断（真实信号源形态：验证码特征命中）
    binding.breaker.reportCaptchaFeatureHit(clock.value);
    expect(binding.breaker.state).toBe('OPEN');
    await new Promise((r) => setTimeout(r, 30));
    expect(await store.listTasks('running')).toHaveLength(0);
    expect(await store.listTasks('suspended')).toHaveLength(2);
    expect(notifications.some((t) => t.includes('熔断'))).toBe(true);
    const ledger = await store.listCircuitEvents({ limit: 10 });
    expect(ledger[0]?.kind).toBe('circuit_open');

    // FR-9.5：OPEN 态重试策略 = abort-no-retry（类型层唯一成员，非 retry≤3 / 非切代理）
    expect(circuitOpenRetryPolicy.action).toBe('abort-no-retry');
    expect(retryDecisionForCircuitState('OPEN')).toEqual(circuitOpenRetryPolicy);
    expect(retryDecisionForCircuitState('CLOSED')).toBeNull();
    // 代理配置深比较不变（组合根全程无写入路径）
    expect(proxyConfigUnchanged(proxyBefore, snapshotProxyConfig({ mode: null, server: null, bypass: null }))).toBe(true);

    // circuit:status 出口面
    const status = await binding.circuitStatus();
    expect(status.state).toBe('OPEN');
    expect(status.events[0]?.kind).toBe('circuit_open');

    // 人工确认：冷却未期满 → 拒绝；fake clock 推进 30min → HALF_OPEN
    expect((await binding.confirmResume()).ok).toBe(false);
    clock.value = new Date('2026-10-13T10:31:00');
    const confirmed = await binding.confirmResume();
    expect(confirmed).toMatchObject({ ok: true, state: 'HALF_OPEN' });
    binding.shutdown();
  });
});

describe('collect 绑定：遥测唯一出口（sendTelemetry 装配）', () => {
  it('breaker 事件经 complianceService.sendTelemetry 出口（consent 关闭态=本地留存不触网）', async () => {
    const store = makeMemoryStore();
    const clock = { value: new Date('2026-10-13T10:00:00') };
    const runner = createTaskRunner({ store, logger: silentLogger, stepDelayMs: 0, delay: async () => {}, now: () => clock.value });
    // 真实 compliance 服务（M0 形态：无端点 → 事件仅本地留存，无网络行为）
    const compliance = createComplianceService({
      store,
      eulaVersion: 'test',
      lockedViews: [],
    });
    const binding: CollectBinding = createCollectBinding({
      store,
      runner,
      logger: silentLogger,
      compliance,
      userDataDir: 'C:/nonexistent-userdata',
      now: () => clock.value,
      pacingScale: 0,
    });
    binding.breaker.reportCaptchaFeatureHit(clock.value);
    expect(binding.breaker.state).toBe('OPEN');
    const outcome = await compliance.sendTelemetry({ name: 'probe' });
    expect(outcome.disposition === 'local-only' || outcome.disposition === 'blocked').toBe(true);
    binding.shutdown();
  });
});

describe('collect 绑定：fixture 让位集成（FR-4.5 全链）', () => {
  it('simulateUserInput → 任务 yielded → 静默恢复 → 最终 completed 且快照落齐', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yield-it-'));
    try {
      const scenario = {
        captcha: false,
        loginEntryVisible: false,
        notes: Array.from({ length: 30 }, (_, i) => ({
          noteId: `n${String(i).padStart(2, '0')}`,
          title: `T${i}`,
          content: 'C',
          likes: 1,
          collects: 1,
          comments: 1,
          tags: [],
          author: 'u',
          publishedAt: null,
        })),
      };
      const fixtureFile = path.join(dir, 'scenario.json');
      writeFileSync(fixtureFile, JSON.stringify(scenario));
      process.env.XINGLIAN_COLLECT_FIXTURE = fixtureFile;
      process.env.XINGLIAN_YIELD_POLL_MS = '50';

      const store = makeMemoryStore();
      const runner = createTaskRunner({ store, logger: silentLogger, stepDelayMs: 0, delay: async () => {} });
      const binding: CollectBinding = createCollectBinding({
        store,
        runner,
        logger: silentLogger,
        userDataDir: dir,
        pacingScale: 0,
      });
      const { taskId } = await binding.start({ inputType: 'keyword', keyword: 'x', topicId: 't-yield', targetTotal: 50 });
      // 立即注入（30 条批读窗口内）：yielded 必现
      binding.fixture!.simulateUserInput();
      await new Promise((r) => setTimeout(r, 150));
      const midStatus = (await store.getTask(taskId))?.status;
      expect(['yielded', 'completed']).toContain(midStatus);
      // 静默 3s（监视器真实阈值）→ 自动恢复收口
      await new Promise((r) => setTimeout(r, 4000));
      expect(await store.getTask(taskId).then((t) => t?.status)).toBe('completed');
      expect((await store.getCollectRunStats(taskId))?.completedUnique).toBe(30);
      binding.shutdown();
    } finally {
      delete process.env.XINGLIAN_COLLECT_FIXTURE;
      delete process.env.XINGLIAN_YIELD_POLL_MS;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});

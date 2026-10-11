/**
 * 任务生命周期状态机 + 最小运行器单测（D7 / 02 §9.1 + §6.1）：
 * - 合法/非法迁移表（S9：只有任务级宏状态）；
 * - 启动恢复 running→suspended 降级（02:453）；
 * - 检查点续跑：completed 步骤跳过（output.runToken 不变 = 未重跑）；
 * - 取消 = 安全点停止；失败 → failed + 事件流水完整。
 */
import { describe, expect, it } from 'vitest';
import { resolveTransition, TASK_STATES, type TaskLifecycleEvent, type TaskLifecycleState } from './machine';
import { createTaskRunner, type TaskRunner, DEMO_STEPS, type TaskView } from './runner';
import type { CreateTaskInput, StepInput, StepRowView, StoreClient, TaskEventInput, TaskEventRowView, TaskRowView, TaskStatus, TaskStatusInput } from '../store';
// eslint-disable-next-line no-restricted-imports -- todo 11：Logger 类型源=logger 基础设施包（边界例外已记录于证据文件）
import type { Logger } from '@xinglian/logger';

/* ------------------------------ 状态机 ------------------------------ */

describe('XState 任务生命周期（02 §9.1 M0 最小集）', () => {
  it('状态集恰为六态（无步骤级状态混入——S9 边界）', () => {
    expect(TASK_STATES).toEqual(['idle', 'running', 'suspended', 'completed', 'failed', 'cancelled']);
  });

  const cases: Array<[TaskLifecycleState, TaskLifecycleEvent, TaskLifecycleState]> = [
    ['idle', { type: 'TASK_START' }, 'running'],
    ['running', { type: 'TASK_SUSPEND', reason: 'r' }, 'suspended'],
    ['running', { type: 'TASK_COMPLETE' }, 'completed'],
    ['running', { type: 'TASK_FAIL', reason: 'r' }, 'failed'],
    ['running', { type: 'TASK_CANCEL' }, 'cancelled'],
    ['suspended', { type: 'TASK_RESUME' }, 'running'],
    ['suspended', { type: 'TASK_CANCEL' }, 'cancelled'],
  ];
  for (const [from, event, to] of cases) {
    it(`${from} --${event.type}--> ${to}`, () => {
      expect(resolveTransition(from, event, { taskId: 't', kind: 'demo' })).toBe(to);
    });
  }

  const illegal: Array<[TaskLifecycleState, TaskLifecycleEvent]> = [
    ['idle', { type: 'TASK_COMPLETE' }],
    ['idle', { type: 'TASK_SUSPEND', reason: 'r' }],
    ['completed', { type: 'TASK_START' }],
    ['failed', { type: 'TASK_RESUME' }],
    ['cancelled', { type: 'TASK_START' }],
    ['completed', { type: 'TASK_CANCEL' }],
  ];
  for (const [from, event] of illegal) {
    it(`非法迁移被拒：${from} --${event.type}--> null`, () => {
      expect(resolveTransition(from, event, { taskId: 't', kind: 'demo' })).toBeNull();
    });
  }
});

/* ------------------------------ 运行器（内存 store） ------------------------------ */

/** 内存 store：最小实现任务运行器用到的读写面 */
function makeMemoryStore(): { store: StoreClient; dump: () => { tasks: Map<string, TaskRowView>; steps: Map<string, StepRowView[]>; events: TaskEventRowView[] } } {
  const tasks = new Map<string, TaskRowView>();
  const steps = new Map<string, StepRowView[]>();
  const events: TaskEventRowView[] = [];
  let eventId = 1;
  const upsertStep = (input: StepInput): void => {
    const list = steps.get(input.taskId) ?? [];
    const existing = list.find((s) => s.stepId === input.stepId);
    if (existing) {
      existing.status = input.status;
      existing.output = input.output ?? existing.output;
      existing.checkpointAt = input.checkpointAt ?? existing.checkpointAt;
    } else {
      list.push({ id: list.length + 1, taskId: input.taskId, stepId: input.stepId, seq: input.seq, status: input.status, output: input.output ?? null, checkpointAt: input.checkpointAt ?? null });
      list.sort((a, b) => a.seq - b.seq);
    }
    steps.set(input.taskId, list);
  };
  const store = {
    whenReady: () => Promise.resolve(1),
    createTask: async (task: CreateTaskInput) => {
      const now = new Date().toISOString();
      tasks.set(task.id, { id: task.id, kind: task.kind, status: 'idle', payload: task.payload ?? null, createdAt: now, updatedAt: now });
      return { created: true, taskId: task.id };
    },
    updateTaskStatus: async (update: TaskStatusInput) => {
      const task = tasks.get(update.taskId);
      if (!task) throw new Error(`task not found: ${update.taskId}`);
      task.status = update.status;
      return { updated: true, taskId: update.taskId, status: update.status };
    },
    writeTaskEvent: async (event: TaskEventInput) => {
      events.push({ id: eventId++, taskId: event.taskId, type: event.type, fromState: event.fromState ?? null, toState: event.toState ?? null, payload: event.payload ?? null, createdAt: event.at ?? new Date().toISOString() });
      return { written: true };
    },
    upsertStep: async (input: StepInput) => {
      upsertStep(input);
      return { upserted: true };
    },
    getTask: async (taskId: string) => tasks.get(taskId) ?? null,
    listTasks: async (status?: TaskStatus) => [...tasks.values()].filter((t) => !status || t.status === status),
    listSteps: async (taskId: string) => [...(steps.get(taskId) ?? [])],
    listTaskEvents: async (taskId: string) => events.filter((e) => e.taskId === taskId),
  } as unknown as StoreClient;
  return { store, dump: () => ({ tasks, steps, events: [...events] }) };
}

const silentLogger: Logger = {
  categories: ['user-action', 'automation-step', 'llm-call', 'network-meta', 'system-error'],
  log: () => {},
  userAction: () => {},
  automationStep: () => {},
  llmCall: () => {},
  networkMeta: () => {},
  systemError: () => {},
  child: () => silentLogger,
  startSpan: () => ({ spanId: 'span-test', logger: silentLogger, end: () => {} }),
  getBuffer: () => [],
  enforceRetention: async () => ({ filesDeleted: 0, sinkRowsDeleted: {} }),
  flush: async () => {},
  close: async () => {},
} as unknown as Logger;

function makeRunner(store: StoreClient, stepDelayMs = 0): TaskRunner {
  return createTaskRunner({ store, logger: silentLogger, stepDelayMs, delay: async () => {} });
}

function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (condition()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitUntil 超时'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('demo 任务全生命周期（内存 store）', () => {
  it('startDemo：三步全部完成 + 事件流水完整（idle→running→completed）+ 检查点齐备', async () => {
    const { store, dump } = makeMemoryStore();
    const runner = makeRunner(store);
    const taskId = await runner.startDemo();
    await waitUntil(() => dump().tasks.get(taskId)?.status === 'completed');

    const view = (await runner.getTaskView(taskId)) as TaskView;
    expect(view.status).toBe('completed');
    expect(view.steps).toHaveLength(DEMO_STEPS.length);
    for (const step of view.steps) {
      expect(step.status).toBe('completed');
      expect(step.checkpointAt).toBeTruthy();
      expect((step.output as { attempts: number }).attempts).toBe(1);
    }
    const eventTypes = dump().events.filter((e) => e.taskId === taskId).map((e) => e.type);
    expect(eventTypes).toEqual(['TASK_START', 'TASK_COMPLETE']);
  });

  it('取消：运行中安全点停止 → cancelled，后续步骤不执行', async () => {
    const { store, dump } = makeMemoryStore();
    const runner = createTaskRunner({ store, logger: silentLogger, stepDelayMs: 25 });
    const taskId = await runner.startDemo();
    await waitUntil(() => (dump().steps.get(taskId)?.length ?? 0) >= 1);
    const status = await runner.cancel(taskId, 'test-cancel');
    expect(status).toBe('cancelled');
    await waitUntil(() => dump().tasks.get(taskId)?.status === 'cancelled');
    const eventTypes = dump().events.filter((e) => e.taskId === taskId).map((e) => e.type);
    expect(eventTypes[eventTypes.length - 1]).toBe('TASK_CANCEL');
  });

  it('resume 对非 suspended 任务报错（状态门禁）', async () => {
    const { store } = makeMemoryStore();
    const runner = makeRunner(store);
    const taskId = await runner.startDemo();
    await waitUntil(() => true);
    await expect(runner.resume(taskId)).rejects.toThrow(/仅 suspended 可恢复/);
  });
});

describe('启动恢复 + 检查点续跑（02:453 + §6.1）', () => {
  it('running 任务 boot 后降级 suspended；新进程 resume 跳过已完成步骤（runToken 不变=未重跑）', async () => {
    const { store, dump } = makeMemoryStore();
    const runnerA = makeRunner(store);

    // 第一段生命周期：跑到第一步检查点后"完成"（等待真实完成，避免与后台 drive 竞态）
    const taskId = await runnerA.startDemo();
    await waitUntil(() => dump().tasks.get(taskId)?.status === 'completed');
    const stepsBefore = (dump().steps.get(taskId) ?? []).map((s) => ({ ...s }));
    const tokensBefore = new Map(
      stepsBefore.filter((s) => s.status === 'completed').map((s) => [s.stepId, (s.output as { runToken: string }).runToken]),
    );

    // 人工重建"崩溃现场"：kill 后 DB 里残留 running（02:453 场景）；模拟重启 = 新 runner 实例（actor 表为空）
    dump().tasks.get(taskId)!.status = 'running';
    const runnerB = makeRunner(store);

    // 启动恢复：running → suspended
    const downgraded = await runnerB.recoverOnBoot();
    expect(downgraded).toContain(taskId);
    expect(dump().tasks.get(taskId)?.status).toBe('suspended');
    const recoveryEvent = dump().events.filter((e) => e.taskId === taskId).at(-1);
    expect(recoveryEvent?.type).toBe('TASK_SUSPEND');

    // resume（跨进程路径）：已完成步骤 runToken 不变（未重跑）
    const status = await runnerB.resume(taskId);
    expect(status).toBe('running');
    await waitUntil(() => dump().tasks.get(taskId)?.status === 'completed');

    const view = (await runnerB.getTaskView(taskId)) as TaskView;
    expect(view.status).toBe('completed');
    for (const step of view.steps) {
      if (tokensBefore.has(step.stepId)) {
        expect((step.output as { runToken: string }).runToken).toBe(tokensBefore.get(step.stepId));
        expect((step.output as { attempts: number }).attempts).toBe(1);
      }
    }
    // 事件流水包含 TASK_RESUME，尾事件 TASK_COMPLETE
    const types = dump().events.filter((e) => e.taskId === taskId).map((e) => e.type);
    expect(types).toContain('TASK_RESUME');
    expect(types[types.length - 1]).toBe('TASK_COMPLETE');
  });
});

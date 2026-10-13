/**
 * 最小任务运行器（D7 扩展：M0 门禁④唯一演示载体；02 §6.1 检查点 + §9.1 状态机）。
 *
 * - XState 管任务宏状态（S9 边界）：每次迁移写 tasks.status + task_events（02 §9.1 持久化规则）；
 * - 步骤拓扑 = 串行 DAG（M0 无业务 DAG）：kind=demo 三步哑步骤，每步成功写 task_steps 检查点
 *   （02 §6.1：恢复时跳过已完成步骤）；步骤进度/游标不进 XState；
 * - 启动恢复（02:453）：status=running 一律降级 suspended，调用方触发 resume 按检查点续跑；
 * - 禁止实现任何业务步骤（采集/发布等 = M1-M3），demo 步骤仅为计时占位。
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '@xinglian/logger';
import { resolveTransition, spawnTaskActor, type TaskLifecycleEvent, type TaskLifecycleState } from './machine';
import type { StepInput, StoreClient, TaskStatus } from '../store';

export interface TaskRunnerDeps {
  readonly store: Pick<
    StoreClient,
    | 'whenReady'
    | 'createTask'
    | 'updateTaskStatus'
    | 'writeTaskEvent'
    | 'upsertStep'
    | 'getTask'
    | 'listTasks'
    | 'listSteps'
    | 'listTaskEvents'
  >;
  readonly logger: Logger;
  /** 哑步骤的"工作量"（计时占位）；默认 600ms —— 保证 kill-recover e2e 有可命中窗口 */
  readonly stepDelayMs?: number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

export interface TaskStepView {
  stepId: string;
  seq: number;
  status: string;
  output: unknown;
  checkpointAt: string | null;
}

export interface TaskView {
  id: string;
  kind: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  steps: TaskStepView[];
}

/** kind=demo 的哑步骤拓扑（3 步；仅计时占位） */
export const DEMO_STEPS = ['demo-prepare', 'demo-process', 'demo-finalize'] as const;

interface ActorBox {
  state: TaskLifecycleState;
  snapshot: unknown;
  cancelled: boolean;
  /** tasks.kind（02 §14.1）——任务级元数据透传给状态机 context，禁止硬编码 */
  kind: string;
  /** 当前 drive 循环（suspend→resume 时新 drive 先等旧 drive 在安全点退出，杜绝双驱动竞态） */
  drivePromise?: Promise<void>;
}

export class TaskRunner {
  private readonly actors = new Map<string, ActorBox>();
  private readonly stepDelayMs: number;
  private readonly delayFn: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly deps: TaskRunnerDeps) {
    this.stepDelayMs = deps.stepDelayMs ?? 600;
    this.delayFn = deps.delay ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    this.now = deps.now ?? (() => new Date());
  }

  /** 启动恢复：running → suspended（02:453）；返回降级任务 id 列表 */
  async recoverOnBoot(): Promise<string[]> {
    await this.deps.store.whenReady();
    const running = await this.deps.store.listTasks('running');
    const downgraded: string[] = [];
    for (const task of running) {
      // 状态机为迁移合法性唯一真源：降级也走 XState 判定
      const next = resolveTransition('running', { type: 'TASK_SUSPEND', reason: 'boot-recovery' }, { taskId: task.id, kind: task.kind });
      if (next === 'suspended') {
        await this.deps.store.updateTaskStatus({ taskId: task.id, status: 'suspended' });
        await this.deps.store.writeTaskEvent({
          taskId: task.id,
          type: 'TASK_SUSPEND',
          fromState: 'running',
          toState: 'suspended',
          payload: { reason: 'boot-recovery（启动恢复降级，02:453）' },
        });
        downgraded.push(task.id);
      }
    }
    this.deps.logger.systemError('boot-recovery-complete', {
      downgradedCount: downgraded.length,
      note: '启动恢复流水（02:453 持久化规则；system-error 类承载系统级事件样例）',
    });
    return downgraded;
  }

  /** 创建并启动 kind=demo 合成任务（门禁④唯一演示载体；无任何业务语义） */
  async startDemo(): Promise<string> {
    await this.deps.store.whenReady();
    const taskId = randomUUID();
    const traceId = randomUUID();
    await this.deps.store.createTask({ id: taskId, kind: 'demo', payload: { traceId, steps: [...DEMO_STEPS] } });
    const box: ActorBox = { state: 'idle', snapshot: undefined, cancelled: false, kind: 'demo' };
    this.actors.set(taskId, box);
    await this.applyLifecycle(taskId, box, { type: 'TASK_START' }, traceId);
    box.drivePromise = this.drive(taskId, traceId, box);
    return taskId;
  }

  /** 按检查点续跑（02 §6.1）：跳过 task_steps 中已完成步骤 */
  async resume(taskId: string): Promise<TaskStatus> {
    await this.deps.store.whenReady();
    const task = await this.deps.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== 'suspended') throw new Error(`task ${taskId} 状态为 ${task.status}，仅 suspended 可恢复`);
    const payload = (task.payload ?? {}) as { traceId?: string };
    const traceId = payload.traceId ?? randomUUID();

    let box = this.actors.get(taskId);
    if (!box) {
      // 跨进程恢复：从最近一次迁移事件的 XState 快照水合（事件流水尾 = suspended 迁移）
      const events = await this.deps.store.listTaskEvents(taskId);
      const latest = events[events.length - 1];
      const snapshot = (latest?.payload as { machineSnapshot?: unknown } | undefined)?.machineSnapshot;
      box = { state: 'suspended', snapshot, cancelled: false, kind: task.kind };
      this.actors.set(taskId, box);
    } else if (box.drivePromise) {
      // 同进程挂起→恢复：旧 drive 在步骤边界观察到 suspended 已退出；等待落定再续跑
      await box.drivePromise.catch(() => {});
      box.drivePromise = undefined;
    }
    await this.applyLifecycle(taskId, box, { type: 'TASK_RESUME', reason: 'resume-from-checkpoint' }, traceId);
    box.drivePromise = this.drive(taskId, traceId, box);
    return 'running';
  }

  async cancel(taskId: string, reason = 'user-cancel'): Promise<TaskStatus> {
    const task = await this.deps.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const box = this.actors.get(taskId);
    if (box) box.cancelled = true;
    const from = task.status as TaskLifecycleState;
    const next = resolveTransition(from, { type: 'TASK_CANCEL', reason }, { taskId, kind: task.kind });
    if (next === null) return task.status as TaskStatus;
    if (box) {
      await this.applyLifecycle(taskId, box, { type: 'TASK_CANCEL', reason });
    } else {
      // 跨进程取消（actor 不在本进程）：按状态机判定直写
      await this.deps.store.updateTaskStatus({ taskId, status: next });
      await this.deps.store.writeTaskEvent({ taskId, type: 'TASK_CANCEL', fromState: task.status, toState: next, payload: { reason } });
    }
    return next;
  }

  /**
   * 挂起运行中任务（todo 10 崩溃联动入口；02 §9.1 running→suspended：熔断/断连/会话失效路径）。
   * 幂等：非 running（已完成/已挂起/不存在）原样返回现态，不重复写事件。
   * 恢复仍走 resume（02 §9.1：suspended→running 须经人工确认）。
   */
  async suspend(taskId: string, reason: string): Promise<TaskStatus | null> {
    await this.deps.store.whenReady();
    const task = await this.deps.store.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'running') return task.status as TaskStatus;
    const box = this.actors.get(taskId);
    if (box) {
      await this.applyLifecycle(taskId, box, { type: 'TASK_SUSPEND', reason });
    } else {
      const next = resolveTransition('running', { type: 'TASK_SUSPEND', reason }, { taskId, kind: task.kind });
      if (next !== 'suspended') return task.status as TaskStatus;
      await this.deps.store.updateTaskStatus({ taskId, status: next });
      await this.deps.store.writeTaskEvent({ taskId, type: 'TASK_SUSPEND', fromState: 'running', toState: next, payload: { reason } });
    }
    return 'suspended';
  }

  /** 任务 + 步骤视图（logs 视图/dashboard 占位消费） */
  async getTaskView(taskId: string): Promise<TaskView | null> {
    const task = await this.deps.store.getTask(taskId);
    if (!task) return null;
    const steps = await this.deps.store.listSteps(taskId);
    return {
      id: task.id,
      kind: task.kind,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      steps: steps.map((s) => ({ stepId: s.stepId, seq: s.seq, status: s.status, output: s.output, checkpointAt: s.checkpointAt })),
    };
  }

  async listTaskViews(): Promise<TaskView[]> {
    const tasks = await this.deps.store.listTasks();
    const views: TaskView[] = [];
    for (const task of tasks) {
      const view = await this.getTaskView(task.id);
      if (view) views.push(view);
    }
    return views;
  }

  /* ------------------------------ 内部 ------------------------------ */

  /**
   * 快照获取：有持久化快照直接用；缺失（如恢复事件流水无快照的双崩溃边角）则按
   * idle→running→suspended 最小路径重建——状态机是确定性真源，重放即等价。
   */
  private snapshotFor(box: ActorBox): unknown {
    if (box.snapshot !== undefined) return box.snapshot;
    if (box.state === 'idle') return undefined;
    const probe = spawnTaskActor({ taskId: '', kind: box.kind });
    probe.send({ type: 'TASK_START' });
    if (box.state === 'suspended') {
      probe.send({ type: 'TASK_SUSPEND', reason: 'snapshot-rebuild' });
    }
    const snapshot = probe.getPersistedSnapshot();
    probe.stop();
    return snapshot;
  }

  /** 步骤执行主体（后台驱动）：跑完全部未完成步骤 → completed；异常 → failed */
  private async drive(taskId: string, traceId: string, box: ActorBox): Promise<void> {
    try {
      await this.runDemoSteps(taskId, traceId, box);
      if (!box.cancelled && box.state === 'running') {
        await this.applyLifecycle(taskId, box, { type: 'TASK_COMPLETE' }, traceId);
      }
    } catch (error) {
      if (box.state === 'running') {
        await this.applyLifecycle(taskId, box, { type: 'TASK_FAIL', reason: String((error as Error).message) }, traceId);
      }
    }
  }

  /** XState 迁移 → tasks.status + task_events（02 §9.1 持久化规则；快照随事件流水持久化） */
  private async applyLifecycle(taskId: string, box: ActorBox, event: TaskLifecycleEvent, traceId?: string): Promise<void> {
    const next = resolveTransition(box.state, event, { taskId, kind: box.kind });
    if (next === null) {
      throw new Error(`非法任务迁移：${box.state} --${event.type}--> ？(task ${taskId})`);
    }
    // 快照迁移：水合 → 取迁移前状态 → send → 持久化新快照
    const actor = spawnTaskActor({ taskId, kind: box.kind }, this.snapshotFor(box));
    const fromState = actor.getSnapshot().value as TaskLifecycleState;
    actor.send(event);
    const snapshotAfter = actor.getPersistedSnapshot();
    actor.stop();

    box.state = next;
    box.snapshot = snapshotAfter;
    await this.deps.store.updateTaskStatus({ taskId, status: next });
    await this.deps.store.writeTaskEvent({
      taskId,
      type: event.type,
      fromState,
      toState: next,
      payload: {
        reason: (event as { reason?: string }).reason,
        traceId,
        machineSnapshot: snapshotAfter,
      },
    });
    this.deps.logger
      .child(traceId ? { traceId } : {})
      .log('user-action', 'info', `task:${event.type}`, { taskId, from: fromState, to: next });
  }

  /** 串行执行 demo 步骤（检查点续跑入口） */
  private async runDemoSteps(taskId: string, traceId: string, box: ActorBox): Promise<void> {
    const taskLogger = this.deps.logger.child({ traceId });
    const done = new Map<string, unknown>();
    const steps = await this.deps.store.listSteps(taskId);
    for (const step of steps) {
      if (step.status === 'completed' && step.output !== null) {
        done.set(step.stepId, step.output);
      }
    }

    for (let seq = 0; seq < DEMO_STEPS.length; seq += 1) {
      const stepId = DEMO_STEPS[seq] as string;
      if (done.has(stepId)) {
        taskLogger.automationStep('step:skip(检查点续跑)', { taskId, stepId, seq });
        continue;
      }
      if (box.cancelled || box.state !== 'running') {
        // 安全点停止（02 §6.1）：取消、挂起（崩溃联动/人工让位）都停在下个步骤边界
        return;
      }
      await this.runDemoStep(taskId, stepId, seq, taskLogger);
    }
  }

  /** 单个哑步骤：计时占位 → 成功写检查点（output.runToken + attempts=1 可证未重跑） */
  private async runDemoStep(taskId: string, stepId: string, seq: number, taskLogger: Logger): Promise<void> {
    const span = taskLogger.startSpan(stepId, { taskId });
    const running: StepInput = { taskId, stepId, seq, status: 'running' };
    await this.deps.store.upsertStep(running);
    await this.delayFn(this.stepDelayMs);
    const output = {
      seq,
      stepId,
      attempts: 1,
      runToken: randomUUID(),
      checkpointAt: this.now().toISOString(),
      note: 'm0-demo-dummy-step（无业务逻辑，禁入生产路径）',
    };
    await this.deps.store.upsertStep({
      taskId,
      stepId,
      seq,
      status: 'completed',
      output,
      checkpointAt: output.checkpointAt,
    });
    span.logger.automationStep(`step:done:${stepId}`, { taskId, stepId, seq, output });
    span.end('ok', { stepId });
  }
}

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  return new TaskRunner(deps);
}

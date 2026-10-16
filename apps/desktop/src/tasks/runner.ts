/**
 * 任务运行器（m1-insight-plan todo 7 = T-M1-04②；02 §6.1 检查点 + §9.1 状态机）。
 *
 * - XState 管任务宏状态（S9 边界）：每次迁移写 tasks.status + task_events（02 §9.1 持久化规则）；
 * - 步骤拓扑 = 串行 DAG：kind=demo 三步哑步骤（门禁④载体）；kind='collect' 由 collect-service
 *   经 registerKind 注册（todo 7）。每步成功写 task_steps 检查点（02 §6.1：恢复时跳过已完成步骤）；
 *   步骤进度/游标不进 XState；
 * - 启动恢复（02:453 + M1 扩态口径）：running/yielded/paused → suspended；awaiting_user 原样保留
 *   （幂等重提示）；调用方触发 resume 按检查点续跑；
 * - 取消/挂起/暂停在安全点（步骤边界）生效：ActorBox.stopRequested 由驱动循环在边界轮询；
 *   yielded 不停止驱动循环（动作在 yield 门后挂起，静默期满 resume 续跑）。
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '@xinglian/logger';
import {
  BOOT_RECOVERABLE_STATES,
  resolveTransition,
  spawnTaskActor,
  type TaskLifecycleEvent,
  type TaskLifecycleState,
} from './machine';
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
  /** kind 专属 payload 投影（collect 输入/remainder、selection 的 idempotency_key/keywords 等；无敏感字段） */
  payload: unknown;
  steps: TaskStepView[];
}

/** kind=demo 的哑步骤拓扑（3 步；仅计时占位） */
export const DEMO_STEPS = ['demo-prepare', 'demo-process', 'demo-finalize'] as const;

/** resume 允许的来源态（M1 扩态：suspended/paused/yielded/awaiting_user → running） */
export const RESUMABLE_STATES: readonly TaskLifecycleState[] = ['suspended', 'paused', 'yielded', 'awaiting_user'];

/** kind 处理器运行上下文（注册方消费；驱动循环/actor 由 runner 统一持有） */
export interface KindRunContext {
  readonly taskId: string;
  readonly traceId: string;
  readonly logger: Logger;
  /** 安全点询问：true = 取消/挂起/暂停，处理体应尽快在下一个边界返回 */
  shouldStop(): boolean;
  /** 事件面：处理体通过 runner.applyLifecycle 之外不得直写任务状态 */
  emit(event: TaskLifecycleEvent): Promise<void>;
}

type KindHandler = (ctx: KindRunContext) => Promise<void>;

interface ActorBox {
  state: TaskLifecycleState;
  snapshot: unknown;
  cancelled: boolean;
  /** 取消/挂起/暂停安全点标志（yielded 不置位——驱动循环继续，动作在 yield 门后挂起） */
  stopRequested: boolean;
  /** tasks.kind（02 §14.1）——任务级元数据透传给状态机 context，禁止硬编码 */
  kind: string;
  /** 当前 drive 循环（suspend→resume 时新 drive 先等旧 drive 在安全点退出，杜绝双驱动竞态） */
  drivePromise?: Promise<void>;
}

export class TaskRunner {
  private readonly actors = new Map<string, ActorBox>();
  private readonly kindHandlers = new Map<string, KindHandler>();
  private readonly stepDelayMs: number;
  private readonly delayFn: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly deps: TaskRunnerDeps) {
    this.stepDelayMs = deps.stepDelayMs ?? 600;
    this.delayFn = deps.delay ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    this.now = deps.now ?? (() => new Date());
  }

  /** 注册 kind 处理器（collect-service 在装配时调用；重复注册覆盖） */
  registerKind(kind: string, handler: KindHandler): void {
    this.kindHandlers.set(kind, handler);
  }

  /** 启动恢复（02:453 + M1 扩态）：running/yielded/paused → suspended；awaiting_user 原样保留 */
  async recoverOnBoot(): Promise<string[]> {
    await this.deps.store.whenReady();
    const downgraded: string[] = [];
    const preservedAwaiting: string[] = [];
    for (const state of BOOT_RECOVERABLE_STATES) {
      const tasks = await this.deps.store.listTasks(state);
      for (const task of tasks) {
        // 状态机为迁移合法性唯一真源：降级也走 XState 判定
        const next = resolveTransition(state, { type: 'TASK_SUSPEND', reason: 'boot-recovery' }, { taskId: task.id, kind: task.kind });
        if (next === 'suspended') {
          await this.deps.store.updateTaskStatus({ taskId: task.id, status: 'suspended' });
          await this.deps.store.writeTaskEvent({
            taskId: task.id,
            type: 'TASK_SUSPEND',
            fromState: state,
            toState: 'suspended',
            payload: { reason: 'boot-recovery（启动恢复降级，02:453；M1 扩态含 yielded/paused）' },
          });
          downgraded.push(task.id);
        }
      }
    }
    // awaiting_user：原样保留（幂等——重复 boot 不重复写事件，重提示由视图层按现态渲染）
    const awaiting = await this.deps.store.listTasks('awaiting_user');
    for (const task of awaiting) preservedAwaiting.push(task.id);
    this.deps.logger.systemError('boot-recovery-complete', {
      downgradedCount: downgraded.length,
      preservedAwaitingCount: preservedAwaiting.length,
      note: '启动恢复流水（02:453；M1：yielded/paused→suspended、awaiting_user 保留幂等）',
    });
    return downgraded;
  }

  /** 创建并启动 kind=demo 合成任务（门禁④唯一演示载体；无任何业务语义） */
  async startDemo(): Promise<string> {
    return this.startWithKind('demo', { traceId: randomUUID(), steps: [...DEMO_STEPS] });
  }

  /** 通用任务创建 + 起跑（kind='collect' 等注册型 kind 由此进入；02 §14.1 元数据透传） */
  async startWithKind(kind: string, payload: unknown): Promise<string> {
    await this.deps.store.whenReady();
    const taskId = randomUUID();
    const traceId = randomUUID();
    await this.deps.store.createTask({ id: taskId, kind, payload: { traceId, ...(payload as object) } });
    const box: ActorBox = { state: 'idle', snapshot: undefined, cancelled: false, stopRequested: false, kind };
    this.actors.set(taskId, box);
    await this.applyLifecycle(taskId, box, { type: 'TASK_START' }, traceId);
    box.drivePromise = this.drive(taskId, traceId, box);
    return taskId;
  }

  /** 起跑既有 queued 任务（T-M2-03：selection 占位任务由 gate confirm 产出，queued --TASK_START--> running） */
  async startQueued(taskId: string): Promise<TaskStatus> {
    await this.deps.store.whenReady();
    const task = await this.deps.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== 'queued') {
      throw new Error(`task ${taskId} 状态为 ${task.status}，仅 queued 可起跑（resume 走既有通道）`);
    }
    if (!this.kindHandlers.has(task.kind)) {
      throw new Error(`task ${taskId} 的 kind=${task.kind} 未注册处理器（启动序问题或未知 kind）`);
    }
    const traceId = randomUUID();
    const box: ActorBox = { state: 'queued', snapshot: undefined, cancelled: false, stopRequested: false, kind: task.kind };
    this.actors.set(taskId, box);
    await this.applyLifecycle(taskId, box, { type: 'TASK_START' }, traceId);
    box.drivePromise = this.drive(taskId, traceId, box);
    return 'running';
  }

  /** 按检查点续跑（02 §6.1）：跳过 task_steps 中已完成步骤 */
  async resume(taskId: string): Promise<TaskStatus> {
    await this.deps.store.whenReady();
    const task = await this.deps.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const from = task.status as TaskLifecycleState;
    if (!RESUMABLE_STATES.includes(from)) {
      throw new Error(`task ${taskId} 状态为 ${task.status}，仅 ${RESUMABLE_STATES.join('/')} 可恢复`);
    }
    const payload = (task.payload ?? {}) as { traceId?: string };
    const traceId = payload.traceId ?? randomUUID();

    let box = this.actors.get(taskId);
    if (from === 'yielded' && box && box.drivePromise) {
      // 让位恢复（FR-4.5 静默期满）：驱动循环从未停止（动作在 yield 门后挂起），
      // 这里只翻转宏状态 yielded→running，不重入驱动循环（杜绝双驱动竞态）
      await this.applyLifecycle(taskId, box, { type: 'TASK_RESUME', reason: 'yield-silence-resume' }, traceId);
      return 'running';
    }
    if (!box) {
      // 跨进程恢复：从最近一次迁移事件的 XState 快照水合（事件流水尾 = 停止态迁移）
      const events = await this.deps.store.listTaskEvents(taskId);
      const latest = events[events.length - 1];
      const snapshot = (latest?.payload as { machineSnapshot?: unknown } | undefined)?.machineSnapshot;
      box = { state: from, snapshot, cancelled: false, stopRequested: false, kind: task.kind };
      this.actors.set(taskId, box);
    } else {
      // 同进程停止→恢复：旧 drive 在安全点观察到 stopRequested 已退出；等待落定再续跑
      if (box.drivePromise) {
        await box.drivePromise.catch(() => {});
        box.drivePromise = undefined;
      }
      box.cancelled = false;
      box.stopRequested = false;
    }
    await this.applyLifecycle(taskId, box, { type: 'TASK_RESUME', reason: 'resume-from-checkpoint' }, traceId);
    box.drivePromise = this.drive(taskId, traceId, box);
    return 'running';
  }

  async cancel(taskId: string, reason = 'user-cancel'): Promise<TaskStatus> {
    const task = await this.deps.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const box = this.actors.get(taskId);
    if (box) {
      box.cancelled = true;
      box.stopRequested = true;
    }
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
   * 挂起任务（崩溃/熔断 OPEN/登录态失效联动入口；02 §9.1 →suspended 语义）。
   * 可挂起源态 = running/yielded/paused（与 boot 恢复口径对齐）；幂等：其余态原样返回。
   * 恢复仍走 resume（02 §9.1：suspended→running 须经人工确认）。
   */
  async suspend(taskId: string, reason: string): Promise<TaskStatus | null> {
    await this.deps.store.whenReady();
    const task = await this.deps.store.getTask(taskId);
    if (!task) return null;
    const from = task.status as TaskLifecycleState;
    if (from === 'running') return this.stopVia(taskId, 'TASK_SUSPEND', 'suspended', reason);
    if (from === 'yielded' || from === 'paused') {
      const next = resolveTransition(from, { type: 'TASK_SUSPEND', reason }, { taskId, kind: task.kind });
      if (next !== 'suspended') return from;
      const box = this.actors.get(taskId);
      if (box) {
        box.stopRequested = true;
        await this.applyLifecycle(taskId, box, { type: 'TASK_SUSPEND', reason });
      } else {
        await this.deps.store.updateTaskStatus({ taskId, status: next });
        await this.deps.store.writeTaskEvent({ taskId, type: 'TASK_SUSPEND', fromState: from, toState: next, payload: { reason } });
      }
      return 'suspended';
    }
    return from;
  }

  /** 暂停（FR-4.5）：running→paused；跨日续采（配额触顶）与用户暂停共用此面 */
  async pause(taskId: string, reason: string): Promise<TaskStatus | null> {
    return this.stopVia(taskId, 'TASK_PAUSE', 'paused', reason);
  }

  /** 让位（FR-4.5 真实信号）：running→yielded；驱动循环不停，动作在 yield 门后挂起 */
  async yieldTask(taskId: string, reason: string): Promise<TaskStatus | null> {
    await this.deps.store.whenReady();
    const task = await this.deps.store.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'running') return task.status as TaskStatus;
    const box = this.actors.get(taskId);
    if (!box) return task.status as TaskStatus; // 跨进程 yielded 无意义（无驱动循环可让位）
    await this.applyLifecycle(taskId, box, { type: 'TASK_YIELD', reason });
    return 'yielded';
  }

  /** 人工确认等待（02 §9.1 awaiting_user）：running→awaiting_user；boot 保留，resume 推进 */
  async awaitUser(taskId: string, reason: string): Promise<TaskStatus | null> {
    await this.deps.store.whenReady();
    const task = await this.deps.store.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'running') return task.status as TaskStatus;
    const box = this.actors.get(taskId);
    if (box) {
      box.stopRequested = true;
      await this.applyLifecycle(taskId, box, { type: 'TASK_AWAIT_USER', reason });
    } else {
      const next = resolveTransition('running', { type: 'TASK_AWAIT_USER', reason }, { taskId, kind: task.kind });
      if (next !== 'awaiting_user') return task.status as TaskStatus;
      await this.deps.store.updateTaskStatus({ taskId, status: next });
      await this.deps.store.writeTaskEvent({ taskId, type: 'TASK_AWAIT_USER', fromState: 'running', toState: next, payload: { reason } });
    }
    return 'awaiting_user';
  }

  /** running → 终止性中间态（suspend→suspended / pause→paused）的共用安全点路径 */
  private async stopVia(
    taskId: string,
    event: 'TASK_SUSPEND' | 'TASK_PAUSE',
    to: 'suspended' | 'paused',
    reason: string,
  ): Promise<TaskStatus | null> {
    await this.deps.store.whenReady();
    const task = await this.deps.store.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'running') return task.status as TaskStatus;
    const box = this.actors.get(taskId);
    if (box) {
      box.stopRequested = true;
      await this.applyLifecycle(taskId, box, { type: event, reason } as TaskLifecycleEvent);
    } else {
      const next = resolveTransition('running', { type: event, reason } as TaskLifecycleEvent, { taskId, kind: task.kind });
      if (next !== to) return task.status as TaskStatus;
      await this.deps.store.updateTaskStatus({ taskId, status: next });
      await this.deps.store.writeTaskEvent({ taskId, type: event, fromState: 'running', toState: next, payload: { reason } });
    }
    return to;
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
      payload: task.payload ?? null,
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
   * 快照获取：有持久化快照直接用；缺失（如恢复事件流水无快照的双崩溃边角）则沿
   * idle→running→<到态事件> 的确定路径重建——状态机是确定性真源，重放即等价。
   */
  private snapshotFor(box: ActorBox): unknown {
    if (box.snapshot !== undefined) return box.snapshot;
    if (box.state === 'idle') return undefined;
    const probe = spawnTaskActor({ taskId: '', kind: box.kind });
    probe.send({ type: 'TASK_START' });
    const midEvent: Partial<Record<TaskLifecycleState, TaskLifecycleEvent>> = {
      awaiting_user: { type: 'TASK_AWAIT_USER', reason: 'snapshot-rebuild' },
      yielded: { type: 'TASK_YIELD', reason: 'snapshot-rebuild' },
      paused: { type: 'TASK_PAUSE', reason: 'snapshot-rebuild' },
      suspended: { type: 'TASK_SUSPEND', reason: 'snapshot-rebuild' },
    };
    const event = midEvent[box.state];
    if (event) probe.send(event);
    const snapshot = probe.getPersistedSnapshot();
    probe.stop();
    return snapshot;
  }

  /** 步骤执行主体（后台驱动）：注册型 kind 交处理器；demo 走哑步骤；异常 → failed */
  private async drive(taskId: string, traceId: string, box: ActorBox): Promise<void> {
    try {
      const handler = this.kindHandlers.get(box.kind);
      if (handler) {
        await handler({
          taskId,
          traceId,
          logger: this.deps.logger.child({ traceId }),
          shouldStop: () => box.cancelled || box.stopRequested,
          emit: (event) => this.applyLifecycle(taskId, box, event, traceId),
        });
      } else {
        await this.runDemoSteps(taskId, traceId, box);
      }
      if (!box.cancelled && (box.state === 'running' || box.state === 'yielded')) {
        // yielded 中工作已完成（动作门未实际阻塞的快路径）也照常收口（02 §9.1 yielded 语义）
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
      if (box.cancelled || box.stopRequested || box.state !== 'running') {
        // 安全点停止（02 §6.1）：取消、挂起、暂停都停在下个步骤边界
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

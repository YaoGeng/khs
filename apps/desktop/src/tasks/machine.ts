/**
 * 任务生命周期状态机（XState v5；02-系统架构设计.md §9.1）。
 *
 * S9 边界（docs/dev/工程规范.md）：本机只管**任务级**宏状态；
 * 步骤级状态（步骤运行中/重试/检查点游标）一律落 task_steps 表（DAG 执行器职责），
 * 禁止建模为 XState 子状态。
 *
 * M1 扩态（m1-insight-plan todo 7 = T-M1-04②，02 §9.1「queued/awaiting_user/yielded/paused
 * M1+ 按需扩充」注记启用点）：在 M0 六态之上新增 queued/awaiting_user/yielded/paused 四态；
 * 既有六态语义不变（running 启动恢复仍一律降级 suspended，见 runner.recoverOnBoot）：
 * - queued     = 已入队未起跑（idle --TASK_ENQUEUE--> queued --TASK_START--> running）；
 * - yielded    = FR-4.5 人工输入让位中（动作在 yield 门后挂起，静默期满 TASK_RESUME 续跑）；
 * - paused     = 用户暂停/配额触顶跨日续采（remainder 落 kv_config，resume 续跑不重建任务）；
 * - awaiting_user = 人工确认等待（如关键词闸门；boot 恢复原样保留，幂等重提示）。
 * boot 恢复口径：yielded/paused → suspended（停电/崩溃后须人工确认）；awaiting_user 原样保留。
 * 02 §9.1 持久化规则：每次迁移写 tasks.status + task_events（快照随事件流水持久化）。
 */
import { createActor, setup } from 'xstate';

export const TASK_STATES = [
  'idle',
  'queued',
  'running',
  'awaiting_user',
  'yielded',
  'paused',
  'suspended',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskLifecycleState = (typeof TASK_STATES)[number];

export type TaskLifecycleEvent =
  | { type: 'TASK_START' }
  | { type: 'TASK_ENQUEUE' }
  | { type: 'TASK_SUSPEND'; reason: string }
  | { type: 'TASK_RESUME'; reason?: string }
  | { type: 'TASK_YIELD'; reason?: string }
  | { type: 'TASK_PAUSE'; reason?: string }
  | { type: 'TASK_AWAIT_USER'; reason?: string }
  | { type: 'TASK_COMPLETE' }
  | { type: 'TASK_FAIL'; reason: string }
  | { type: 'TASK_CANCEL'; reason?: string };

export interface TaskMachineInput {
  taskId: string;
  kind: string;
}

export const taskMachine = setup({
  types: {
    context: {} as TaskMachineInput,
    input: {} as TaskMachineInput,
    events: {} as TaskLifecycleEvent,
  },
}).createMachine({
  id: 'task',
  initial: 'idle',
  context: ({ input }) => ({ taskId: input.taskId, kind: input.kind }),
  states: {
    idle: {
      on: {
        TASK_START: 'running',
        TASK_ENQUEUE: 'queued',
      },
    },
    queued: {
      on: {
        TASK_START: 'running',
        TASK_CANCEL: 'cancelled',
      },
    },
    running: {
      on: {
        TASK_SUSPEND: 'suspended',
        TASK_YIELD: 'yielded',
        TASK_PAUSE: 'paused',
        TASK_AWAIT_USER: 'awaiting_user',
        TASK_COMPLETE: 'completed',
        TASK_FAIL: 'failed',
        TASK_CANCEL: 'cancelled',
      },
    },
    awaiting_user: {
      on: {
        TASK_RESUME: 'running',
        TASK_CANCEL: 'cancelled',
      },
    },
    yielded: {
      on: {
        TASK_RESUME: 'running',
        TASK_SUSPEND: 'suspended',
        TASK_COMPLETE: 'completed',
        TASK_CANCEL: 'cancelled',
      },
    },
    paused: {
      on: {
        TASK_RESUME: 'running',
        TASK_SUSPEND: 'suspended',
        TASK_CANCEL: 'cancelled',
      },
    },
    suspended: {
      on: {
        TASK_RESUME: 'running',
        TASK_CANCEL: 'cancelled',
      },
    },
    completed: { type: 'final' },
    failed: { type: 'final' },
    cancelled: { type: 'final' },
  },
});

/**
 * 纯函数判定：from 态 + 事件 → to 态（不落库、无副作用）。
 * 启动恢复用它走 XState 判定 running→suspended（保持状态机为迁移合法性唯一真源）。
 * 非法迁移（终态/无匹配事件表项）返回 null。
 */
const REACH_PATH: Record<TaskLifecycleState, TaskLifecycleEvent[]> = {
  idle: [],
  queued: [{ type: 'TASK_ENQUEUE' }],
  running: [{ type: 'TASK_START' }],
  awaiting_user: [{ type: 'TASK_START' }, { type: 'TASK_AWAIT_USER', reason: 'probe' }],
  yielded: [{ type: 'TASK_START' }, { type: 'TASK_YIELD', reason: 'probe' }],
  paused: [{ type: 'TASK_START' }, { type: 'TASK_PAUSE', reason: 'probe' }],
  suspended: [{ type: 'TASK_START' }, { type: 'TASK_SUSPEND', reason: 'probe' }],
  completed: [{ type: 'TASK_START' }, { type: 'TASK_COMPLETE' }],
  failed: [{ type: 'TASK_START' }, { type: 'TASK_FAIL', reason: 'probe' }],
  cancelled: [{ type: 'TASK_START' }, { type: 'TASK_CANCEL', reason: 'probe' }],
};

export function resolveTransition(
  from: TaskLifecycleState,
  event: TaskLifecycleEvent,
  context: { taskId: string; kind: string },
): TaskLifecycleState | null {
  // 探针 actor：沿确定路径重放到 from（机器是确定性真源），再判定目标事件
  const actor = createActor(taskMachine, { input: context });
  actor.start();
  for (const pathEvent of REACH_PATH[from]) {
    actor.send(pathEvent);
  }
  const atFrom = actor.getSnapshot();
  if ((atFrom.value as TaskLifecycleState) !== from || !atFrom.can(event)) {
    actor.stop();
    return null;
  }
  actor.send(event);
  const next = actor.getSnapshot().value as TaskLifecycleState;
  actor.stop();
  return next;
}

/** 新建运行用 actor（runner 持有；input 携任务身份；snapshot 供中断后续跑） */
export function spawnTaskActor(context: TaskMachineInput, snapshot?: unknown) {
  if (snapshot === undefined) {
    const actor = createActor(taskMachine, { input: context });
    actor.start();
    return actor;
  }
  // 快照水合：context 已内嵌于 snapshot，input 仅为类型层必填占位
  const actor = createActor(taskMachine, { input: context, snapshot: snapshot as never });
  actor.start();
  return actor;
}

/** boot 恢复可降级态（yielded/paused → suspended；running → suspended 维持 M0 口径） */
export const BOOT_RECOVERABLE_STATES: readonly TaskLifecycleState[] = ['running', 'yielded', 'paused'];

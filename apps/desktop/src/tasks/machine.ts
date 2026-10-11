/**
 * 任务生命周期状态机（XState v5；02-系统架构设计.md §9.1 的 M0 最小集）。
 *
 * S9 边界（docs/dev/工程规范.md）：本机只管**任务级**宏状态；
 * 步骤级状态（步骤运行中/重试/检查点游标）一律落 task_steps 表（DAG 执行器职责），
 * 禁止建模为 XState 子状态。
 *
 * 02 §9.1 完整态（queued/awaiting_user/yielded/paused）M1+ 按需扩充；
 * 02 §9.1 持久化规则：running 在启动恢复流程中一律降级 suspended（见 runner.recoverOnBoot）。
 */
import { createActor, setup } from 'xstate';

export const TASK_STATES = ['idle', 'running', 'suspended', 'completed', 'failed', 'cancelled'] as const;

export type TaskLifecycleState = (typeof TASK_STATES)[number];

export type TaskLifecycleEvent =
  | { type: 'TASK_START' }
  | { type: 'TASK_SUSPEND'; reason: string }
  | { type: 'TASK_RESUME'; reason?: string }
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
      on: { TASK_START: 'running' },
    },
    running: {
      on: {
        TASK_SUSPEND: 'suspended',
        TASK_COMPLETE: 'completed',
        TASK_FAIL: 'failed',
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
  running: [{ type: 'TASK_START' }],
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

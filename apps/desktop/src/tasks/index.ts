/**
 * 最小任务运行器出口（D7）：XState 生命周期机 + demo 运行器。
 * S9 边界：本目录仅任务级宏状态；步骤级状态落 task_steps（store）。
 */
export { taskMachine, TASK_STATES, resolveTransition, spawnTaskActor } from './machine';
export type { TaskLifecycleEvent, TaskLifecycleState } from './machine';
export { TaskRunner, createTaskRunner, DEMO_STEPS } from './runner';
export type { TaskRunnerDeps, TaskView, TaskStepView } from './runner';

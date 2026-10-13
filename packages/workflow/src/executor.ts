/**
 * 串行 DAG 执行器（m1-insight-plan todo 7 = T-M1-04①；02 §6.1 检查点 + §9.1 任务级控制）。
 *
 * 定位（05:90 Must NOT do）：只做**串行**节点拓扑——不建循环、不建并行分支、不做优先级。
 * 步骤级状态落宿主的 task_steps 表（S9 边界：步骤级状态禁入 XState），本执行器经
 * WorkflowCheckpointStore 注入面与宿主解耦。
 *
 * 重试语义：常规失败 = 指数退避重试 ≤3；熔断 OPEN = 经 @xinglian/stealth-middleware
 * 的 retryDecisionForCircuitState 切换为 abort-no-retry（FR-9.5：不自动重试、不自动切代理）。
 * 安全点（02 §6.1）：取消/挂起/暂停只发生在步骤边界；yield 钩子（FR-4.5）= 每个动作前
 * await 宿主的 yieldGate（真实接线 = browser-service whenAutomationAllowed）。
 */
import { retryDecisionForCircuitState, type CircuitState } from '@xinglian/stealth-middleware';

export type WorkflowCircuitState = CircuitState;

export interface WorkflowStepRunContext {
  readonly stepId: string;
  readonly seq: number;
  /** 1 起计；检查点已完成的步骤恢复时直接跳过，不产生第二次尝试 */
  readonly attempt: number;
}

export interface WorkflowStepDef {
  readonly id: string;
  run(ctx: WorkflowStepRunContext): Promise<unknown>;
}

export interface WorkflowControl {
  /** true = 宿主要求在下一个安全点停止（cancel/suspend/pause） */
  shouldStop(): boolean;
  /** FR-4.5 yield 门：让位期间挂起，解除后放行 */
  yieldGate(): Promise<void>;
  /** 缺省 = 无熔断面（恒 CLOSED） */
  circuitState?(): WorkflowCircuitState;
  /**
   * 重试可否判定（缺省全部可重试）。控制流信号（登录闸/配额暂停等）必须返回 false——
   * 它们不是步骤失败，重试只会重复副作用；false 时落 failStep 后原样上抛。
   */
  isRetryable?(error: unknown): boolean;
}

export interface WorkflowCheckpointStore {
  /** 已完成步骤（stepId → output）——恢复续跑据此跳过 */
  listCompleted(): Promise<Map<string, unknown>>;
  startStep(step: { stepId: string; seq: number; at: string }): Promise<void>;
  completeStep(step: { stepId: string; seq: number; output: unknown; at: string }): Promise<void>;
  failStep(step: { stepId: string; seq: number; error: string; at: string }): Promise<void>;
}

export interface WorkflowRetryOptions {
  /** 含首次；缺省 3 = 重试 ≤3 */
  maxAttempts?: number;
  /** 退避基准（指数 baseDelay * 2^(n-1)，封顶 maxDelayMs） */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface WorkflowExecutorDeps {
  readonly steps: readonly WorkflowStepDef[];
  readonly control: WorkflowControl;
  readonly checkpoints: WorkflowCheckpointStore;
  readonly retry?: WorkflowRetryOptions;
  /** 测试/宿主可注入假时钟推进；生产 = setTimeout */
  readonly delay: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

export class WorkflowStoppedError extends Error {
  readonly code = 'E-WORKFLOW-STOPPED';
  constructor(readonly reason: 'cancelled' | 'suspended' | 'paused') {
    super(`workflow stopped at safety point: ${reason}`);
    this.name = 'WorkflowStoppedError';
  }
}

/**
 * 熔断 OPEN 中止（FR-9.5）：携带 abort-no-retry 决策——该动作在类型层面只有这一个成员，
 * 「OPEN 态自动重试/自动切代理」不存在。
 */
export class CircuitOpenAbortError extends Error {
  readonly code = 'E-WORKFLOW-CIRCUIT-OPEN';
  constructor(readonly decision: Readonly<{ action: 'abort-no-retry' }>) {
    super(`circuit OPEN: ${decision.action}（FR-9.5，不自动重试）`);
    this.name = 'CircuitOpenAbortError';
  }
}

const DEFAULT_RETRY: Required<WorkflowRetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
};

export type WorkflowRunOutcome =
  | { status: 'completed'; completed: string[]; skipped: string[] }
  | { status: 'stopped'; reason: 'cancelled' | 'suspended' | 'paused'; completed: string[]; pendingStepId: string | null };

/**
 * 串行执行步骤拓扑。completed = 全部步骤完成；stopped = 在安全点退出（宿主据此不写
 * TASK_FAIL，任务态由宿主状态机落库）；抛错 = 重试耗尽后的真实失败（宿主 → TASK_FAIL）。
 */
export async function runWorkflow(deps: WorkflowExecutorDeps): Promise<WorkflowRunOutcome> {
  const retry = { ...DEFAULT_RETRY, ...deps.retry };
  const now = deps.now ?? (() => new Date());
  const completed: string[] = [];
  const skipped: string[] = [];
  const done = await deps.checkpoints.listCompleted();

  for (let seq = 0; seq < deps.steps.length; seq += 1) {
    const step = deps.steps[seq] as WorkflowStepDef;
    if (done.has(step.id)) {
      skipped.push(step.id);
      continue;
    }
    // 安全点①：步骤开始前（02 §6.1：取消/挂起/暂停停在下个步骤边界）
    if (deps.control.shouldStop()) return stopOutcome(deps, completed, skipped);
    // 熔断 OPEN：未开始的步骤直接 abort-no-retry，不进入任何动作
    const openBefore = deps.control.circuitState ? retryDecisionForCircuitState(deps.control.circuitState()) : null;
    if (openBefore) throw new CircuitOpenAbortError(openBefore);
    // yield 门：放行后复核安全点（让位期间用户可能顺手点了暂停）
    await deps.control.yieldGate();
    if (deps.control.shouldStop()) return stopOutcome(deps, completed, skipped);

    await deps.checkpoints.startStep({ stepId: step.id, seq, at: now().toISOString() });
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const output = await step.run({ stepId: step.id, seq, attempt });
        await deps.checkpoints.completeStep({ stepId: step.id, seq, output, at: now().toISOString() });
        completed.push(step.id);
        break;
      } catch (error) {
        const retryable = deps.control.isRetryable ? deps.control.isRetryable(error) : true;
        const openPolicy = deps.control.circuitState
          ? retryDecisionForCircuitState(deps.control.circuitState())
          : null;
        if (attempt >= retry.maxAttempts || openPolicy || !retryable) {
          await deps.checkpoints.failStep({
            stepId: step.id,
            seq,
            error: String((error as Error).message ?? error),
            at: now().toISOString(),
          });
          if (openPolicy) throw new CircuitOpenAbortError(openPolicy);
          throw error;
        }
        await deps.delay(Math.min(retry.baseDelayMs * 2 ** (attempt - 1), retry.maxDelayMs));
        // 安全点②：重试等待后
        if (deps.control.shouldStop()) return stopOutcome(deps, completed, skipped);
      }
    }
  }
  return { status: 'completed', completed, skipped };
}

function stopOutcome(
  deps: WorkflowExecutorDeps,
  completed: string[],
  skipped: string[],
): WorkflowRunOutcome {
  const done = new Set([...completed, ...skipped]);
  const nextStep = deps.steps.find((s) => !done.has(s.id));
  return {
    status: 'stopped',
    reason: 'suspended',
    completed: [...completed],
    pendingStepId: nextStep?.id ?? null,
  };
}

/** 声明式串行拓扑构建器；刻意不提供分支/循环/优先级原语（05:90 边界） */
export function serialSteps(defs: ReadonlyArray<{ id: string; run: WorkflowStepDef['run'] }>): WorkflowStepDef[] {
  return defs.map((d) => ({ id: d.id, run: d.run }));
}

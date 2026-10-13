/**
 * 串行 DAG 执行器单测（todo 7 验收①）：检查点续跑、指数退避 ≤3、
 * 熔断 OPEN → abort-no-retry（FR-9.5）、安全点停止、yield 门。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CircuitOpenAbortError,
  runWorkflow,
  serialSteps,
  type WorkflowCheckpointStore,
  type WorkflowControl,
} from './executor.js';
import { circuitOpenRetryPolicy } from '@xinglian/stealth-middleware';

function memoryCheckpoints(): WorkflowCheckpointStore & { dump(): Map<string, { status: string; output: unknown; attempts: unknown[] }> } {
  const rows = new Map<string, { status: string; output: unknown; attempts: unknown[] }>();
  return {
    async listCompleted() {
      const map = new Map<string, unknown>();
      for (const [id, row] of rows) if (row.status === 'completed') map.set(id, row.output);
      return map;
    },
    async startStep({ stepId }) {
      const row = rows.get(stepId) ?? { status: 'running', output: null, attempts: [] as unknown[] };
      row.status = 'running';
      rows.set(stepId, row);
    },
    async completeStep({ stepId, output }) {
      const row = rows.get(stepId) ?? { status: 'completed', output: null, attempts: [] as unknown[] };
      row.status = 'completed';
      row.output = output;
      rows.set(stepId, row);
    },
    async failStep({ stepId, error }) {
      const row = rows.get(stepId) ?? { status: 'failed', output: null, attempts: [] as unknown[] };
      row.status = 'failed';
      row.attempts.push(error);
      rows.set(stepId, row);
    },
    dump: () => rows,
  };
}

const control = (overrides: Partial<WorkflowControl> = {}): WorkflowControl => ({
  shouldStop: () => false,
  yieldGate: async () => {},
  ...overrides,
});

describe('runWorkflow（串行拓扑 + 检查点）', () => {
  it('全部步骤串行完成；检查点按序落 running→completed', async () => {
    const cp = memoryCheckpoints();
    const calls: string[] = [];
    const outcome = await runWorkflow({
      steps: serialSteps([
        { id: 'a', run: async () => { calls.push('a'); return 1; } },
        { id: 'b', run: async () => { calls.push('b'); return 2; } },
      ]),
      control: control(),
      checkpoints: cp,
      delay: async () => {},
    });
    expect(outcome).toEqual({ status: 'completed', completed: ['a', 'b'], skipped: [] });
    expect(calls).toEqual(['a', 'b']);
    expect(cp.dump().get('a')?.status).toBe('completed');
  });

  it('恢复续跑：已完成步骤跳过（不重跑），后续步骤照常', async () => {
    const cp = memoryCheckpoints();
    await cp.completeStep({ stepId: 'a', seq: 0, output: 'pre', at: 't0' });
    const calls: string[] = [];
    const outcome = await runWorkflow({
      steps: serialSteps([
        { id: 'a', run: async () => { calls.push('a'); return 1; } },
        { id: 'b', run: async () => { calls.push('b'); return 2; } },
      ]),
      control: control(),
      checkpoints: cp,
      delay: async () => {},
    });
    expect(calls).toEqual(['b']);
    expect(outcome).toEqual({ status: 'completed', completed: ['b'], skipped: ['a'] });
  });

  it('失败重试：指数退避 ≤3 次后抛错（250ms→500ms 两段等待）', async () => {
    const cp = memoryCheckpoints();
    const delays: number[] = [];
    let calls = 0;
    await expect(
      runWorkflow({
        steps: serialSteps([{ id: 'flaky', run: async () => { calls += 1; throw new Error(`boom-${calls}`); } }]),
        control: control(),
        checkpoints: cp,
        retry: { maxAttempts: 3, baseDelayMs: 250 },
        delay: async (ms) => { delays.push(ms); },
      }),
    ).rejects.toThrow('boom-3');
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
    expect(cp.dump().get('flaky')?.status).toBe('failed');
  });

  it('第二次尝试成功：不抛错且完成', async () => {
    const cp = memoryCheckpoints();
    let calls = 0;
    const outcome = await runWorkflow({
      steps: serialSteps([{ id: 'flaky', run: async () => { calls += 1; if (calls === 1) throw new Error('once'); return 'ok'; } }]),
      control: control(),
      checkpoints: cp,
      delay: async () => {},
    });
    expect(calls).toBe(2);
    expect(outcome.status).toBe('completed');
  });

  it('熔断 OPEN：失败后不重试，抛 CircuitOpenAbortError 携 abort-no-retry（FR-9.5）', async () => {
    const cp = memoryCheckpoints();
    let calls = 0;
    let open = false;
    await expect(
      runWorkflow({
        steps: serialSteps([{ id: 's', run: async () => { calls += 1; open = true; throw new Error('x'); } }]),
        control: control({ circuitState: () => (open ? 'OPEN' : 'CLOSED') }),
        checkpoints: cp,
        delay: async () => {
          throw new Error('OPEN 态不得进入退避等待');
        },
      }),
    ).rejects.toBeInstanceOf(CircuitOpenAbortError);
    expect(calls).toBe(1);
    expect(cp.dump().get('s')?.status).toBe('failed');
  });

  it('熔断 OPEN：步骤开始前直接中止，步骤体不执行', async () => {
    const cp = memoryCheckpoints();
    let calls = 0;
    await expect(
      runWorkflow({
        steps: serialSteps([{ id: 's', run: async () => { calls += 1; return 1; } }]),
        control: control({ circuitState: () => 'OPEN' }),
        checkpoints: cp,
        delay: async () => {},
      }),
    ).rejects.toBeInstanceOf(CircuitOpenAbortError);
    expect(calls).toBe(0);
  });

  it('安全点停止：shouldStop 后返回 stopped，pendingStepId 指向未完成步骤', async () => {
    const cp = memoryCheckpoints();
    let stop = false;
    const outcome = await runWorkflow({
      steps: serialSteps([
        { id: 'a', run: async () => { stop = true; return 1; } },
        { id: 'b', run: async () => 2 },
      ]),
      control: control({ shouldStop: () => stop }),
      checkpoints: cp,
      delay: async () => {},
    });
    expect(outcome).toEqual({ status: 'stopped', reason: 'suspended', completed: ['a'], pendingStepId: 'b' });
    expect(cp.dump().has('b')).toBe(false);
  });

  it('yield 门：让位期间挂起，放行后才执行步骤', async () => {
    const cp = memoryCheckpoints();
    let ran = false;
    let releaseGate!: () => void;
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gateCalls = 0;
    const pending = runWorkflow({
      steps: serialSteps([{ id: 'a', run: async () => { ran = true; return 1; } }]),
      control: control({
        yieldGate: () => {
          gateCalls += 1;
          return gatePromise;
        },
      }),
      checkpoints: cp,
      delay: async () => {},
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(ran, '让位未解除时步骤体不得执行').toBe(false);
    releaseGate();
    const outcome = await pending;
    expect(gateCalls).toBeGreaterThanOrEqual(1);
    expect(ran).toBe(true);
    expect(outcome.status).toBe('completed');
  });
});

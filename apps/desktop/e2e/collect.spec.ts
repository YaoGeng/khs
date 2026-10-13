/**
 * 采集工作流 e2e（m1-insight-plan todo 7 验收②③ + QA failure 组；mock CDP + 本地 fixture）。
 *
 * fixture 口径（编排上下文⑩：真实联调本卡延期，e2e 全部走 mock CDP）：
 * - XINGLIAN_COLLECT_FIXTURE=<scenario.json>：主进程 collect 绑定以 mock CDP 驱动（不拉起真浏览器）；
 * - ① collect 运行 → notes=20 行 + 二次运行快照更新（collect:stats 观测面）；
 * - ② 让位：debug 钩子注入输入事件 → 任务 yielded → 静默 3s → 恢复续跑步骤不重跑（检查点不变）；
 * - ③ 熔断：captcha fixture → OPEN → running 任务挂起 + abort-no-retry + circuit_open 入账本。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;
const scenarioFile = path.join(pkgRoot, 'e2e', 'fixtures', 'collect-scenario.json');
const captchaFile = path.join(pkgRoot, 'e2e', 'fixtures', 'collect-captcha.json');

interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
  userData: string;
}

function launchEnv(userData: string, fixtureFile: string, pacingScale = '0'): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XINGLIAN_USER_DATA: userData,
    XINGLIAN_DEBUG_HOOKS: '1',
    XINGLIAN_COLLECT_FIXTURE: fixtureFile,
    XINGLIAN_COLLECT_PACING_SCALE: pacingScale,
    XINGLIAN_YIELD_POLL_MS: '100',
    XINGLIAN_COLLECT_POLL_MS: '100',
    XINGLIAN_COLLECT_WAIT_MS: '3000',
  };
}

async function launchApp(env: NodeJS.ProcessEnv, userData: string, retries = 20): Promise<LaunchedApp> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const electronApp = await _electron.launch({
        executablePath: electronPath,
        args: ['out/main.js'],
        cwd: pkgRoot,
        env,
      });
      const page = await electronApp.firstWindow();
      await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
      await ensureEulaAccepted(page);
      return { electronApp, page, userData };
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`app 启动失败（重试 ${retries} 次）：${String((lastError as Error)?.message ?? lastError)}`);
}

interface TaskViewE2E {
  id: string;
  kind: string;
  status: string;
  steps: { stepId: string; status: string; checkpointAt: string | null }[];
}

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(async ([ch, pl]) => (await window.xinglian?.invoke(ch as string, pl)) as never, [channel, payload]) as Promise<T>;
}

async function pollUntil(label: string, probe: () => Promise<void>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await probe();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`[pollUntil] ${label} 超时（${timeoutMs}ms）：${String((error as Error).message)}`, { cause: error });
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

test.describe.serial('采集工作流（mock CDP + fixture 20 条）', () => {
  let userData: string;

  test.beforeAll(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-collect-e2e-'));
  });

  test.afterAll(() => {
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      // tmp 目录残留无妨
    }
  });

  test('collect 运行 → notes=20 且二次运行快照更新（FR-4.4）', async () => {
    test.setTimeout(120_000);
    const { electronApp, page } = await launchApp(launchEnv(userData, scenarioFile), userData);
    try {
      const { taskId } = await invoke<{ taskId: string }>(page, 'collect:start', {
        inputType: 'keyword',
        keyword: '测试',
        topicId: 'e2e-topic',
        targetTotal: 50,
      });
      expect(taskId).toBeTruthy();
      await pollUntil('首轮采集完成', async () => {
        const tasks = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks;
        expect(tasks.find((t) => t.id === taskId)?.status).toBe('completed');
      }, 60_000);

      const stats1 = await invoke<{ stats: { completedUnique: number; duplicate: number }; notesCount: number; snapshotsCount: number; taskStatus: string }>(
        page, 'collect:stats', { runId: taskId, topicId: 'e2e-topic' },
      );
      expect(stats1.notesCount, 'notes=20 行').toBe(20);
      expect(stats1.snapshotsCount, '首采快照 20 条').toBe(20);
      expect(stats1.stats?.completedUnique).toBe(20);

      // 二次运行：重复采集 → notes 不增 + duplicate 计数 + 快照追加（20 → 40）
      const run2 = await invoke<{ taskId: string }>(page, 'collect:start', {
        inputType: 'keyword',
        keyword: '测试',
        topicId: 'e2e-topic',
        targetTotal: 50,
      });
      await pollUntil('二轮采集完成', async () => {
        const tasks = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks;
        expect(tasks.find((t) => t.id === run2.taskId)?.status).toBe('completed');
      }, 60_000);
      const stats2 = await invoke<{ stats: { completedUnique: number; duplicate: number }; notesCount: number; snapshotsCount: number }>(
        page, 'collect:stats', { runId: run2.taskId, topicId: 'e2e-topic' },
      );
      expect(stats2.notesCount, 'notes 行数不增').toBe(20);
      expect(stats2.snapshotsCount, '快照追加至 40').toBe(40);
      expect(stats2.stats?.completedUnique).toBe(0);
      expect(stats2.stats?.duplicate).toBe(20);
    } finally {
      await electronApp.close();
    }
  });

  test('让位 e2e：输入事件 → yielded → 静默 3s → 恢复续跑步骤不重跑', async () => {
    test.setTimeout(120_000);
    // pacing 0.05：单条 ≈ 0.6s，批读窗口 ~12s——给「运行中注入输入」留确定性窗口
    const { electronApp, page } = await launchApp(launchEnv(userData, scenarioFile, '0.05'), userData);
    try {
      const { taskId } = await invoke<{ taskId: string }>(page, 'collect:start', {
        inputType: 'keyword',
        keyword: '测试',
        topicId: 'e2e-yield',
        targetTotal: 50,
      });
      // 让位注入点：search 检查点已落（步骤边界语义可见）
      await pollUntil('search 步骤检查点已落', async () => {
        const tasks = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks;
        const task = tasks.find((t) => t.id === taskId);
        expect(task?.steps.some((s) => s.stepId === 'collect-search')).toBe(true);
      }, 30_000);
      const stepsBefore = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks
        .find((t) => t.id === taskId)!.steps.map((s) => ({ ...s }));

      // debug 钩子注入真实输入信号（等价页面 passive 监听写 __khs_yield__）
      await electronApp.evaluate(() => {
        const debug = (globalThis as unknown as {
          __xinglianDebug?: { collect?: { simulateUserInput?: (atMs?: number) => void } };
        }).__xinglianDebug;
        debug?.collect?.simulateUserInput?.();
        return true;
      });
      await pollUntil('任务转 yielded', async () => {
        const tasks = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks;
        expect(tasks.find((t) => t.id === taskId)?.status).toBe('yielded');
      }, 20_000);

      // 静默 3s（YieldClassifier 阈值）→ 自动恢复
      await pollUntil('静默期满恢复 running → completed', async () => {
        const tasks = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks;
        const task = tasks.find((t) => t.id === taskId);
        expect(['running', 'completed']).toContain(task?.status);
        if (task?.status !== 'completed') throw new Error('尚未完成');
      }, 30_000);

      // 检查点续跑断言：快照时已完成的步骤未重跑（status/checkpointAt 均不变）
      const stepsAfter = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks
        .find((t) => t.id === taskId)!.steps.map((s) => ({ ...s }));
      for (const before of stepsBefore.filter((s) => s.status === 'completed')) {
        const after = stepsAfter.find((s) => s.stepId === before.stepId);
        expect(after?.status, `步骤 ${before.stepId} 保持 completed`).toBe('completed');
        expect(after?.checkpointAt, `步骤 ${before.stepId} 检查点不变（未重跑）`).toBe(before.checkpointAt);
      }
      const stats = await invoke<{ notesCount: number }>(page, 'collect:stats', { runId: taskId, topicId: 'e2e-yield' });
      expect(stats.notesCount).toBe(20);
    } finally {
      await electronApp.close();
    }
  });

  test('熔断 e2e：captcha fixture → OPEN → 任务挂起 + abort-no-retry（QA failure 组）', async () => {
    test.setTimeout(120_000);
    const { electronApp, page } = await launchApp(launchEnv(userData, captchaFile), userData);
    try {
      // 代理配置零改动锚点：熔断前后 circuit:status（组合根无代理触点；FR-9.5 单测已深比较）
      const { taskId } = await invoke<{ taskId: string }>(page, 'collect:start', {
        inputType: 'keyword',
        keyword: '测试',
        topicId: 'e2e-captcha',
        targetTotal: 50,
      });
      await pollUntil('验证码 → 熔断 OPEN + 任务挂起', async () => {
        const circuit = await invoke<{ state: string; events: { kind: string }[] }>(page, 'circuit:status');
        expect(circuit.state).toBe('OPEN');
        expect(circuit.events.some((e) => e.kind === 'circuit_open')).toBe(true);
        const tasks = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks;
        expect(tasks.find((t) => t.id === taskId)?.status).toBe('suspended');
      }, 30_000);

      const stats = await invoke<{ stats: { captchaConsumed: number } | null }>(page, 'collect:stats', { runId: taskId, topicId: 'e2e-captcha' });
      expect(stats.stats?.captchaConsumed ?? 0).toBeGreaterThanOrEqual(1);

      // abort-no-retry：任务保持 suspended（非 failed），OPEN 态新任务被拒
      const tasks = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks;
      expect(tasks.find((t) => t.id === taskId)?.status).toBe('suspended');
      const rejected = await page.evaluate((payload) => window.xinglian?.invoke('collect:start', payload).catch((e: Error) => String(e.message)), {
        inputType: 'keyword', keyword: '测试', topicId: 'e2e-captcha-2', targetTotal: 50,
      });
      expect(String(rejected)).toContain('E-COLLECT-CIRCUIT-OPEN');
    } finally {
      await electronApp.close();
    }
  });
});

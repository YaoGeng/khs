/**
 * kill-recover e2e（todo 11 = T-M0-09 / D7；05:68-77 门禁④唯一证据链）：
 *
 * 启动 app → 创建 kind=demo 合成任务跑到中途检查点 → **kill 掉 Electron 进程（真杀）**
 * → 重启 app → 断言任务被启动恢复降级 suspended（02:453）→ 触发 resume →
 * 断言 completed 且已完成步骤未重跑（runToken/attempts 按检查点保持）。
 *
 * 诚实性：不 mock 恢复路径——恢复发生在第二次真实进程的启动时序里（migrate → worker → recoverOnBoot）。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;

interface StepView {
  stepId: string;
  seq: number;
  status: string;
  output: unknown;
  checkpointAt: string | null;
}

interface TaskView {
  id: string;
  kind: string;
  status: string;
  steps: StepView[];
}

interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
}

test.describe.serial('kill-recover（05 门禁④：真 kill → suspended → 检查点续跑）', () => {
  let userData: string;

  test.beforeAll(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-kr-'));
  });

  test.afterAll(() => {
    // 真进程退出后句柄已释放；删除失败不掩盖测试结果（保留现场亦无妨）
    rmSync(userData, { recursive: true, force: true });
  });

  async function launch(): Promise<LaunchedApp> {
    const electronApp = await _electron.launch({
      executablePath: electronPath,
      args: ['out/main.js'],
      cwd: pkgRoot,
      env: { ...process.env, XINGLIAN_USER_DATA: userData },
    });
    const page = await electronApp.firstWindow();
    await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
    return { electronApp, page };
  }

  /**
   * 带重试的启动：kill 后单实例锁可能被（继承句柄的）子进程短暂持有——
   * 新实例拿不到锁会静默退出（exit 0）。重试直到锁释放（真实重启语义的一部分）。
   */
  async function launchWithRetry(retries = 20): Promise<LaunchedApp> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        return await launch();
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`重启失败（重试 ${retries} 次）：${String((lastError as Error)?.message ?? lastError)}`);
  }

  async function fetchTask(page: Page, taskId: string): Promise<TaskView | null> {
    return page.evaluate(async (tid) => {
      const data = (await window.xinglian?.invoke('tasks:list')) as { tasks: TaskView[] } | undefined;
      return data?.tasks.find((t) => t.id === tid) ?? null;
    }, taskId);
  }

  async function pollTask(
    page: Page,
    taskId: string,
    predicate: (t: TaskView) => boolean,
    timeoutMs = 20_000,
  ): Promise<TaskView> {
    const started = Date.now();
    for (;;) {
      const task = await fetchTask(page, taskId);
      if (task && predicate(task)) return task;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`pollTask 超时：taskId=${taskId} 最后状态=${JSON.stringify(task)}`);
      }
      await page.waitForTimeout(150);
    }
  }

  test('真 kill → 重启 → suspended → resume → completed，已完成步骤未重跑', async () => {
    test.setTimeout(120_000);

    /* ---------- Phase 1：首次启动，创建 demo 任务并跑到中途检查点 ---------- */
    const app1 = await launch();
    const created = (await app1.page.evaluate(() =>
      window.xinglian?.invoke('tasks:createDemo'),
    )) as { taskId: string };
    const taskId = created.taskId;
    expect(taskId).toBeTruthy();

    const midTask = await pollTask(app1.page, taskId, (t) => {
      const completed = t.steps.filter((s) => s.status === 'completed');
      return t.status === 'running' && completed.length >= 1;
    });
    const completedBefore = midTask.steps.filter((s) => s.status === 'completed');
    const tokensBefore = new Map(
      completedBefore.map((s) => [s.stepId, (s.output as { runToken: string }).runToken]),
    );
    // 留证据：kill 前的任务快照（步骤未满 = 确实死在中途）
    expect(completedBefore.length).toBeGreaterThanOrEqual(1);
    expect(midTask.steps.length).toBeLessThan(3);

    /* ---------- Phase 2：真 kill（进程级终止，非优雅退出；整树终止防孤儿持锁） ---------- */
    const proc = app1.electronApp.process();
    const appPid = proc.pid;
    const exitPromise = new Promise<number | null>((resolve) => {
      proc.once('exit', (code) => resolve(code));
    });
    // Windows：taskkill /T /F = 终止整棵进程树（main + 渲染/GPU/utility 子进程），
    // 等价真实场景的进程崩溃（无任何清理路径执行）——比仅杀主进程更彻底、更可复现
    const { execFileSync } = (await import('node:child_process')) as typeof import('node:child_process');
    execFileSync('taskkill', ['/PID', String(appPid), '/T', '/F'], { stdio: 'ignore' });
    const exitCode = await exitPromise;
    expect(exitCode, '主进程应已被终止').not.toBeNull();
    // 让孤儿句柄/锁释放落地（Windows 单实例锁的释放面）
    await new Promise((r) => setTimeout(r, 1500));

    /* ---------- Phase 3：重启（同 userData，全新进程；等待单实例锁释放） ---------- */
    const app2 = await launchWithRetry();

    /* ---------- Phase 4：启动恢复断言——running 降级 suspended（02:453） ---------- */
    const recovered = await pollTask(app2.page, taskId, (t) => t.status === 'suspended');
    expect(recovered.status).toBe('suspended');
    // 检查点在 kill 中幸存：已完成步骤数据与 kill 前一致
    for (const step of recovered.steps.filter((s) => s.status === 'completed')) {
      expect((step.output as { runToken: string }).runToken).toBe(tokensBefore.get(step.stepId));
    }

    /* ---------- Phase 5：resume → 按检查点续跑 → completed ---------- */
    const resumeResult = (await app2.page.evaluate((tid) =>
      window.xinglian?.invoke('tasks:resume', { taskId: tid }), taskId)) as { taskId: string; status: string };
    expect(resumeResult.status).toBe('running');

    const finalTask = await pollTask(app2.page, taskId, (t) => t.status === 'completed');
    expect(finalTask.steps).toHaveLength(3);
    for (const step of finalTask.steps) {
      expect(step.status, `step=${step.stepId}`).toBe('completed');
      expect((step.output as { attempts: number }).attempts, `step=${step.stepId} 不应重跑`).toBe(1);
      // 未重跑核心断言：kill 前已完成的步骤，resume 后 runToken 不变（无重新执行痕迹）
      const before = tokensBefore.get(step.stepId);
      if (before !== undefined) {
        expect((step.output as { runToken: string }).runToken, `step=${step.stepId} 检查点保持`).toBe(before);
      }
    }

    /* ---------- Phase 6：trace 串联查询（logs:query 经 store 索引表） ---------- */
    // demo 任务 trace_id 落在 logs 表；按类别过滤 automation-step 应含步骤流水
    const logRows = (await app2.page.evaluate(() =>
      window.xinglian?.invoke('logs:query', { category: 'automation-step', limit: 200 }),
    )) as { rows: Array<{ msg: string; traceId: string | null; category: string }> };
    expect(logRows.rows.length).toBeGreaterThan(0);
    const traceIds = new Set(logRows.rows.map((r) => r.traceId).filter((t): t is string => t !== null));
    expect(traceIds.size).toBeGreaterThan(0);

    await app2.electronApp.close();
  });

  test('重启后 resume 可从 UI 触发（settings 演示任务卡可达，占位级）', async () => {
    const app = await launch();
    try {
      await app.page.click('.nav-item[data-view="settings"]');
      await expect(app.page.locator('#demo-task-card')).toBeVisible();
      // 设置页存在创建入口（渲染层接线证据；完整生命周期断言在前一用例）
      await expect(app.page.locator('#demo-task-create-btn')).toBeVisible();
      // logs 视图接线（列表/过滤器存在）
      await app.page.click('.nav-item[data-view="logs"]');
      await expect(app.page.locator('#logs-table')).toBeAttached();
    } finally {
      await app.electronApp.close();
    }
  });
});

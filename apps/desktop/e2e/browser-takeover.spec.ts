/**
 * 受控浏览器接管 e2e（todo 10 = T-M0-08；05:68-77 门禁②证据链）。
 *
 * 链路（真 Chrome、真进程、真 CDP，全部非 mock）：
 *   1. 启动 app → 一键打开小红书（真实 Chrome headful + --remote-debugging-pipe）
 *      → 断言标题栏「已接管」——判定来源 = 真实 CDP 往返（Browser.getVersion 的 product +
 *      Target.getTargets 的真实 page 目标），禁止 mock 数据冒充；
 *   2. **杀浏览器进程**（taskkill 整树，真 kill）→ 断言 running 任务被崩溃联动置 suspended
 *      （T11 runner；02 §9.1）→ 服务自动同 Profile 重拉 → 断言恢复到 attached（新 pid）；
 *   3. resume → 断言任务按检查点续跑至 completed；
 *   4. 登录态保持（门禁②）：关闭 app → 重启 app → 同 Profile 重拉 → 断言 Profile 目录复用
 *      + 域名 cookies 落盘（文件字节层证据；不读取任何 cookie 值——FR-3.1/02 §5.2 红线，
 *      真实小红书登录无法自动化，以 Profile 持久化 + 域名 cookies 落盘为证据）；
 *   5. FR-3.4 失效引导 + FR-4.5 让位机制：健康检测（真实 CDP 周期往返）判定「登录失效」→
 *      引导横幅；让位为 M0 机制桩（XINGLIAN_DEBUG_HOOKS 钩子驱动 → UI 指示，简化口径见
 *      docs/adr/notes-browser-m0.md §5）。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;

/* ------------------------------ 本机浏览器前置（FR-3.1 探测的 e2e 真值） ------------------------------ */

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findLocalBrowser(): string {
  const found = [...CHROME_CANDIDATES, ...EDGE_CANDIDATES].find((p) => existsSync(p));
  if (!found) {
    throw new Error('e2e 前置缺失：本机未找到 Chrome/Edge（门禁②必须真浏览器真 kill；如实失败而非跳过）');
  }
  return found;
}

/* ------------------------------ 环境与进程助手 ------------------------------ */

interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
}

function launchEnv(userData: string, profileRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XINGLIAN_USER_DATA: userData,
    XINGLIAN_CDP_PROFILE_ROOT: profileRoot,
    XINGLIAN_DEBUG_HOOKS: '1',
    // demo 任务步骤放慢：给「杀浏览器 → 断言 suspended」留确定性窗口（见 kill-recover.spec 同思路）
    XINGLIAN_DEMO_STEP_DELAY_MS: '3000',
    // 登录失效检测提速（默认 10s 周期 → 500ms，缩短演示等待；规则本身不变）
    XINGLIAN_BROWSER_HEALTH_MS: '500',
  };
}

async function launchApp(env: NodeJS.ProcessEnv, retries = 20): Promise<LaunchedApp> {
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
      return { electronApp, page };
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`app 启动失败（重试 ${retries} 次）：${String((lastError as Error)?.message ?? lastError)}`);
}

interface BrowserStatusE2E {
  state: 'detached' | 'attached' | 'login-expired';
  yielded: boolean;
  browserVersion: string | null;
  browserPid: number | null;
  profileDir: string;
  openTabs: { targetId: string; url: string }[] | null;
}

interface TaskViewE2E {
  id: string;
  status: string;
  steps: { stepId: string; status: string; output: unknown }[];
}

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(async ([ch, pl]) => (await window.xinglian?.invoke(ch as string, pl)) as never, [channel, payload]) as Promise<T>;
}

/** 轮询直到断言通过（真实异步联动不 mock，全部现场等待） */
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

function processAlive(pid: number): boolean {
  const { stdout } = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { windowsHide: true, encoding: 'utf8' });
  return stdout.includes(String(pid));
}

async function killBrowserTree(pid: number): Promise<void> {
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

/** 平台 Profile 下 cookies 落盘证据（文件存在 + 域名字节命中；不读 cookie 值） */
function cookieEvidence(profileDir: string): { file: string; size: number; domainBytes: boolean } {
  const defaultDir = path.join(profileDir, 'Default');
  const candidates = [path.join(defaultDir, 'Network', 'Cookies'), path.join(defaultDir, 'Cookies')];
  const cookieFile = candidates.find((p) => existsSync(p));
  if (!cookieFile) {
    throw new Error(`cookies 文件不存在（已查 ${candidates.join(' | ')}；defaultDir 内容：${existsSync(defaultDir) ? readdirSync(defaultDir).join(',') : '(无 Default 目录)'}）`);
  }
  const size = statSync(cookieFile).size;
  // 字节层证据：SQLite 主文件/预写日志中的 host_key 域名明文（只看域名存在性，不读 cookie 内容）
  const wal = cookieFile + '-wal';
  const haystack = Buffer.concat([readFileSync(cookieFile), existsSync(wal) ? readFileSync(wal) : Buffer.alloc(0)]);
  return { file: cookieFile, size, domainBytes: haystack.includes(Buffer.from('xiaohongshu', 'utf8')) };
}

/* ------------------------------ 用例 ------------------------------ */

test.describe.serial('受控浏览器接管（05 门禁②：CDP 接管 + 崩溃联动 + 登录态保持）', () => {
  let userData: string;
  let profileRoot: string;

  test.beforeAll(() => {
    findLocalBrowser(); // 无真浏览器 → 显式失败（诚实性优先）
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-br-ud-'));
    profileRoot = mkdtempSync(path.join(tmpdir(), 'xinglian-br-prof-'));
  });

  test.afterAll(() => {
    // 现场清理为尽力而为（进程/杀软可能短暂持有句柄）；清理失败不影响测试结论
    for (const dir of [userData, profileRoot]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 保留现场无妨（tmp 目录）
      }
    }
  });

  let sharedProfileDir: string;
  let lastControlledPid: number | null = null;

  test('接管 → 标题栏「已接管」（真实 CDP）→ 真杀浏览器 → suspended → 同 Profile 重拉恢复 → resume 完成', async () => {
    test.setTimeout(180_000);
    const env = launchEnv(userData, profileRoot);
    const { electronApp, page } = await launchApp(env);

    try {
      /* ---- 1. 一键拉起 + CDP 接管（真实 Chrome headful） ---- */
      await page.click('#browser-open-xhs');
      await pollUntil('标题栏进入「已接管」', async () => {
        expect(await page.getAttribute('html', 'data-browser-state')).toBe('attached');
      }, 60_000);

      const status1 = await invoke<BrowserStatusE2E>(page, 'browser:status');
      expect(status1.state).toBe('attached');
      // 真实 CDP 往返证据：Browser.getVersion 的 product（真 Chrome 内核版本）+ Target.getTargets 真实目标
      expect(status1.browserVersion, 'Browser.getVersion 真实往返').toMatch(/^(Chrome|Edge|HeadlessChrome)\//);
      expect(status1.browserPid, '受控浏览器进程 pid').toBeGreaterThan(0);
      expect(status1.openTabs?.some((t) => t.url.includes('xiaohongshu.com')), 'Target.getTargets 含小红书目标页').toBe(true);
      expect(status1.profileDir.toLowerCase()).toContain('xiaohongshu');
      sharedProfileDir = status1.profileDir;

      /* ---- 2. 创建 running 任务（放慢步骤），真杀浏览器 ---- */
      const created = await invoke<{ taskId: string }>(page, 'tasks:createDemo');
      const taskId = created.taskId;
      expect(taskId).toBeTruthy();
      await pollUntil('demo 任务进入 running', async () => {
        const task = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks.find((t) => t.id === taskId);
        expect(task?.status).toBe('running');
      }, 15_000);

      const oldPid = status1.browserPid as number;
      await killBrowserTree(oldPid); // 真 kill：整树终止，无任何清理路径
      await pollUntil('进程确认死亡', async () => {
        if (processAlive(oldPid)) throw new Error('浏览器进程仍存活');
      }, 15_000);

      /* ---- 3. 崩溃联动：running 任务 → suspended（T11 runner，02 §9.1） ---- */
      await pollUntil('任务被挂起（browser-lost → suspended）', async () => {
        const task = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks.find((t) => t.id === taskId);
        expect(task?.status).toBe('suspended');
      }, 20_000);

      /* ---- 4. 自动同 Profile 重拉 → 回到「已接管」（新 pid） ---- */
      await pollUntil('自动重拉后回到「已接管」', async () => {
        const status = await invoke<BrowserStatusE2E>(page, 'browser:status');
        expect(status.state).toBe('attached');
        expect(status.browserPid, '重拉后为新进程').not.toBe(oldPid);
        expect(status.profileDir, '同 Profile 目录（FR-3.3 登录态留存）').toBe(sharedProfileDir);
      }, 60_000);

      /* ---- 5. 人工确认恢复（tasks:resume）→ 按检查点续跑至 completed ---- */
      const resumed = await invoke<{ status: string }>(page, 'tasks:resume', { taskId });
      expect(resumed.status).toBe('running');
      await pollUntil('resume 后任务完成', async () => {
        const task = (await invoke<{ tasks: TaskViewE2E[] }>(page, 'tasks:list')).tasks.find((t) => t.id === taskId);
        expect(task?.status).toBe('completed');
        expect(task?.steps).toHaveLength(3);
        for (const step of task?.steps ?? []) expect(step.status).toBe('completed');
      }, 30_000);

      lastControlledPid = (await invoke<BrowserStatusE2E>(page, 'browser:status')).browserPid ?? null;
    } finally {
      await electronApp.close();
      // 受控浏览器随 will-quit 优雅退出（Profile 冲刷 + 锁释放）；进程面轮询兜底
      const pidToWait = lastControlledPid;
      if (pidToWait) {
        await pollUntil('受控浏览器进程已退出', async () => {
          if (processAlive(pidToWait)) throw new Error(`浏览器进程 ${pidToWait} 仍存活`);
        }, 20_000).catch(() => {});
      }
    }
  });

  test('登录态保持（门禁②）：关闭 app → 重启 → 同 Profile 重连 + 域名 cookies 落盘', async () => {
    test.setTimeout(180_000);
    // 前一用例关闭 app 后浏览器已随 will-quit 关闭（Profile 冲刷）；等待进程完全退出
    const env = launchEnv(userData, profileRoot);

    // 证据①：平台 Profile 目录持久化，cookies 落盘（文件 + 域名字节；不读 cookie 值）
    const evidence = cookieEvidence(sharedProfileDir);
    expect(evidence.size, 'cookies 文件非空').toBeGreaterThan(0);
    expect(evidence.domainBytes, 'cookies 落盘含 xiaohongshu 域（host_key 明文命中）').toBe(true);

    // 证据②：重启 app → 重拉浏览器（同 Profile）→ CDP 可重连（真实 Browser.getVersion 往返）
    const { electronApp, page } = await launchApp(env);
    try {
      await page.click('#browser-open-xhs');
      await pollUntil('重启后回到「已接管」', async () => {
        expect(await page.getAttribute('html', 'data-browser-state')).toBe('attached');
      }, 60_000);
      const status = await invoke<BrowserStatusE2E>(page, 'browser:status');
      expect(status.state).toBe('attached');
      expect(status.browserVersion).toMatch(/^(Chrome|Edge|HeadlessChrome)\//);
      expect(status.profileDir, 'Profile 目录复用（同一份登录态落盘目录）').toBe(sharedProfileDir);
      expect(status.openTabs?.some((t) => t.url.includes('xiaohongshu.com'))).toBe(true);
    } finally {
      await electronApp.close();
    }
  });

  test('FR-3.4 失效引导 + FR-4.5 让位机制（真实 CDP 健康往返 + 测试钩子）', async () => {
    test.setTimeout(120_000);
    const env = launchEnv(userData, profileRoot);
    const { electronApp, page } = await launchApp(env);
    const progress = (label: string): void => console.log(`[br-e2e] ${new Date().toISOString()} ${label}`);
    try {
      await page.click('#browser-open-xhs');
      progress('clicked open-xhs');
      await pollUntil('回到「已接管」', async () => {
        expect(await page.getAttribute('html', 'data-browser-state')).toBe('attached');
      }, 60_000);
      progress('attached');

      /* ---- 登录失效：驱动平台标签到登录特征 URL（受控导航 = 我们自己的接管动作）----
       * 健康检测（真实 CDP：Browser.getVersion ping + Target.getTargets URL 检查）在
       * XINGLIAN_BROWSER_HEALTH_MS=500 周期内判定 → 三态标题栏「登录失效」+ 引导横幅。 */
      await electronApp.evaluate(() => {
        const debug = (globalThis as unknown as { __xinglianDebug?: { browser?: { navigateTab: (url: string) => Promise<unknown> } } }).__xinglianDebug;
        return debug?.browser?.navigateTab('https://www.xiaohongshu.com/login?next=%2Fexplore');
      });
      progress('navigated to login URL');
      await pollUntil('健康检测判定「登录失效」+ 引导横幅', async () => {
        expect(await page.getAttribute('html', 'data-browser-state')).toBe('login-expired');
        expect(await page.locator('#browser-login-banner').isVisible()).toBe(true);
        const status = await invoke<BrowserStatusE2E>(page, 'browser:status');
        expect(status.state).toBe('login-expired');
      }, 30_000);
      progress('login-expired asserted');

      // 重登后（URL 离开特征集）→ 自动回到 attached（M0 从简规则：URL 层判定）
      await electronApp.evaluate(() => {
        const debug = (globalThis as unknown as { __xinglianDebug?: { browser?: { navigateTab: (url: string) => Promise<unknown> } } }).__xinglianDebug;
        return debug?.browser?.navigateTab('https://www.xiaohongshu.com/explore');
      });
      progress('navigated back to explore');
      await pollUntil('重登后自动恢复「已接管」', async () => {
        expect(await page.getAttribute('html', 'data-browser-state')).toBe('attached');
        expect(await page.locator('#browser-login-banner').isVisible()).toBe(false);
      }, 30_000);
      progress('recovered asserted');

      /* ---- FR-4.5 让位（M0 机制桩）：测试钩子触发 → UI 指示「自动化已让位」 ---- */
      await electronApp.evaluate(() => {
        const debug = (globalThis as unknown as { __xinglianDebug?: { browser?: { yieldToUser: (source: string, reason?: string) => void } } }).__xinglianDebug;
        debug?.browser?.yieldToUser('e2e-hook', 'e2e-yield');
        return true;
      });
      await pollUntil('让位指示出现', async () => {
        expect(await page.getAttribute('html', 'data-browser-yielded')).toBe('1');
        expect(await page.locator('#browser-yield-chip').isVisible()).toBe(true);
      }, 15_000);
      progress('yield asserted');

      await electronApp.evaluate(() => {
        const debug = (globalThis as unknown as { __xinglianDebug?: { browser?: { resumeFromYield: (reason?: string) => boolean } } }).__xinglianDebug;
        debug?.browser?.resumeFromYield('e2e-resume');
        return true;
      });
      await pollUntil('让位解除', async () => {
        expect(await page.getAttribute('html', 'data-browser-yielded')).toBe('0');
        expect(await page.locator('#browser-yield-chip').isVisible()).toBe(false);
      }, 15_000);
      progress('yield released');

      /* ---- 一键断开（FR-3.5）：标题栏回「未接管」+ 受控浏览器进程被关闭 ---- */
      const beforeDisconnect = await invoke<BrowserStatusE2E>(page, 'browser:status');
      const controlledPid = beforeDisconnect.browserPid as number;
      await page.click('#browser-disconnect');
      progress('clicked disconnect');
      await pollUntil('断开后回「未接管」', async () => {
        expect(await page.getAttribute('html', 'data-browser-state')).toBe('detached');
      }, 15_000);
      progress('detached asserted');
      await pollUntil('受控浏览器进程已退出（断开语义 = CDP + 进程一并关闭）', async () => {
        if (processAlive(controlledPid)) throw new Error(`浏览器进程 ${controlledPid} 仍存活`);
      }, 15_000);
      progress('browser process exited; closing app');
    } finally {
      progress('finally: electronApp.close() begin');
      await electronApp.close();
      progress('finally: electronApp.close() done');
    }
  });
});

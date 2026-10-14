/**
 * 组合接线 + 确认闸门 e2e（m1-insight-plan todo 11 = T-M1-06②；验收「组合接线 e2e」组）。
 *
 * 诚实性：mock 的只有「LLM 服务商端点」（本地 http server，8 章固定合法 JSON、⑦章注入
 * 黑名单词样本）；BYOK Key 存取/词库扫描/collect 管道/report-agent/store/闸门状态机全链路生产。
 *
 * 场景：
 * 1. Key 未配置 → collect 完成（mock CDP 20 条）→ 任务 awaiting_user + gate=llm_key_config；
 * 2. keys:set（custom → mock 端点）→ tasks:resume 重跑报告步骤 → reports 落库 +
 *    gate=keyword_confirm（reportId 挂起）；⑦章建议词过词库黑名单：命中词剔除 +
 *    keyword_hits 留痕（persisted≥1）；报告视图⑦章不出现命中词；
 * 3. 确认 → selection 占位任务（queued，payload 含 idempotency_key=sha256(topic+report_id)）
 *    + collect 任务收口 completed；重复确认幂等 no-op（任务行数不变）；
 * 4. 拒绝（第二轮采集的闸门）→ collect 任务 cancelled。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;
const scenarioFile = path.join(pkgRoot, 'e2e', 'fixtures', 'collect-scenario.json');

interface GateViewE2E {
  taskId: string;
  gate: string;
  reportId: number | null;
  topicId: string | null;
  keywords: { allowed: string[]; removed: Array<{ term: string }>; wordlistVersion: string | null; persisted: number } | null;
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
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

test.describe.serial('组合接线 + 关键词确认闸门（mock LLM 端点）', () => {
  let userData: string;
  let electronApp: ElectronApplication;
  let page: Page;
  let mockServer: Server;
  let mockBaseUrl: string;

  test.beforeAll(async () => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-report-gate-'));
    mockServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const isSelectionChapter = body.includes('选品关键词建议');
        const value = isSelectionChapter
          ? { title: '⑦ 1688 选品关键词建议', summary: '采购视角词根建议（e2e 注入黑名单样本）', bullets: ['最好用的收纳柜：理由一', '收纳好物源头工厂：理由二'] }
          : { title: 'e2e 章节', summary: 'e2e mock 章节摘要', bullets: ['要点一', '要点二'] };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify(value) } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }));
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address();
    if (address === null || typeof address === 'string') throw new Error('mock server 未监听');
    mockBaseUrl = `http://127.0.0.1:${address.port}/v1`;

    electronApp = await _electron.launch({
      executablePath: electronPath,
      args: ['out/main.js'],
      cwd: pkgRoot,
      env: {
        ...process.env,
        XINGLIAN_USER_DATA: userData,
        XINGLIAN_DEBUG_HOOKS: '1',
        XINGLIAN_COLLECT_FIXTURE: scenarioFile,
        XINGLIAN_COLLECT_PACING_SCALE: '0',
      },
    });
    page = await electronApp.firstWindow();
    await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
    await ensureEulaAccepted(page);
  });

  test.afterAll(async () => {
    await electronApp.close();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      // tmp 目录残留无妨
    }
  });

  test('1. Key 未配置：collect 完成 → awaiting_user + gate=llm_key_config', async () => {
    const { taskId } = await invoke<{ taskId: string }>(page, 'collect:start', {
      inputType: 'keyword',
      keyword: '测试',
      topicId: 'e2e-gate-1',
      targetTotal: 50,
    });
    await pollUntil('采集四步完成且任务停在 awaiting_user（报告步骤闸门）', async () => {
      const tasks = (await invoke<{ tasks: Array<{ id: string; status: string }> }>(page, 'tasks:list')).tasks;
      expect(tasks.find((t) => t.id === taskId)?.status).toBe('awaiting_user');
    }, 60_000);

    const gates = (await invoke<{ gates: GateViewE2E[] }>(page, 'gate:list')).gates;
    const gate = gates.find((g) => g.taskId === taskId);
    expect(gate?.gate).toBe('llm_key_config');
    expect(gate?.topicId).toBe('e2e-gate-1');
    expect(gate?.reportId).toBeNull();

    /* reports 落库为空（Key 未配置不产生报告） */
    const reports = (await invoke<{ reports: unknown[] }>(page, 'reports:list')).reports;
    expect(reports).toHaveLength(0);
  });

  test('2. 配置 Key → resume 重跑报告步骤 → reports 落库 + gate=keyword_confirm + 黑名单过滤', async () => {
    const gates = (await invoke<{ gates: GateViewE2E[] }>(page, 'gate:list')).gates;
    const taskId = gates.find((g) => g.gate === 'llm_key_config')?.taskId;
    expect(taskId).toBeTruthy();

    await invoke(page, 'keys:set', { provider: 'custom', key: 'sk-e2e-report-gateway-key', baseUrl: mockBaseUrl, model: 'e2e-gateway-model' });
    await invoke(page, 'tasks:resume', { taskId });

    await pollUntil('报告生成完成 → gate=keyword_confirm', async () => {
      const current = (await invoke<{ gates: GateViewE2E[] }>(page, 'gate:list')).gates.find((g) => g.taskId === taskId);
      expect(current?.gate).toBe('keyword_confirm');
      expect(current?.reportId).toBeGreaterThanOrEqual(1);
    }, 60_000);

    const gate = (await invoke<{ gates: GateViewE2E[] }>(page, 'gate:list')).gates.find((g) => g.taskId === taskId);
    expect(gate?.keywords?.wordlistVersion).toBe('1.0.0');
    expect(gate?.keywords?.allowed).toContain('收纳好物源头工厂：理由二');
    expect(gate?.keywords?.allowed.some((b) => b.includes('最好'))).toBe(false);
    expect(gate?.keywords?.removed[0]?.term).toBe('最好');
    expect(gate?.keywords?.persisted).toBeGreaterThanOrEqual(1);

    /* reports 落库 + ⑦章渲染不含命中词 */
    const reports = (await invoke<{ reports: Array<{ id: number; topic: string }> }>(page, 'reports:list')).reports;
    expect(reports.length).toBeGreaterThanOrEqual(1);
    const reportId = gate?.reportId as number;
    const detail = await invoke<{ report: { chapters: Record<string, { bullets: string[] }> } | null }>(page, 'reports:get', { reportId });
    expect(detail.report).not.toBeNull();

    await page.click('.nav-item[data-view="report"]');
    await expect(page.locator('#view-report')).toHaveClass(/active/);
    await page.locator(`#report-select option[value="${reportId}"]`).waitFor({ state: 'attached', timeout: 15_000 });
    await page.selectOption('#report-select', String(reportId));
    await page.waitForSelector('html[data-report-state="rendered"]', { timeout: 20_000 });
    const chapter7 = page.locator('section.report-chapter[data-chapter="selectionKeywords"]');
    await expect(chapter7).toBeVisible();
    await expect(chapter7).toContainText('收纳好物源头工厂');
    expect(await chapter7.textContent()).not.toContain('最好');
  });

  test('3. 确认 → selection 占位（queued + idempotency_key）+ collect 收口 completed；重复确认幂等 no-op', async () => {
    const gates = (await invoke<{ gates: GateViewE2E[] }>(page, 'gate:list')).gates;
    const taskId = gates.find((g) => g.gate === 'keyword_confirm')?.taskId;
    const reportId = gates.find((g) => g.gate === 'keyword_confirm')?.reportId;
    expect(taskId).toBeTruthy();

    const tasksBefore = (await invoke<{ tasks: unknown[] }>(page, 'tasks:list')).tasks;
    const first = await invoke<{ created: boolean; selectionTaskId: string | null; idempotencyKey: string }>(page, 'gate:confirm', { taskId });
    expect(first.created).toBe(true);
    expect(first.selectionTaskId).toBeTruthy();
    expect(first.idempotencyKey).toBe(createHash('sha256').update(`e2e-gate-1:${reportId}`).digest('hex'));

    await pollUntil('selection 占位任务 queued + collect 任务 completed', async () => {
      const tasks = (await invoke<{ tasks: Array<{ id: string; kind: string; status: string; payload?: { selection?: { idempotencyKey?: string; keywords?: string[] } } }> }>(page, 'tasks:list')).tasks;
      const selection = tasks.find((t) => t.id === first.selectionTaskId);
      expect(selection?.kind).toBe('selection');
      expect(selection?.status).toBe('queued');
      expect(selection?.payload?.selection?.idempotencyKey).toBe(first.idempotencyKey);
      expect(selection?.payload?.selection?.keywords).toContain('收纳好物源头工厂：理由二');
      expect(tasks.find((t) => t.id === taskId)?.status).toBe('completed');
    }, 30_000);

    const tasksAfter = (await invoke<{ tasks: unknown[] }>(page, 'tasks:list')).tasks;
    expect(tasksAfter.length).toBe(tasksBefore.length + 1);

    /* 重复确认：同 idempotency_key 不新建任务（行数不变） */
    const second = await invoke<{ created: boolean; selectionTaskId: string | null }>(page, 'gate:confirm', { taskId });
    expect(second.created).toBe(false);
    expect(second.selectionTaskId).toBe(first.selectionTaskId);
    const tasksAfterSecond = (await invoke<{ tasks: unknown[] }>(page, 'tasks:list')).tasks;
    expect(tasksAfterSecond.length).toBe(tasksAfter.length);
  });

  test('4. 第二轮采集闸门拒绝 → collect 任务 cancelled', async () => {
    const { taskId } = await invoke<{ taskId: string }>(page, 'collect:start', {
      inputType: 'keyword',
      keyword: '测试',
      topicId: 'e2e-gate-2',
      targetTotal: 50,
    });
    await pollUntil('第二轮报告闸门挂起（keyword_confirm）', async () => {
      const gates = (await invoke<{ gates: GateViewE2E[] }>(page, 'gate:list')).gates;
      const gate = gates.find((g) => g.taskId === taskId);
      expect(gate?.gate).toBe('keyword_confirm');
    }, 60_000);

    const rejected = await invoke<{ taskId: string; status: string }>(page, 'gate:reject', { taskId });
    expect(rejected.status).toBe('cancelled');
    const tasks = (await invoke<{ tasks: Array<{ id: string; status: string }> }>(page, 'tasks:list')).tasks;
    expect(tasks.find((t) => t.id === taskId)?.status).toBe('cancelled');
    const gates = (await invoke<{ gates: GateViewE2E[] }>(page, 'gate:list')).gates;
    expect(gates.find((g) => g.taskId === taskId)).toBeUndefined();
  });
});

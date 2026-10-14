/**
 * 用量面板 + 多 Key 故障转移 + 全局 RPM e2e（m1 todo 12 = FR-2.4/2.5/2.6 组合接线）。
 *
 * 诚实性：mock 的只有「LLM 服务商端点」（本地 http server，按 Authorization 头区分主/备 Key：
 * 主 Key 401、备用 Key 200——FR-2.4 轮换在真实网关链路里发生）；BYOK 多 Key 存取/网关轮换/
 * llm_calls 计量/usage 聚合/store 全链路生产。
 *
 * 场景：
 * 1. keys:set（custom 主 Key+备用 Key）→ keys:get-masked 回显 backupMasked；
 * 2. collect + resume 报告步骤 → 主 Key 401 → 网关自动切备用 → 报告生成成功；
 *    logs:query 查到 key:failover 留痕（脱敏形态）；
 * 3. usage:summary 聚合 llm_calls（calls≥8：八章至少各 1 请求 + 失败请求也计量）+ 自填单价估算；
 * 4. settings 视图用量面板渲染（data-usage-loaded）+ usage:setRpm 120 → summary 回读 → 复位 0。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron');
const scenarioFile = path.join(pkgRoot, 'e2e', 'fixtures', 'collect-scenario.json');

const PRIMARY_KEY = 'sk-e2e-primary-key';
const BACKUP_KEY = 'sk-e2e-backup-key';

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(async ([ch, pl]) => (await window.xinglian?.invoke(ch as string, pl)) as never, [channel, payload]) as Promise<T>;
}

test.describe.serial('用量面板 + 多 Key 故障转移（mock LLM 端点）', () => {
  let userData: string;
  let electronApp: ElectronApplication;
  let page: Page;
  let mockServer: Server;

  test.beforeAll(async () => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-usage-'));
    mockServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const auth = String(req.headers.authorization ?? '');
        if (!auth.includes(BACKUP_KEY)) {
          // FR-2.4 脚本：主 Key（或无 Key）一律 401 → 迫使网关轮换到备用 Key
          res.statusCode = 401;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { message: 'invalid api key (e2e primary)' } }));
          return;
        }
        const isSelectionChapter = body.includes('选品关键词建议');
        const value = isSelectionChapter
          ? { title: '⑦ 1688 选品关键词建议', summary: 'usage e2e 章节摘要', bullets: ['收纳好物源头工厂'] }
          : { title: 'usage e2e 章节', summary: 'usage e2e mock 章节摘要', bullets: ['要点一'] };
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
    const mockBaseUrl = `http://127.0.0.1:${address.port}/v1`;

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
    await invoke(page, 'keys:set', {
      provider: 'custom',
      key: PRIMARY_KEY,
      backupKeys: [BACKUP_KEY],
      baseUrl: mockBaseUrl,
      model: 'usage-e2e-model',
    });
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

  test('1. masked 回显备用 Key（FR-2.4 配置面）', async () => {
    const masked = await invoke<{ keys: Array<{ provider: string; masked: string | null; backupMasked: string[] }> }>(page, 'keys:get-masked');
    const custom = masked.keys.find((k) => k.provider === 'custom');
    expect(custom?.masked).toBe('sk-****-key');
    expect(custom?.backupMasked).toHaveLength(1);
    expect(custom?.backupMasked[0]).toBe('sk-****-key');
  });

  test('2. 主 Key 401 → 自动切备用 Key → 报告生成成功 + key:failover 留痕', async () => {
    const { taskId } = await invoke<{ taskId: string }>(page, 'collect:start', {
      inputType: 'keyword',
      keyword: '测试',
      topicId: 'usage-e2e-1',
      targetTotal: 50,
    });
    // Key 已配置：collect 四步 + 报告步骤（主 Key 401 → 网关轮换备用 → 8 章生成）
    // 一口气跑完 → keyword_confirm 闸门挂起 awaiting_user（全程无人工介入）
    await expect.poll(async () => {
      const tasks = (await invoke<{ tasks: Array<{ id: string; status: string }> }>(page, 'tasks:list')).tasks;
      return tasks.find((t) => t.id === taskId)?.status;
    }, { timeout: 60_000 }).toBe('awaiting_user');

    const reports = (await invoke<{ reports: Array<{ id: number }> }>(page, 'reports:list')).reports;
    expect(reports.length).toBeGreaterThanOrEqual(1);

    // key_failover 留痕：遥测（consent=false 本地留存）+ user-action 日志双通道，logs:query 可查
    await expect.poll(async () => {
      const logs = (await invoke<{ rows: Array<{ msg: string }> }>(page, 'logs:query', { limit: 200 })).rows;
      return logs.some((r) => r.msg === 'key:failover');
    }, { timeout: 15_000 }).toBe(true);
  });

  test('3. usage:summary 聚合 llm_calls + 自填单价估算（FR-2.5 IPC 面）', async () => {
    const before = await invoke<{
      totals: { calls: number; tokensIn: number; tokensOut: number; costEstimated: number; unestimatedCalls: number };
      byProviderModel: Array<{ key: string; calls: number }>;
      byWorkflow: Array<{ key: string; calls: number }>;
    }>(page, 'usage:summary', { days: 30 });
    // 8 章 × (1 次主 Key 401 + 1 次备用 Key 成功) ≥16 次请求（失败也计量）
    expect(before.totals.calls).toBeGreaterThanOrEqual(16);
    expect(before.totals.tokensIn).toBeGreaterThanOrEqual(8 * 11);
    expect(before.byWorkflow.find((b) => b.key === 'report')?.calls).toBeGreaterThanOrEqual(16);
    expect(before.totals.unestimatedCalls).toBe(before.totals.calls); // 未设单价：全部未估算（不造数）

    await invoke(page, 'usage:setPricing', { pricing: { 'custom/usage-e2e-model': { inputPer1k: 0.001, outputPer1k: 0.002 } } });
    const after = await invoke<{ totals: { costEstimated: number; unestimatedCalls: number } }>(page, 'usage:summary', { days: 30 });
    // 成功请求 8 次按单价估算：(11/1000*0.001 + 7/1000*0.002) × 8；401 行 tokens=0 估算 0 元
    // 也计入「已估算」（有单价依据）→ unestimated 归零
    expect(after.totals.costEstimated).toBeCloseTo(8 * 0.000025, 8);
    expect(after.totals.unestimatedCalls).toBe(0);
  });

  test('4. settings 用量面板渲染 + 全局 RPM 设置回读复位（FR-2.6）', async () => {
    await page.click('.nav-item[data-view="settings"]');
    await expect(page.locator('#view-settings')).toHaveClass(/active/);
    await page.waitForSelector('html[data-usage-loaded="1"]', { timeout: 15_000 });
    await expect(page.locator('#usage-totals')).toContainText('全部');
    await expect(page.locator('#usage-providers p').first()).toBeVisible();

    await page.fill('#usage-pricing-input', '{"custom/usage-e2e-model":{"inputPer1k":0.001}}');
    await page.click('#usage-pricing-save');
    await expect(page.locator('html[data-usage-pricing="done"]')).toBeAttached();

    await page.fill('#usage-rpm-input', '120');
    await page.click('#usage-rpm-save');
    await expect(page.locator('html[data-usage-rpm="done"]')).toBeAttached();
    const summary = await invoke<{ rpmGlobal: number }>(page, 'usage:summary', {});
    expect(summary.rpmGlobal).toBe(120);

    // 复位不限流（不污染同 userData 内其他用例的时序）
    await invoke(page, 'usage:setRpm', { rpm: 0 });
    const reset = await invoke<{ rpmGlobal: number }>(page, 'usage:summary', {});
    expect(reset.rpmGlobal).toBe(0);
  });
});

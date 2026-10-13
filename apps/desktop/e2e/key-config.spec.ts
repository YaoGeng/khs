/**
 * BYOK key-config e2e（m1 todo 10 = T-M1-08；FR-2.7 三要素 + 词库扫描验证通道）。
 *
 * 场景：
 * A. FR-2.7 三要素渲染：发送范围固定展示 + 服务商境内外标注（zhipu=境内 / openai=境外+不可达注记）
 *    + R9 角标（zhipu tool_calling 无「文档源」角标；json_schema 实测失败不承诺；embeddings/其余
 *    documented 格带「文档源，待实测」角标）。
 * B. keys:set → masked 读回（sk-****+后4位）+ 全值不在 DOM + DB 文件字节级不含明文
 *    （密文 Buffer 经真实 utilityProcess store worker 落库）。
 * C. failure：未配置 Key 点「测试连接」→ modal 确认后被阻止且指向配置（不报裸错误）。
 * D. 调用前 modal：首次弹出→确认→本地 mock 网关 200（真实 HTTP 链路 + 存储密文解密往返）；
 *    第二次同 provider 不再弹（会话内幂等）。
 * E. 词库扫描验证（keys:scan-test）：fixture 文本 6 命中 + 版本号 v1.0.0（keyword_hits 留痕经真实链路）。
 *
 * 诚实性：mock 的只有「LLM 服务商端点」（本地 http server）；Key 存取/词库/IPC/store 全是生产链路。
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureEulaAccepted } from './helpers';

const pkgRoot = path.join(__dirname, '..');
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron') as string;

const FULL_KEY = 'sk-e2e-byok-1234567890abcdef';
const SCAN_FIXTURE =
  '这款面霜全网第一，效果最好，100%有效；好评如潮，加V：abc123 领优惠，或者薇信 xhs01；再推荐医美整形机构。';

test.describe.serial('BYOK key-config（m1 todo 10 = T-M1-08）', () => {
  let userData: string;
  let electronApp: ElectronApplication;
  let page: Page;
  let mockServer: Server;
  let mockBaseUrl: string;
  let mockHits: number;

  test.beforeAll(async () => {
    userData = mkdtempSync(path.join(tmpdir(), 'xinglian-key-config-'));
    mockHits = 0;
    mockServer = createServer((req, res) => {
      mockHits += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }], usage: { total_tokens: 1 } }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address();
    if (address === null || typeof address === 'string') throw new Error('mock server 未监听');
    mockBaseUrl = `http://127.0.0.1:${address.port}/v1`;

    electronApp = await _electron.launch({
      executablePath: electronPath,
      args: ['out/main.js'],
      cwd: pkgRoot,
      env: { ...process.env, XINGLIAN_USER_DATA: userData },
    });
    page = await electronApp.firstWindow();
    await page.waitForSelector('html[data-app-mounted="1"]', { timeout: 30_000 });
    await ensureEulaAccepted(page);
    await page.click('.nav-item[data-view="settings"]');
    await expect(page.locator('#view-settings')).toHaveClass(/active/);
    await page.waitForSelector('html[data-key-masked-loaded="1"]', { timeout: 30_000 });
  });

  test.afterAll(async () => {
    await electronApp.close();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    rmSync(userData, { recursive: true, force: true });
  });

  test('A. FR-2.7 三要素：发送范围固定展示 + 境内外标注 + R9 角标口径', async () => {
    /* 要素①：调用内容发送范围说明固定展示 */
    await expect(page.locator('#key-scope-note')).toBeVisible();
    await expect(page.locator('#key-scope-note')).toContainText('调用内容发送范围说明');
    await expect(page.locator('#key-scope-note')).toContainText('LLM 服务商');

    /* 要素②：境内外标注（数据源 = provider-matrix 风险列） */
    await expect(page.locator('.key-provider-row[data-provider="zhipu"]')).toBeVisible();
    await expect(page.locator('.key-provider-row[data-provider="zhipu"]')).toHaveAttribute('data-region', '境内');
    await expect(page.locator('.key-provider-row[data-provider="openai"]')).toHaveAttribute('data-region', '境外');
    await expect(page.locator('.key-provider-row[data-provider="openai"] .key-provider-region-note')).toContainText('不可达');
    await expect(page.locator('.key-provider-row[data-provider="siliconflow"]')).toHaveAttribute('data-region', '境内');

    /* 要素③前置件：modal 存在于 DOM 且默认关闭（首次调用时才弹） */
    await expect(page.locator('#precall-modal')).toBeHidden();

    /* R9 角标（provider-matrix §3）：唯一实测通过格 zhipu tool_calling 无「文档源，待实测」角标 */
    const zhipuTool = page.locator('[data-cap-provider="zhipu"][data-cap-key="tool_calling"]');
    await expect(zhipuTool).toContainText('✅ 可用');
    await expect(zhipuTool).toContainText('实测 2026-10-13');
    expect(await zhipuTool.locator('[data-cap-badge="documented"]').count()).toBe(0);

    /* zhipu json_schema：实测失败格——不承诺能力，也不挂「文档源」角标（标注实测结论） */
    const zhipuJson = page.locator('[data-cap-provider="zhipu"][data-cap-key="json_schema"]');
    await expect(zhipuJson).toContainText('❌ 不可用');
    await expect(zhipuJson).toContainText('实测 2026-10-13 不支持');
    expect(await zhipuJson.locator('[data-cap-badge="documented"]').count()).toBe(0);
    expect(await zhipuJson.getByText('文档源，待实测').count()).toBe(0);

    /* zhipu embeddings：账号阻塞维持文档源 → 角标保留 */
    const zhipuEmb = page.locator('[data-cap-provider="zhipu"][data-cap-key="embeddings"]');
    await expect(zhipuEmb.locator('[data-cap-badge="documented"]')).toHaveText('文档源，待实测');

    /* documented 格一律带角标（抽查 openai json_schema 与 deepseek tool_calling） */
    await expect(page.locator('[data-cap-provider="openai"][data-cap-key="json_schema"] [data-cap-badge="documented"]')).toHaveText(
      '文档源，待实测',
    );
    await expect(page.locator('[data-cap-provider="deepseek"][data-cap-key="tool_calling"] [data-cap-badge="documented"]')).toHaveText(
      '文档源，待实测',
    );
  });

  test('B. keys:set → masked 读回 + 全值不出现在 DOM/DB 文件（真实 utilityProcess 密文落库）', async () => {
    await page.selectOption('#key-provider-select', 'custom');
    await page.fill('#key-input', FULL_KEY);
    await page.fill('#key-baseurl-input', mockBaseUrl);
    await page.fill('#key-model-input', 'e2e-gateway-model');
    await page.click('#key-save-btn');
    await page.waitForSelector('html[data-key-set="done"]', { timeout: 15_000 });

    /* masked 读回：仅 sk-****+后 4 位；plaintext 告警未触发（safeStorage 可用） */
    await expect(page.locator('#key-masked-list [data-provider="custom"]')).toContainText('sk-****cdef');
    await expect(page.locator('#key-masked-list [data-provider="custom"]')).toContainText('safeStorage 加密');
    expect(await page.getAttribute('html', 'data-key-plaintext-warning')).toBe('0');
    await expect(page.locator('#key-storage-warning')).toBeHidden();

    /* 全值不在渲染层 DOM 任何位置 */
    const domHtml = await page.evaluate(() => document.documentElement.outerHTML);
    expect(domHtml).not.toContain(FULL_KEY);

    /* DB 文件字节级断言：明文全值不存在（密文经真实 utilityProcess store worker 落 value_blob） */
    const dbBytes = readFileSync(path.join(userData, 'xinglian.db'));
    expect(dbBytes.includes(FULL_KEY)).toBe(false);
  });

  test('C. failure：未配置 Key 点「测试连接」→ 确认后被阻止且指向配置（不报裸错误）', async () => {
    await page.selectOption('#key-provider-select', 'deepseek');
    await page.click('#key-test-btn');
    /* deepseek 本会话未确认过 → 先弹调用前确认 modal */
    await page.waitForSelector('html[data-precall-modal="open"]', { timeout: 10_000 });
    await page.click('#precall-confirm-btn');
    /* keys:test 拒绝：E-KEY-NOT-CONFIGURED + 指向「保存 Key」配置入口 */
    await page.waitForSelector('html[data-key-test="blocked"]', { timeout: 15_000 });
    await expect(page.locator('#key-test-status')).toContainText('E-KEY-NOT-CONFIGURED');
    await expect(page.locator('#key-test-status')).toContainText('保存 Key');
    expect(mockHits).toBe(0);
  });

  test('D. 调用前 modal 每 provider 每会话一次；mock 网关真实往返（存储密文解密）', async () => {
    await page.selectOption('#key-provider-select', 'custom');
    /* 第一次：modal 出现（custom 未确认过） */
    await page.click('#key-test-btn');
    await page.waitForSelector('html[data-precall-modal="open"]', { timeout: 10_000 });
    await expect(page.locator('#precall-body')).toContainText('内容将发送至你所配置的 LLM 服务商');
    await expect(page.locator('#precall-provider-line')).toContainText('自定义网关');
    await page.click('#precall-confirm-btn');
    await page.waitForSelector('html[data-key-test="ok"]', { timeout: 15_000 });
    await expect(page.locator('#key-test-status')).toContainText('测试连接：成功');
    const hitsAfterFirst = mockHits;
    expect(hitsAfterFirst).toBeGreaterThanOrEqual(1);

    /* 第二次：同 provider 不再弹（会话内幂等），直接真实调用 */
    await page.click('#key-test-btn');
    await expect(page.locator('#precall-modal')).toBeHidden();
    expect(await page.getAttribute('html', 'data-precall-modal')).toBe('closed');
    await page.waitForSelector('html[data-key-test="ok"]', { timeout: 15_000 });
    expect(mockHits).toBe(hitsAfterFirst + 1);

    /* 设置页可重置提示状态 → 下次调用重新弹 */
    await page.click('#key-precall-reset-btn');
    await page.waitForSelector('html[data-precall-reset="reset"]', { timeout: 10_000 });
    await page.click('#key-test-btn');
    await page.waitForSelector('html[data-precall-modal="open"]', { timeout: 10_000 });
    await page.click('#precall-cancel-btn');
    await page.waitForSelector('html[data-precall-confirm="cancelled"]', { timeout: 10_000 });
    await expect(page.locator('#precall-modal')).toBeHidden();
    expect(mockHits).toBe(hitsAfterFirst + 1); // 取消 → 不发生真实调用
  });

  test('E. 词库扫描验证：fixture 6 命中 + 版本 v1.0.0（keyword_hits 真实留痕）', async () => {
    await page.fill('#scan-test-input', SCAN_FIXTURE);
    await page.click('#scan-test-btn');
    await page.waitForSelector('html[data-scan-test="done"]', { timeout: 15_000 });
    expect(await page.getAttribute('html', 'data-scan-test-hits')).toBe('6');
    expect(await page.getAttribute('html', 'data-scan-test-version')).toBe('1.0.0');
    await expect(page.locator('#scan-test-result')).toContainText('词库 v1.0.0');
    await expect(page.locator('#scan-test-result')).toContainText('命中 6 处');
    await expect(page.locator('#scan-test-result')).toContainText('[extreme/extreme-advertising] 最好');
    await expect(page.locator('#scan-test-result')).toContainText('[redirect] 加V');
    await expect(page.locator('#scan-test-result')).toContainText('[blacklist/medical-cosmetic] 医美');

    /* 未命中样本零误报 */
    await page.fill('#scan-test-input', '这款面霜质地轻盈，适合日常保湿，包装也很好看。');
    await page.click('#scan-test-btn');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-scan-test-hits') === '0', undefined, {
      timeout: 15_000,
    });
    await expect(page.locator('#scan-test-result')).toContainText('命中 0 处');
  });
});

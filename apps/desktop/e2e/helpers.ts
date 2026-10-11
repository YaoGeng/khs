/**
 * e2e 共用助手（todo 9 引入）。
 *
 * 「已确认 EULA」种子：todo 9 起，未确认 EULA 时主进程 app:navigate 对六个工作流视图
 * 返回 E-COMPLIANCE-EULA-LOCKED（FR-1.9）——历史 shell/license/kill-recover e2e 的首屏假设
 * 是九视图全可达，故在挂载后**走真实 UI 确认流**（点「同意并继续」→ consent:acceptEula
 * → 落 consents 表 → 渲染层应用解锁态）补种子。不是测试后门：不旁路任何生产路径，
 * 只是替"测试用户"点了一次同意；telemetryConsent=false：不为旧 e2e 开通遥测（FR-12.6 opt-in）。
 */
import type { Page } from '@playwright/test';

export async function ensureEulaAccepted(page: Page): Promise<void> {
  await page.waitForSelector('html[data-consent-loaded="1"]', { timeout: 30_000 });
  if ((await page.getAttribute('html', 'data-eula-requires-confirm')) === '1') {
    await page.click('#eula-accept-btn');
    await page.waitForSelector('html[data-eula-accept="done"]', { timeout: 15_000 });
  }
  await page.waitForSelector('html[data-eula-requires-confirm="0"]', { timeout: 15_000 });
  await page.waitForSelector('#eula-modal', { state: 'hidden', timeout: 15_000 });
}

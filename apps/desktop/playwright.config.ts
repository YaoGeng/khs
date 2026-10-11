import { defineConfig } from '@playwright/test';

// C 端 e2e：Playwright _electron.launch 直接启动打包产物 out/main.js（Electron 二进制
// 由 apps/desktop/node_modules/electron 提供，无需额外浏览器下载）。
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
});

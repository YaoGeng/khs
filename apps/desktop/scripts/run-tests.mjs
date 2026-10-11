// 单测运行器（todo 11 / ADR-8 ABI 落位）：vitest 一律在 ELECTRON_RUN_AS_NODE=1 下
// 由 Electron 二进制（内置 Node，ABI 130）执行——better-sqlite3 已换装 electron-v130
// 预编译（见 docs/adr/ADR-8-sqlite-write.md §3），一个 ABI 同时服务 vitest 与打包运行时。
// 宿主 node（ABI 137）不再加载 better-sqlite3，故 vitest 不能再直接跑。
//
// 用法：node scripts/run-tests.mjs [vitest 参数透传...]（默认追加 "run"）
/* global process, console */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const req = createRequire(path.join(pkgRoot, 'package.json'));

// Electron 可执行文件：node 环境下 require('electron') 导出 dist 下二进制路径（非 GUI API）
const electronPath = req('electron');
// vitest CLI 入口（vitest 2.x：包根 vitest.mjs；exports "." wildcard 可解析）
const vitestMjs = req.resolve('vitest/vitest.mjs');

const userArgs = process.argv.slice(2);
const args = [vitestMjs, 'run', ...userArgs];

const child = spawn(electronPath, args, {
  cwd: pkgRoot,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  windowsHide: true,
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[run-tests] vitest killed by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error('[run-tests] failed to spawn electron-as-node:', error);
  process.exit(1);
});

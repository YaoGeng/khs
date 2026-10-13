/**
 * better-sqlite3 ABI 保障脚本（ADR-8/T11 双运行时设计）：
 * desktop 的 better-sqlite3 统一为 electron ABI（v130，Electron 33）——
 * vitest 在 ELECTRON_RUN_AS_NODE=1 下运行（scripts/run-tests.mjs），打包态由 electron-builder
 * asarUnpack + @electron/rebuild 使用同一 ABI。宿主 node（ABI 137）不得直接加载本包。
 *
 * 问题背景：任何 `pnpm install` 都会把 store 内 better-sqlite3 重置回 node ABI；
 * 且 require('better-sqlite3') 是惰性 dlopen（仅 require 不加载原生模块），检测必须真实构造 Database。
 * 本脚本实证检测并幂等换装，供 run-tests.mjs 与根 postinstall 调用。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
/* global console */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const requireFromDesktop = createRequire(path.join(desktopRoot, 'noop.js'));

const PROBE = "try{const D=require('better-sqlite3');const db=new D(':memory:');db.exec('create table p(a)');db.close();console.log('REAL_OK')}catch(e){console.log('REAL_FAIL:',e.message.slice(0,120))}";

function realLoadOk() {
  const r = spawnSync(requireFromDesktop('electron'), ['-e', PROBE], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: desktopRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return r.status === 0 && (r.stdout || '').includes('REAL_OK');
}

function swapToElectronAbi() {
  const bs3Dir = path.dirname(requireFromDesktop.resolve('better-sqlite3/package.json'));
  const prebuildBin = requireFromDesktop.resolve('prebuild-install/bin.js', {
    paths: [bs3Dir],
  });
  return spawnSync(
    process.execPath,
    [prebuildBin, '--runtime=electron', '--target=33.4.11', '--verbose'],
    {
      cwd: bs3Dir,
      encoding: 'utf8',
      timeout: 300_000,
      env: {
        ...process.env,
        npm_config_better_sqlite3_binary_host_mirror:
          process.env.npm_config_better_sqlite3_binary_host_mirror ||
          'https://registry.npmmirror.com/-/binary/better-sqlite3',
      },
    },
  );
}

export function ensureElectronAbi({ silent = false } = {}) {
  if (realLoadOk()) return { ok: true, swapped: false };
  const swap = swapToElectronAbi();
  if (!realLoadOk()) {
    if (!silent) {
      console.error('[ensure-electron-abi] electron-ABI 换装后仍无法加载 better-sqlite3');
      console.error('[ensure-electron-abi] prebuild-install:', (swap.stdout || '') + (swap.stderr || ''));
    }
    return { ok: false, swapped: true };
  }
  if (!silent) console.log('[ensure-electron-abi] better-sqlite3 已换装 electron ABI (v130)');
  return { ok: true, swapped: true };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(ensureElectronAbi().ok ? 0 : 1);
}

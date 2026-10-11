// dist 脚本：为 electron-builder 注入二进制镜像（本机 GitHub 不可达，npmmirror registry 域可达，2026-10-11 实测）。
// @electron/get（Electron 二进制）与 electron-builder-binaries（NSIS/winCodeSign）默认走 GitHub Releases。
/* global process */
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';
process.env.ELECTRON_MIRROR =
  process.env.ELECTRON_MIRROR || 'https://registry.npmmirror.com/-/binary/electron/';
// better-sqlite3 预编译包（electron ABI）走 npmmirror 镜像（prebuild-install 约定的 npm_config_* 键）
process.env.npm_config_better_sqlite3_binary_host_mirror =
  process.env.npm_config_better_sqlite3_binary_host_mirror ||
  'https://registry.npmmirror.com/-/binary/better-sqlite3';

const r = spawnSync('electron-builder', ['--win'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
  cwd: dirname(fileURLToPath(import.meta.url)) + '/..',
});
process.exit(r.status ?? 1);

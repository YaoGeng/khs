// dist 脚本：为 electron-builder 注入二进制镜像（本机 GitHub 不可达，npmmirror registry 域可达，2026-10-11 实测）。
// @electron/get（Electron 二进制）与 electron-builder-binaries（NSIS/winCodeSign）默认走 GitHub Releases。
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';
process.env.ELECTRON_MIRROR =
  process.env.ELECTRON_MIRROR || 'https://registry.npmmirror.com/-/binary/electron/';

const r = spawnSync('electron-builder', ['--win'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
  cwd: dirname(fileURLToPath(import.meta.url)) + '/..',
});
process.exit(r.status ?? 1);

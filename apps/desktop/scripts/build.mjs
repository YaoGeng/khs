// 构建脚本（T-M0-02 重构版）：串行打包三个入口 + 拷贝静态资源。
// 保持既有契约：out/main.js（electron-builder main 字段指向）+ renderer/preload 资源齐备；
// dist 链路（scripts/dist.mjs 的镜像注入 + electron-builder --win）不变。
// esbuild 多次调用分别打包：main(cjs, external electron) / preload(cjs, external electron) /
// renderer(iife, browser)；随后 tsc -p tsconfig.json 做 noEmit 类型门禁。
/* global process, console */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(pkgRoot, 'out');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const common = { bundle: true, sourcemap: false, logLevel: 'info', absWorkingDir: pkgRoot };

await build({
  ...common,
  entryPoints: [path.join(pkgRoot, 'src/main.ts')],
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  outfile: path.join(out, 'main.js'),
});

await build({
  ...common,
  entryPoints: [path.join(pkgRoot, 'src/preload.ts')],
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  outfile: path.join(out, 'preload.js'),
});

await build({
  ...common,
  entryPoints: [path.join(pkgRoot, 'src/renderer/main.ts')],
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  outfile: path.join(out, 'renderer.js'),
});

fs.cpSync(path.join(pkgRoot, 'src/index.html'), path.join(out, 'index.html'));
fs.cpSync(path.join(pkgRoot, 'src/renderer/shell.css'), path.join(out, 'renderer.css'));

// 类型门禁（noEmit）：main/preload/renderer/shared 全量过 tsc；失败即构建失败。
// @types/node 经 apps/desktop/node_modules/@types junction 解析（无 pnpm add 的等价安装态，见任务风险注记）。
const tsc = spawnSync('tsc -p tsconfig.json', {
  cwd: pkgRoot,
  stdio: 'inherit',
  shell: true,
  env: process.env,
});
if (tsc.status !== 0) {
  console.error('[build] tsc typecheck failed');
  process.exit(tsc.status ?? 1);
}

console.log('[build] ok: out/main.js out/preload.js out/renderer.js out/renderer.css out/index.html');

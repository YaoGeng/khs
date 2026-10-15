#!/usr/bin/env node
/**
 * pilot-ready 真实联调驱动脚本（m1-insight-plan todo 7⑨；真实 10-20 条执行窗口 = W2 人工白名单②，
 * 本卡延期至 todo-13 前的独立验证窗口——本脚本 + pilot-runbook.md 即本卡的 pilot-ready 交付物）。
 *
 * 用法：
 *   node apps/desktop/scripts/pilot-real-collect.mjs stage     # 适配包签名落盘到 <userData>/adapters/xhs/1.0.0 + 写 active.json（loader 每次启动仍全链复验）
 *   node apps/desktop/scripts/pilot-real-collect.mjs doctor    # 前置体检（浏览器/公钥/适配包/配额 env）
 *   node apps/desktop/scripts/pilot-real-collect.mjs launch    # 以真实模式（无 fixture）+ 保守配额 ≤50/日 启动桌面端
 *   node apps/desktop/scripts/pilot-real-collect.mjs run --terms 冰丝防晒衣,防晒口罩 --target 50 --limit 100
 *   node apps/desktop/scripts/pilot-real-collect.mjs run --resume <taskId> --limit 100
 *     # run = launch + XINGLIAN_PILOT_AUTOCOLLECT 自动采集 seam（启动后自动接管平台浏览器并开始采集）
 *
 * 红线（02:321）：不做任何风控绕过；触熔断立即停窗并记录升级。
 */
/* global process, console, URL */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const DESKTOP = join(ROOT, 'apps', 'desktop');
const SIGN_CLI = join(ROOT, 'scripts', 'adapter-sign.mjs');
const XHS_PKG = join(ROOT, 'packages', 'adapters-xhs');
const req = createRequire(join(DESKTOP, 'noop.js'));
const electronPath = req('electron');

const userData = process.env.XINGLIAN_USER_DATA
  ?? join(process.env.LOCALAPPDATA ?? join(ROOT, 'tmp-userdata'), 'xinglian-workbench');
const adaptersRoot = join(userData, 'adapters', 'xhs');
const version = '1.0.0';
const pkgDir = join(adaptersRoot, version);
const pubkeyEnv = process.env.XINGLIAN_ADAPTER_PUBKEY_FILE
  ?? join(ROOT, '.omo', 'secrets', 'adapter-dev-key', 'adapter-dev-key-public.pem');

function command(name, args) {
  try {
    const out = execFileSync(name, args, { encoding: 'utf8', cwd: ROOT, windowsHide: true, shell: false });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.message}` };
  }
}

async function stage() {
  // 1) 组包：dsl.json（= adapters-xhs 内置 DSL 单一真源）+ fixtures/；签名 CLI 内做 schema 前置校验
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });
  const { xhsAdapterDsl } = await import(new URL(`file:///${join(XHS_PKG, 'dist', 'index.js').replace(/\\/g, '/')}`).href);
  writeFileSync(join(pkgDir, 'dsl.json'), JSON.stringify({ ...xhsAdapterDsl, version, minEngineVersion: '1.0.0' }, null, 2));
  cpSync(join(XHS_PKG, 'fixtures'), join(pkgDir, 'fixtures'), { recursive: true });

  // 2) 签名（dev 私钥仅本地；不入库不入 git）
  const keyFile = join(ROOT, '.omo', 'secrets', 'adapter-dev-key', 'adapter-dev-key-private.pem');
  if (!existsSync(keyFile)) {
    const gen = command('node', [SIGN_CLI, 'keygen']);
    if (!gen.ok) throw new Error(`dev keypair 生成失败：${gen.out.slice(0, 300)}`);
  }
  const sign = command('node', [SIGN_CLI, 'sign', pkgDir, '--key', keyFile]);
  if (!sign.ok) throw new Error(`签名失败：${sign.out.slice(0, 300)}`);

  // 3) dev bootstrap：验签通过后写 active.json（引擎每次启动仍走完整加载链复验，02 §15.2）
  const verify = command('node', [SIGN_CLI, 'verify', pkgDir, '--key', pubkeyEnv]);
  if (!verify.ok) throw new Error(`验签失败：${verify.out.slice(0, 300)}`);
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'manifest.json'), 'utf8'));
  writeFileSync(
    join(adaptersRoot, 'active.json'),
    `${JSON.stringify({ platform: 'xhs', version: manifest.version, activatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(`[pilot] 适配包已就绪：${pkgDir}`);
}

function doctor() {
  const checks = [];
  checks.push(['构建产物 out/main.js', existsSync(join(DESKTOP, 'out', 'main.js')), 'pnpm --filter desktop build']);
  checks.push(['引擎公钥', existsSync(pubkeyEnv), `存在 .omo/secrets/adapter-dev-key/adapter-dev-key-public.pem（或设 XINGLIAN_ADAPTER_PUBKEY_FILE）`]);
  checks.push(['适配包 dsl.json', existsSync(join(pkgDir, 'dsl.json')), 'node apps/desktop/scripts/pilot-real-collect.mjs stage']);
  checks.push(['active.json', existsSync(join(adaptersRoot, 'active.json')), 'stage 命令自动写入']);
  checks.push(['本机 Chrome/Edge', ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].some((p) => existsSync(p)), '安装 Chrome/Edge（FR-3.1 探测链）']);
  // M2 B2：内置便携 Chromium 状态（informational，不阻断——探测顺序 builtin 优先，Chrome/Edge 兜底）
  const builtinRoot = process.env.XINGLIAN_BUILTIN_BROWSER_ROOT
    ?? join(process.env.LOCALAPPDATA ?? '', 'xinglian-workbench', 'browsers');
  const builtinExe = join(builtinRoot, `chromium-1710741`, 'chrome-win', 'chrome.exe');
  checks.push([`内置 Chromium（1710741）${existsSync(builtinExe) ? '已安装' : '未安装（兜底可用即可跑）'}`, true, '设置页「内置浏览器」下载，或忽略走本机浏览器']);
  let failed = 0;
  for (const [label, ok, fix] of checks) {
    console.log(`[pilot] ${ok ? 'OK  ' : 'MISS'} ${label}${ok ? '' : `  → ${fix}`}`);
    if (!ok) failed += 1;
  }
  console.log(`[pilot] 配额口径：XINGLIAN_COLLECT_DAILY_LIMIT=${process.env.XINGLIAN_COLLECT_DAILY_LIMIT ?? '(未设，默认 300 硬上限；launch 默认 ≤50，run 可 --limit 调整 ≤300)'}`);
  if (failed > 0) {
    console.error(`[pilot] ${failed} 项前置缺失，先补齐再 launch`);
    process.exit(1);
  }
  console.log('[pilot] 前置齐备；操作步骤见 .omo/evidence/m1-insight-plan/pilot-runbook.md');
}

function launch(extraEnv = {}) {
  doctor();
  const env = {
    ...process.env,
    XINGLIAN_COLLECT_DAILY_LIMIT: process.env.XINGLIAN_COLLECT_DAILY_LIMIT ?? '50',
    XINGLIAN_COLLECT_PACING_SCALE: process.env.XINGLIAN_COLLECT_PACING_SCALE ?? '1',
    ...extraEnv,
  };
  delete env.XINGLIAN_COLLECT_FIXTURE; // 真实模式：绝无 fixture 后门
  console.log('[pilot] 启动桌面端（真实 CDP 模式；触熔断立即停窗——02:321 红线）');
  const child = spawn(electronPath, ['out/main.js'], { cwd: DESKTOP, env, stdio: 'inherit', windowsHide: false });
  child.on('exit', (code) => process.exit(code ?? 0));
}

/** run = launch + 自动采集 seam：--terms a,b,c（1~5 词 or 组合）或 --resume <taskId>；--limit 覆盖日配额 */
function run(args) {
  const opts = { terms: null, target: '50', topic: 'pilot-1', limit: null, resume: null };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (key === '--terms') opts.terms = value;
    else if (key === '--target') opts.target = value;
    else if (key === '--topic') opts.topic = value;
    else if (key === '--limit') opts.limit = value;
    else if (key === '--resume') opts.resume = value;
    else {
      console.error(`[pilot] run 未知参数 ${key}（支持 --terms/--target/--topic/--limit/--resume）`);
      process.exit(1);
    }
  }
  let auto;
  if (opts.resume) {
    auto = { action: 'resume', taskId: String(opts.resume) };
  } else {
    if (!opts.terms) {
      console.error('[pilot] run 需要 --terms 词1,词2,…（1~5 词）或 --resume <taskId>');
      process.exit(1);
    }
    const terms = String(opts.terms).split(',').map((s) => s.trim()).filter(Boolean);
    if (terms.length === 0 || terms.length > 5) {
      console.error('[pilot] --terms 须为 1~5 个逗号分隔词');
      process.exit(1);
    }
    const payload = terms.length === 1
      ? { inputType: 'keyword', keyword: terms[0], topicId: opts.topic, targetTotal: Number(opts.target) }
      : { inputType: 'keyword', terms, operator: 'or', topicId: opts.topic, targetTotal: Number(opts.target) };
    auto = { action: 'collect', payload };
  }
  if (opts.limit !== null && process.env.XINGLIAN_COLLECT_DAILY_LIMIT) {
    console.error('[pilot] --limit 与外部 XINGLIAN_COLLECT_DAILY_LIMIT 同时设置，以 --limit 为准');
  }
  const extraEnv = {
    XINGLIAN_PILOT_AUTOCOLLECT: JSON.stringify(auto),
    ...(opts.limit !== null ? { XINGLIAN_COLLECT_DAILY_LIMIT: String(opts.limit) } : {}),
  };
  console.log(`[pilot] 自动采集指令：${extraEnv.XINGLIAN_PILOT_AUTOCOLLECT}`);
  launch(extraEnv);
}

const [, , cmd, ...rest] = process.argv;
if (cmd === 'stage') await stage();
else if (cmd === 'doctor') doctor();
else if (cmd === 'launch') launch();
else if (cmd === 'run') run(rest);
else {
  console.log('用法: node apps/desktop/scripts/pilot-real-collect.mjs <stage|doctor|launch|run>');
  process.exit(cmd === undefined ? 0 : 1);
}

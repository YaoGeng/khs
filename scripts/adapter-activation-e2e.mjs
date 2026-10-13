#!/usr/bin/env node
// 适配层热更「签名→验签→自检→激活→回滚」全流程 QA / 门禁④载体脚本（todo 4 交付，todo 13 收口）。
// 前置：pnpm -r build（packages/protocol|adapter-loader|adapters-xhs 的 dist）。
// 三段（与 05 门禁④口径一致）：
//   ① 合法 v1 包 → CLI 签名 → loader 激活，断言 activeVersion=v1
//   ② v2 签名后篡改 dsl.json 一个字节 → load 拒绝且 active.json 仍 v1
//   ③ v3 自检 fixture 缺特征 → selfcheck_fail 遥测 + 回滚 last-good（active 仍 v1）
// 产物：.omo/evidence/m1-insight-plan/activation-transcript.json；任一断言失败 → 退出码 1。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVIDENCE_DIR = join(ROOT, '.omo', 'evidence', 'm1-insight-plan');
const SIGN_CLI = join(ROOT, 'scripts', 'adapter-sign.mjs');
const KEY_DIR = join(ROOT, '.omo', 'secrets', 'adapter-dev-key');
const PLATFORM = 'xhs';
const V1 = '1.0.0';
const V2 = '1.0.1';
const V3 = '1.0.2';

async function importBuilt(rel) {
  try {
    return await import(new URL(rel, import.meta.url).href);
  } catch {
    console.error(`[activation-e2e] ${rel} 不可加载，请先执行: pnpm -r build`);
    process.exit(1);
  }
}

const loader = await importBuilt('../packages/adapter-loader/dist/index.js');
const xhs = await importBuilt('../packages/adapters-xhs/dist/index.js');
const protocol = await importBuilt('../packages/protocol/dist/index.js');

function runCli(args) {
  try {
    const stdout = execFileSync('node', [SIGN_CLI, ...args], { encoding: 'utf8', cwd: ROOT });
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? String(error) };
  }
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

const transcript = { generatedAt: new Date().toISOString(), engineVersion: loader.ENGINE_DSL_VERSION, segments: [], pass: true };

function record(segment) {
  transcript.segments.push(segment);
  if (segment.ok !== true) transcript.pass = false;
  console.log(`[activation-e2e] ${segment.name}: ${segment.ok ? 'PASS' : 'FAIL'} ${segment.detail ?? ''}`);
}

// 准备：dev keypair（缺则经 CLI keygen 生成；.omo/secrets/ 已被 .gitignore 覆盖）
const privPath = join(KEY_DIR, 'adapter-dev-key-private.pem');
const pubPath = join(KEY_DIR, 'adapter-dev-key-public.pem');
if (!(await exists(privPath)) || !(await exists(pubPath))) {
  const keygen = runCli(['keygen', '--out', KEY_DIR]);
  if (keygen.exitCode !== 0) {
    console.error(`[activation-e2e] keygen 失败:\n${keygen.stdout}`);
    process.exit(1);
  }
}
const publicKey = protocol.normalizePem(await readFile(pubPath, 'utf8'));

// 工作区：临时目录 staged 包 + evidence 目录 transcript
const workRoot = await mkdtemp(join(tmpdir(), 'khs-activation-e2e-'));
const adaptersRoot = join(workRoot, 'adapters');
const fixturesSrc = join(ROOT, 'packages', 'adapters-xhs', 'fixtures');

async function stagePackage(version, { tamper = false, breakFixture = false } = {}) {
  const pkgDir = join(adaptersRoot, PLATFORM, version);
  await mkdir(pkgDir, { recursive: true });
  const dsl = structuredClone(xhs.xhsAdapterDsl);
  dsl.version = version;
  const dslJson = JSON.stringify(dsl, null, 2);
  await writeFile(join(pkgDir, 'dsl.json'), dslJson, 'utf8');
  await cp(fixturesSrc, join(pkgDir, 'fixtures'), { recursive: true });
  if (breakFixture) {
    // 自检失败注入：移除搜索页的登录入口特征 → login-entry 用例未命中
    const searchPath = join(pkgDir, 'fixtures', 'search.html');
    await writeFile(searchPath, (await readFile(searchPath, 'utf8')).replace('<button class="login-btn">登录</button>', ''), 'utf8');
  }
  const sign = runCli(['sign', pkgDir, '--key', privPath]);
  if (sign.exitCode !== 0) throw new Error(`签名失败 v${version}: ${sign.stdout}`);
  if (tamper) {
    // v2 篡改一字节：签名后替换 selector 首字符（sha256 完整性必炸）
    const path = join(pkgDir, 'dsl.json');
    await writeFile(path, (await readFile(path, 'utf8')).replace('#search-input', '.search-input'), 'utf8');
  }
  return pkgDir;
}

const telemetryEvents = [];
const loadOpts = (version) => ({
  adaptersRoot,
  platform: PLATFORM,
  version,
  engineVersion: loader.ENGINE_DSL_VERSION,
  publicKey,
  emitTelemetry: (event, payload) => telemetryEvents.push({ event, payload }),
});

try {
  // 段① 合法 v1：CLI 签名 → 激活成功 activeVersion=v1
  await stagePackage(V1);
  const cliVerify = runCli(['verify', join(adaptersRoot, PLATFORM, V1), '--key', pubPath]);
  const load1 = await loader.loadAdapterPackage(loadOpts(V1));
  const active1 = await loader.readActiveRecord(adaptersRoot, PLATFORM);
  record({
    name: `① 合法包激活（pnpm adapter:sign → load，engine=${loader.ENGINE_DSL_VERSION}）`,
    ok: load1.ok === true && load1.version === V1 && active1?.version === V1 && cliVerify.exitCode === 0,
    detail: `cliVerify=${cliVerify.exitCode}, activeVersion=${active1?.version ?? 'null'}`,
  });

  // 段② v2 篡改一字节：load 拒绝且 active.json 仍 v1
  await stagePackage(V2, { tamper: true });
  const load2 = await loader.loadAdapterPackage(loadOpts(V2));
  const active2 = await loader.readActiveRecord(adaptersRoot, PLATFORM);
  record({
    name: `② v2 篡改一字节 → 拒绝且 active 保持 v1`,
    ok: load2.ok === false && load2.reason === 'integrity_mismatch' && active2?.version === V1,
    detail: `reason=${load2.ok ? 'activated(!)' : load2.reason}, activeVersion=${active2?.version ?? 'null'}`,
  });

  // 段③ v3 自检失败：selfcheck_fail 遥测 + 回滚 last-good
  await stagePackage(V3, { breakFixture: true });
  const load3 = await loader.loadAdapterPackage(loadOpts(V3));
  const active3 = await loader.readActiveRecord(adaptersRoot, PLATFORM);
  record({
    name: `③ v3 自检失败 → selfcheck_fail 遥测 + 回滚 last-good`,
    ok: load3.ok === false
      && load3.reason === 'selfcheck_failed'
      && active3?.version === V1
      && telemetryEvents.some((e) => e.event === 'selfcheck_fail' && e.payload?.version === V3),
    detail: `reason=${load3.ok ? 'activated(!)' : load3.reason}, activeVersion=${active3?.version ?? 'null'}, telemetry=${telemetryEvents.map((e) => e.event).join(',') || 'none'}`,
  });
} catch (error) {
  record({ name: '执行异常', ok: false, detail: error instanceof Error ? error.message : String(error) });
} finally {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(join(EVIDENCE_DIR, 'activation-transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
  await rm(workRoot, { recursive: true, force: true });
  console.log(`[activation-e2e] transcript → ${join(EVIDENCE_DIR, 'activation-transcript.json')}`);
}
process.exit(transcript.pass ? 0 : 1);
#!/usr/bin/env node
// Dev-only Ed25519 适配包签名 CLI（T-M1-02；私钥=人工白名单③，仅本地 dev 用，不入库不入 git）。
// 依赖 @xinglian/protocol 的 dist 产物（schema + 规范化签名载荷），先执行：
//   pnpm --filter @xinglian/protocol build
//
// 用法：
//   node scripts/adapter-sign.mjs keygen [--out <dir>]     生成 dev keypair（默认 .omo/secrets/adapter-dev-key/，已被 .gitignore 覆盖）
//   node scripts/adapter-sign.mjs sign <packageDir> [--key <privatePem>]    读取包内 dsl.json → 校验 schema → 写 manifest.json
//   node scripts/adapter-sign.mjs verify <packageDir> [--key <publicPem>]   校验包（sha256 + 验签），退出码 0/1
//
// 包目录布局：<packageDir>/dsl.json + fixtures/** → 签名后生成 <packageDir>/manifest.json
// manifest = { platform, version, minEngineVersion, sha256, sig }；sig = Ed25519(manifestSignablePayload)。

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_KEY_DIR = join(ROOT, '.omo', 'secrets', 'adapter-dev-key');
const PRIVATE_FILE = 'adapter-dev-key-private.pem';
const PUBLIC_FILE = 'adapter-dev-key-public.pem';

let protocol;
try {
  protocol = await import(new URL('../packages/protocol/dist/index.js', import.meta.url).href);
} catch {
  console.error('[adapter-sign] 无法加载 @xinglian/protocol（dist 缺失），请先执行: pnpm --filter @xinglian/protocol build');
  exit(1);
}

const USAGE = [
  '用法:',
  '  node scripts/adapter-sign.mjs keygen [--out <dir>]',
  '  node scripts/adapter-sign.mjs sign <packageDir> [--key <privatePem>]',
  '  node scripts/adapter-sign.mjs verify <packageDir> [--key <publicPem>]',
].join('\n');

function flagOf(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readPemLenient(text) {
  const begin = text.indexOf('-----BEGIN');
  return begin > 0 ? text.slice(begin) : text;
}

async function loadPrivateKey(path) {
  return createPrivateKey(readPemLenient(await readFile(path, 'utf8')));
}

async function loadPublicKey(path) {
  return createPublicKey(readPemLenient(await readFile(path, 'utf8')));
}

async function cmdKeygen(outDir) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  await mkdir(outDir, { recursive: true });
  const privPath = join(outDir, PRIVATE_FILE);
  const pubPath = join(outDir, PUBLIC_FILE);
  await writeFile(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`[adapter-sign] dev keypair 已生成（不入库）:\n  私钥 ${privPath}\n  公钥 ${pubPath}`);
}

async function cmdSign(packageDir, keyPath) {
  const dslPath = join(packageDir, protocol.ADAPTER_DSL_FILE);
  const dslBytes = await readFile(dslPath);
  const parsedDsl = JSON.parse(dslBytes.toString('utf8'));
  const check = protocol.AdapterDslSchema.safeParse(parsedDsl);
  if (!check.success) {
    console.error('[adapter-sign] dsl.json 不符合 DSL v1.1，拒绝签名:');
    for (const issue of check.error.issues) {
      console.error(`  - ${issue.path.map(String).join('.')}: ${issue.message}`);
    }
    exit(1);
  }
  const manifest = {
    platform: check.data.platform,
    version: check.data.version,
    minEngineVersion: check.data.minEngineVersion,
    sha256: createHash('sha256').update(dslBytes).digest('hex'),
  };
  const payload = Buffer.from(protocol.manifestSignablePayload(manifest), 'utf8');
  const sig = ed25519Sign(null, payload, await loadPrivateKey(keyPath)).toString('base64');
  const manifestPath = join(packageDir, protocol.ADAPTER_MANIFEST_FILE);
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, sig }, null, 2)}\n`, 'utf8');
  console.log(`[adapter-sign] 已签名: ${manifestPath}`);
  console.log(JSON.stringify({ ...manifest, sig: `${sig.slice(0, 12)}...` }, null, 2));
}

async function cmdVerify(packageDir, pubPath) {
  const manifest = protocol.AdapterManifestSchema.parse(
    JSON.parse(await readFile(join(packageDir, protocol.ADAPTER_MANIFEST_FILE), 'utf8')),
  );
  const dslBytes = await readFile(join(packageDir, protocol.ADAPTER_DSL_FILE));
  const actualSha256 = createHash('sha256').update(dslBytes).digest('hex');
  if (actualSha256 !== manifest.sha256.toLowerCase()) {
    console.error(`[adapter-sign] FAIL sha256 不匹配 (manifest=${manifest.sha256}, actual=${actualSha256})`);
    exit(1);
  }
  const ok = ed25519Verify(
    null,
    Buffer.from(protocol.manifestSignablePayload(manifest), 'utf8'),
    await loadPublicKey(pubPath),
    Buffer.from(manifest.sig, 'base64'),
  );
  if (!ok) {
    console.error('[adapter-sign] FAIL Ed25519 验签失败');
    exit(1);
  }
  console.log(`[adapter-sign] PASS ${packageDir} (${manifest.platform}@${manifest.version})`);
}

const [command, positional] = argv.slice(2);
try {
  if (command === 'keygen') {
    await cmdKeygen(resolve(flagOf('--out') ?? DEFAULT_KEY_DIR));
  } else if (command === 'sign') {
    if (!positional) throw new Error('sign 需要 <packageDir>');
    await cmdSign(resolve(positional), resolve(flagOf('--key') ?? join(DEFAULT_KEY_DIR, PRIVATE_FILE)));
  } else if (command === 'verify') {
    if (!positional) throw new Error('verify 需要 <packageDir>');
    await cmdVerify(resolve(positional), resolve(flagOf('--key') ?? join(DEFAULT_KEY_DIR, PUBLIC_FILE)));
  } else {
    console.error(USAGE);
    exit(1);
  }
} catch (error) {
  console.error(`[adapter-sign] 失败: ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
}

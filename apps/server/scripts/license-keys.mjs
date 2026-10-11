// Ed25519 license 测试密钥对生成（todo 8 / T-M0-07）。
//
// 用法：
//   node scripts/license-keys.mjs            # 缺失时生成 keys/license-private.pem + license-public.pem
//   node scripts/license-keys.mjs --force    # 覆盖现有密钥对（会使已签发 license 全部失效）
//
// 说明：
// - node:crypto generateKeyPairSync('ed25519')，输出 SPKI/PKCS8 PEM；无任何新依赖。
// - M0 决策（见 docs/adr/notes-license-m0.md §1）：提交一副「固定测试密钥对」，
//   公钥同时内置到 apps/desktop/src/license/public-key.ts，保证 server 签发 / desktop 验签一致；
//   私钥仅用于 M0 dev/test 签发，严禁用于任何生产环境。
// - M5 轮换策略：生产私钥离线保管（KMS/HSM），license JWT header 携带 kid，
//   客户端内置多把公钥按 kid 选择 + 宽限期双钥并验；M0 单钥 kid=m0-license-test-1。
/* global console, process */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keysDir = path.join(serverRoot, 'keys');
const privatePath = path.join(keysDir, 'license-private.pem');
const publicPath = path.join(keysDir, 'license-public.pem');

const force = process.argv.includes('--force');
if (!force && existsSync(privatePath) && existsSync(publicPath)) {
  console.log(`[license-keys] already exist, skip (use --force to rotate):\n  ${privatePath}\n  ${publicPath}`);
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

mkdirSync(keysDir, { recursive: true });
writeFileSync(privatePath, privatePem, { mode: 0o600 });
writeFileSync(publicPath, publicPem);
console.log(`[license-keys] generated:\n  ${privatePath}\n  ${publicPath}`);
console.log('[license-keys] NOTE: M0 test keypair. Rotate before M5 (offline custody, kid-based rotation).');

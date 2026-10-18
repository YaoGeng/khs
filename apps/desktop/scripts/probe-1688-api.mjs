#!/usr/bin/env node
/**
 * 1688 官方 API 检索探针（T-M2-05a 用户侧验收步骤）。
 *
 * 用途：拿到 1688 AI版 APP 的 AK 后，先跑本脚本验证 AK/签名/网关全链路可用，
 * 再决定在应用内「智能选品 → 官方 API 检索」里配置。脚本直接打印归一化结果与
 * 原始响应关键字段——真实响应形状与 api-client 预设有出入时，把输出原样带回。
 *
 * 用法：
 *   ALI_1688_AK=<APP 复制的原始串> node scripts/probe-1688-api.mjs [--query 收纳盒] [--channel douyin]
 *
 * 变量名 ALI_1688_AK 与官方 1688-shopkeeper skill 环境变量同名（粘贴即用）。
 */
/* global process, console, URL */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = (() => {
  const p = fileURLToPath(new URL('.', import.meta.url));
  return p.endsWith('/') || p.endsWith('\\') ? p.slice(0, -1) : p;
})();
const desktopRoot = `${scriptsDir}/..`;
const req = createRequire(join(desktopRoot, 'noop.js'));
const { extractAkKeys, searchOffers1688 } = req('@xinglian/adapters-1688');

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const raw = process.env.ALI_1688_AK;
if (!raw) {
  console.error('缺少 AK：set ALI_1688_AK=<1688 AI版 APP 复制的原始串> 后重跑');
  process.exit(1);
}
const ak = extractAkKeys(raw);
if (!ak) {
  console.error('AK 无法解析（有效长度需 ≥ 32）——请确认复制的是 APP「一键部署开店Claw」给出的完整串');
  process.exit(1);
}
console.log(`AK 解析 OK：id=${ak.accessKeyId.slice(0, 6)}…${ak.accessKeyId.slice(-4)}（长度 ${ak.accessKeyId.length}），secret=<已隐藏，长度 ${ak.accessKeySecret.length}>`);

const query = argOf('--query', '收纳盒');
const channel = argOf('--channel', '');
console.log(`检索「${query}」channel="${channel}" …`);
const startedAt = Date.now();
try {
  const items = await searchOffers1688({
    fetchImpl: globalThis.fetch,
    ak,
    query,
    channel,
    timeoutMs: 30_000,
  });
  console.log(`✅ 成功：${items.length} 条（耗时 ${Date.now() - startedAt}ms）`);
  for (const item of items.slice(0, 5)) {
    console.log(`  - [${item.offerId}] ${item.title.slice(0, 40)} | 价格 ${item.priceText} | 销量 ${item.salesText ?? '-'} | 复购 ${item.stats?.repurchaseRate ?? '-'}`);
  }
  if (items.length > 0) console.log('\n首条完整 stats（原始字段名，供评分扩展参考）:');
  if (items[0]) console.log(JSON.stringify(items[0].stats, null, 2));
} catch (error) {
  console.error(`❌ 失败（耗时 ${Date.now() - startedAt}ms）：${error.message}`);
  if (error.kind) console.error(`   分类=${error.kind} status=${error.status ?? '-'} msgCode=${error.msgCode ?? '-'}`);
  console.error('   401/auth → AK 不对或过期；429/ratelimit → 限流稍后重试；network → 本机网络/代理问题');
  process.exit(1);
}

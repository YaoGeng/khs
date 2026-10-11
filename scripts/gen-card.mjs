#!/usr/bin/env node
// M0 激活码生成脚本（todo 2 / D9 最小兑换配套）。
//
// 用法：
//   node scripts/gen-card.mjs [--count 5] [--plan month|quarter|year] [--tier personal|team] [--out-dir scripts/out]
//
// 行为：
//   1. 生成 count 个明文激活码（Crockford base32，XXXX-XXXX-XXXX-XXXX）并打印到 stdout——明文只在本次输出可见，脚本不落盘明文；
//   2. 对每个明文计算 sha256(明文码, utf8) hex 作为 codeHash；
//   3. 产出 SQL 文件（INSERT ... ON CONFLICT (code_hash) DO NOTHING）到 <out-dir>/cards-<ts>.sql。
//
// 入库方式（M0 记录在 docs/adr/notes-dev-transports.md）：根目录工具不直连 PG（根无 pg 依赖），
// 产 SQL 文件后由仓库工具执行：
//   pnpm --filter @xinglian/server exec prisma db execute --file <sql文件> --schema apps/server/prisma/schema.prisma
// 与 docker-compose（根目录）或 QA 的 embedded-postgres 均可配合。
//
// codeHash 契约：sha256(明文码)，与 apps/server/src/cards/cards.service.ts 的 hashCardCode 一致
// （两侧独立实现，T-M5-02 卡批次管理时收敛到 packages/protocol）。
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Crockford base32：无 I/L/O/U，避免人眼误读
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PLANS = ['month', 'quarter', 'year'];
const TIERS = ['personal', 'team'];

const sha256Hex = (input) => createHash('sha256').update(input, 'utf8').digest('hex');

function parseArgs(argv) {
  const args = { count: 5, plan: 'month', tier: 'personal', outDir: 'scripts/out', help: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    const consume = () => i++;
    if (key === '--help' || key === '-h') {
      args.help = true;
    } else if (key === '--count') {
      args.count = Number.parseInt(value, 10);
      consume();
    } else if (key === '--plan') {
      args.plan = value;
      consume();
    } else if (key === '--tier') {
      args.tier = value;
      consume();
    } else if (key === '--out-dir') {
      args.outDir = value;
      consume();
    }
  }
  return args;
}

function newCode() {
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    for (let c = 0; c < 4; c++) group += ALPHABET[randomInt(0, ALPHABET.length)];
    groups.push(group);
  }
  return groups.join('-');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/gen-card.mjs [--count N] [--plan month|quarter|year] [--tier personal|team] [--out-dir scripts/out]');
    return 0;
  }
  if (!Number.isInteger(args.count) || args.count < 1 || args.count > 1000) {
    console.error('--count 必须是 1..1000 的整数');
    return 1;
  }
  if (!PLANS.includes(args.plan)) {
    console.error(`--plan 必须是 ${PLANS.join('|')}`);
    return 1;
  }
  if (!TIERS.includes(args.tier)) {
    console.error(`--tier 必须是 ${TIERS.join('|')}`);
    return 1;
  }

  const codes = new Set();
  while (codes.size < args.count) codes.add(newCode());

  console.log(`# ${codes.size} 个激活码（明文，仅此一次可见；plan=${args.plan} tier=${args.tier}）`);
  for (const code of codes) console.log(code);

  const values = [...codes].map((code) => {
    const hash = sha256Hex(code);
    console.log(`${code}  ->  ${hash}`);
    return `('${randomUUID()}', '${hash}', '${args.plan}', '${args.tier}')`;
  });

  const sql = [
    '-- 由 scripts/gen-card.mjs 生成（M0）；入库幂等：重复执行不会覆盖已存在的 code_hash。',
    "INSERT INTO activation_cards (id, code_hash, plan, tier) VALUES",
    `${values.join(',\n')}`,
    'ON CONFLICT (code_hash) DO NOTHING;',
    '',
  ].join('\n');

  mkdirSync(args.outDir, { recursive: true });
  const sqlPath = path.join(args.outDir, `cards-${Date.now()}.sql`);
  writeFileSync(sqlPath, sql, 'utf8');
  console.log(`\n# SQL 文件已写出：${sqlPath}`);
  console.log('# 入库：pnpm --filter @xinglian/server exec prisma db execute --file ' + sqlPath);
  return 0;
}

process.exit(main());

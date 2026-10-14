#!/usr/bin/env node
/**
 * tm101-diff-check.mjs — 白名单校验：02-系统架构设计.md 相对基准（默认 HEAD）的 diff
 * 仅允许触碰 T-M1-01 的六处授权区（05:87 授权；书面复审依据 04:118）：
 *
 *   1. 版本头/变更记录（文件头 → §1 标题前）
 *   2. §4.2 主进程模块清单（llm-gateway 去标识化行，PC-03）
 *   3. §6.2 三大工作流 DAG（发布 DAG 三道闸节点，PC-05）
 *   4. §7.5 平台适配层（DSL v1.1 + 规范参数表，S2/S10/B-4）
 *   5. §12.1 服务划分（遥测 consent / event 枚举 / anon_user_hash，PC-02）
 *   6. §13 接口设计（telemetry/events 行，PC-02）
 *
 * 机制：授权区按节标题行号【动态定位】（不硬编码行号常量），对 base 版与工作区版
 * 各计算一遍区间；git diff --unified=0 的每个 hunk 的旧行号域与新行号域都必须
 * 完整落在单一授权区内，任一越区 → 打印越区行号与内容 → 退出码 1；否则退出码 0。
 *
 * 用法：
 *   node scripts/tm101-diff-check.mjs                 # 相对 HEAD
 *   node scripts/tm101-diff-check.mjs --base <ref>    # 相对指定基准（commit/分支）
 *   node scripts/tm101-diff-check.mjs --help
 * 无 diff（工作区与基准一致）→ 退出码 0。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DOC = 'docs/02-系统架构设计.md';

function usage() {
  console.log(`用法: node scripts/tm101-diff-check.mjs [--base <ref>] [--help]

校验 ${DOC} 相对基准的 diff 仅触 T-M1-01 六处授权区
（版本头 / §4.2 / §6.2 / §7.5 / §12.1 / §13），越区即退出码 1。

选项:
  --base <ref>  基准 ref（commit/分支/tag），默认 HEAD
  --help        显示本帮助`);
}

function die(msg, code) {
  console.error(msg);
  process.exit(code);
}

// ---- args ----
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  usage();
  process.exit(0);
}
let base = 'HEAD';
const bi = argv.indexOf('--base');
if (bi !== -1) {
  const v = argv[bi + 1];
  if (!v || v.startsWith('--')) die('错误: --base 需要一个 ref 参数（如 --base HEAD~1）', 2);
  base = v;
}

// ---- git helpers ----
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) die(`错误: 无法执行 git: ${r.error.message}`, 2);
  if (r.status !== 0) die(`错误: git ${args.join(' ')} 失败（退出码 ${r.status}）:\n${r.stderr}`, 2);
  return r.stdout;
}

const repoRoot = git(['rev-parse', '--show-toplevel']).trim();

// base 版内容（blob 原文，utf8）
const oldText = git(['show', `${base}:${DOC}`]);
// 工作区版内容
let newText;
try {
  newText = readFileSync(path.join(repoRoot, DOC), 'utf8');
} catch (e) {
  die(`错误: 无法读取工作区文件 ${DOC}: ${e.message}`, 2);
}

// ---- 授权区动态定位 ----
const headLevel = (s) => {
  const m = /^(#+) /.exec(s);
  return m ? m[1].length : 0;
};

// minLevel: 区间终止于下一个级别 ≤ minLevel 的标题（### 区不被 #### 子节打断）
const ZONE_SPECS = [
  { name: '版本头/变更记录（文件头→§1 前）', fromDocStart: true, minLevel: 2 },
  { name: '§4.2 主进程模块清单', heading: /^### 4\.2 /, minLevel: 3 },
  { name: '§6.2 三大工作流 DAG', heading: /^### 6\.2 /, minLevel: 3 },
  { name: '§7.5 平台适配层（DSL v1.1）', heading: /^### 7\.5 /, minLevel: 3 },
  { name: '§12.1 服务划分', heading: /^### 12\.1 /, minLevel: 3 },
  { name: '§13 接口设计（摘要）', heading: /^## 13\. /, minLevel: 2 },
];

/** 返回 {zones:[{name,start,end}]}（1-based 闭区间）或 {error} */
function computeZones(text) {
  const lines = text.split(/\r?\n/);
  const n = lines.length;
  const zones = [];
  for (const spec of ZONE_SPECS) {
    let start = -1;
    if (spec.fromDocStart) {
      start = 1;
    } else {
      for (let i = 0; i < n; i++) {
        if (spec.heading.test(lines[i])) { start = i + 1; break; }
      }
    }
    if (start === -1) return { error: `未在文档中定位到授权区标题: ${spec.heading}` };
    let end = n; // 默认到文件尾
    for (let i = start; i < n; i++) { // lines[i] = 1-based 第 i+1 行
      const lv = headLevel(lines[i]);
      if (lv > 0 && lv <= spec.minLevel) { end = i; break; } // 区间在 1-based 第 i 行结束
    }
    zones.push({ name: spec.name, start, end });
  }
  return { zones };
}

const oldZones = computeZones(oldText);
const newZones = computeZones(newText);
if (oldZones.error) die(`错误（base 版）: ${oldZones.error}`, 2);
if (newZones.error) die(`错误（工作区版）: ${newZones.error}`, 2);

function inAuthorized(zones, start, count) {
  if (count === 0) return true; // 该侧无行
  const last = start + count - 1;
  return zones.some((z) => start >= z.start && last <= z.end);
}

function zoneNameAt(zones, line) {
  return zones.find((z) => line >= z.start && line <= z.end)?.name ?? '（授权区外）';
}

function sliceLines(text, start, count, max = 5) {
  const lines = text.split(/\r?\n/);
  return lines
    .slice(start - 1, start - 1 + Math.min(count, max))
    .map((l) => `      | ${l.replace(/\r$/, '')}`)
    .join('\n');
}

// ---- diff 解析 ----
const diff = git(['diff', '--unified=0', base, '--', DOC]);

if (diff.trim() === '') {
  console.log(`[tm101-diff-check] ${DOC} 相对 ${base} 无 diff → 通过（退出码 0）`);
  process.exit(0);
}

const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
const violations = [];
let total = 0;
let m;
while ((m = hunkRe.exec(diff)) !== null) {
  total++;
  const oldStart = parseInt(m[1], 10);
  const oldCount = m[2] === undefined ? 1 : parseInt(m[2], 10);
  const newStart = parseInt(m[3], 10);
  const newCount = m[4] === undefined ? 1 : parseInt(m[4], 10);
  const oldOk = inAuthorized(oldZones.zones, oldStart, oldCount);
  const newOk = inAuthorized(newZones.zones, newStart, newCount);
  if (oldOk && newOk) {
    const zn = oldCount > 0 ? zoneNameAt(oldZones.zones, oldStart) : zoneNameAt(newZones.zones, newStart);
    console.log(`  [授权区内] @@ -${oldStart},${oldCount} +${newStart},${newCount} @@ → ${zn}`);
  } else {
    violations.push({ oldStart, oldCount, newStart, newCount, oldOk, newOk });
  }
}

if (violations.length > 0) {
  console.error(`\n[tm101-diff-check] 失败：${DOC} 相对 ${base} 的 diff 有 ${violations.length}/${total} 个 hunk 落在六处授权区之外（退出码 1）\n`);
  for (const v of violations) {
    console.error(`  [越区] @@ -${v.oldStart},${v.oldCount} +${v.newStart},${v.newCount} @@`);
    if (!v.oldOk && v.oldCount > 0) {
      console.error(`    旧行（base） ${v.oldStart}..${v.oldStart + v.oldCount - 1}，位于: ${zoneNameAt(oldZones.zones, v.oldStart)}`);
      console.error(sliceLines(oldText, v.oldStart, v.oldCount));
    }
    if (!v.newOk && v.newCount > 0) {
      console.error(`    新行（工作区） ${v.newStart}..${v.newStart + v.newCount - 1}，位于: ${zoneNameAt(newZones.zones, v.newStart)}`);
      console.error(sliceLines(newText, v.newStart, v.newCount));
    }
    console.error('');
  }
  console.error('授权区清单（按节标题动态定位）:');
  for (const z of newZones.zones) console.error(`  - ${z.name}: 行 ${z.start}..${z.end}`);
  process.exit(1);
}

console.log(`\n[tm101-diff-check] 通过：${total} 个 hunk 全部落在六处授权区内（相对 ${base}，退出码 0）`);
console.log('授权区清单（按节标题动态定位，工作区版行号）:');
for (const z of newZones.zones) console.log(`  - ${z.name}: 行 ${z.start}..${z.end}`);
process.exit(0);

/* gen-wordlist-checklist.mjs — 从 wordlist-seed-v1.ts 生成人工复核勾选表主体（评审后可删） */
import fs from 'node:fs';

const src = fs.readFileSync('apps/desktop/src/compliance/wordlist-seed-v1.ts', 'utf8');
const lines = src.split('\n');
let section = '';
const groups = [];
for (const line of lines) {
  const sec = line.match(/^ {4}\/\/ ---- (.+?) ----$/);
  if (sec) {
    section = sec[1];
    groups.push({ section, items: [] });
    continue;
  }
  const m = line.match(/\{ term: '(.+?)', category: '(.+?)', source: \{ doc: '(.+?)', clause: '(.+?)', line: (\d+) \}/);
  if (m && groups.length > 0) {
    groups[groups.length - 1].items.push({ term: m[1], category: m[2], doc: m[3], clause: m[4], line: m[5] });
  }
}
let md = '';
let total = 0;
for (const g of groups) {
  md += `\n### ${g.section}\n\n| # | 词条 | category | 条款出处（doc / 条款 / 行号） | 人工复核（W4 白名单） |\n| --- | --- | --- | --- | --- |\n`;
  g.items.forEach((it, i) => {
    total += 1;
    md += `| ${i + 1} | ${it.term} | ${it.category} | ${it.doc} / ${it.clause} / :${it.line} | ☐ |\n`;
  });
}
fs.writeFileSync('.omo/evidence/_wordlist-checklist-section.md', md, 'utf8');
console.log('extreme terms total =', total);

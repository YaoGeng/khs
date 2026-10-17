// 1688 页面取证 probe（T-M2-01；只读诊断，不入采集链、不碰配额账本）。
// 目的：为 adapters-1688 DSL v1 取真实选择器——搜索结果卡片 / 详情字段（价格/起批量/
// 供应商/销量/商品图）与登录墙/风控特征。匿名临时 profile（FR-3.1 不碰账密；
// 1688 与 xhs 登录态分域，后续 T-M2-04 收藏/询盘需用户本人登录后补取证）。
// 红线：不做任何风控绕过；遇登录墙/滑块如实记录退出。
// 用法：node scripts/probe-1688.mjs [关键词]（默认「防晒衣」）；JSON 落 scripts/out/probe-1688.json
/* global process, console, setTimeout */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const OUT_DIR = path.resolve(DESKTOP, '../../scripts/out');
const BUILTIN_EXE = path.join(
  process.env.LOCALAPPDATA ?? '',
  'xinglian-workbench', 'browsers', 'chromium-1710741', 'chrome-win', 'chrome.exe',
);
const KEYWORD = process.argv[2] ?? '防晒衣';
const HOME = 'https://www.1688.com';
// charset=utf8：selloffer 端点默认按 GBK 解码 keywords，纯 UTF-8 会乱码（2026-10-18 登录态实页取证）
const SEARCH_URL = `https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=`;

const require = createRequire(path.join(DESKTOP, 'package.json'));
const { chromium } = require('@playwright/test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** goto 重试（1688 对连续新建 profile 的匿名访问偶发 ERR_ABORTED；重试后仍败则抛） */
async function gotoRetry(page, url, attempts = 3) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      return;
    } catch (e) {
      console.log(`[probe1688] goto 第 ${i} 次失败: ${String(e).slice(0, 90)}`);
      if (i === attempts) throw e;
      await sleep(4_000);
    }
  }
}
async function waitForDevToolsPort(profileDir, timeoutMs = 20_000) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file)) {
      const raw = await readFile(file, 'utf8');
      const [port, wsPath] = raw.trim().split('\n');
      if (port) return { port: Number(port), wsPath };
    }
    if (Date.now() > deadline) throw new Error('DevToolsActivePort 未出现（浏览器启动失败？）');
    await sleep(300);
  }
}

/** 通用候选选择器命中计数（全部只读；卡片/字段/墙三类一起数） */
const DIAG_SOURCE = `(function () {
  var sels = [
    // 搜索框（首页）
    'input[name="keywords"]', '.search-text input', '#cxb-search-input', 'input.s-search-input',
    // 结果卡片候选（1688 历史形态：sm-offer-item / offer-item / 后代 a 标签）
    '.sm-offer-item', '[class*="offer-item"]', '[class*="OfferItem"]', '[data-spm-anchor-id] a[href*="detail.1688.com"]',
    'a[href*="detail.1688.com/offer"]', '[class*="card"] a[href*="detail.1688.com"]',
    // 详情字段候选
    '[class*="price"]', '[class*="Price"]', '[class*="minOrder"]', '[class*="month-sales"]', '[class*="sales"]',
    '[class*="company-name"]', '[class*="supplier"]', '[class*="address"]', '[class*="title"]',
    // 图集
    '[class*="gallery"] img', '[class*="thumb"] img', '.detail-gallery img',
    // 墙/风控特征
    '.login-panel', '[class*="login-dialog"]', 'iframe[src*="login"]', '#nc_1_wrapper', '.nc-container', '[class*="punish"]', '#captcha',
    'text=请登录', 'text=验证'
  ];
  var counts = {};
  for (var i = 0; i < sels.length; i += 1) {
    try { counts[sels[i]] = document.querySelectorAll(sels[i]).length; } catch (e) { counts[sels[i]] = -1; }
  }
  // 前 12 个 offer 锚点的结构上下文（父/祖链类名 + 锚文本）：区分真实结果卡与广告位，
  // 并以重复出现次数最高的父层类名定位卡片容器（一轮取证：爬 6 层只到全页容器，粒度不够）
  var cardSamples = [];
  var anchors = document.querySelectorAll('a[href*="detail.1688.com/offer"]');
  var clsFreq = {};
  for (var j = 0; j < Math.min(12, anchors.length); j += 1) {
    var a = anchors[j];
    var p1 = a.parentElement;
    var p2 = p1 ? p1.parentElement : null;
    var p3 = p2 ? p2.parentElement : null;
    for (var c of [p1, p2, p3]) {
      var cn = c ? (c.className || '').toString().trim() : '';
      if (cn) clsFreq[cn] = (clsFreq[cn] || 0) + 1;
    }
    cardSamples.push({
      offerId: (/(?:offer\\/)(\\d+)/.exec(a.href || '') || [])[1] ?? '',
      anchorCls: (a.className || '').toString().slice(0, 60),
      parentCls: p1 ? (p1.className || '').toString().slice(0, 80) : '',
      grandCls: p2 ? (p2.className || '').toString().slice(0, 80) : '',
      text: (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100)
    });
  }
  var topCards = Object.entries(clsFreq).filter(([cls, n]) => n >= 5).sort((x, y) => y[1] - x[1]).slice(0, 6);
  return {
    url: location.href,
    title: (document.title || '').slice(0, 120),
    counts: counts,
    cardSamples: cardSamples,
    topCards: topCards,
    bodySnippet: (document.body ? document.body.textContent : '').replace(/\\s+/g, ' ').slice(0, 500)
  };
})()`;

async function main() {
  if (!existsSync(BUILTIN_EXE)) {
    console.error(`[probe1688] 内置 Chromium 不存在: ${BUILTIN_EXE}`);
    process.exit(1);
  }
  await mkdir(OUT_DIR, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'khs-probe-1688-'));
  const child = spawn(BUILTIN_EXE, [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: false });

  try {
    const { port } = await waitForDevToolsPort(profile);
    console.log(`[probe1688] chromium pid=${child.pid} cdp=127.0.0.1:${port}`);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());

    // 1) 首页（搜索框取证）
    await gotoRetry(page, HOME);
    await page.waitForTimeout(5_000);
    const home = await page.evaluate(DIAG_SOURCE);
    console.log('[probe1688] 首页:', home.url, '|', home.title);

    // 2) 搜索结果页（canonical URL 直达；首页输入框形态另存诊断）
    await gotoRetry(page, `${SEARCH_URL}${encodeURIComponent(KEYWORD)}`);
    await page.waitForTimeout(6_000);
    const search = await page.evaluate(DIAG_SOURCE);
    console.log('[probe1688] 搜索:', search.url.slice(0, 90), '|', search.title);
    console.log('[probe1688] offer 锚点命中:', search.counts['a[href*="detail.1688.com/offer"]'] ?? 0);

    // 3) 首个商品详情（字段取证）——用 cardSamples 里的 offerId 拼规范 URL
    let detail = null;
    const firstOffer = (search.cardSamples.find((c) => c.offerId)?.offerId) ?? null;
    if (firstOffer) {
      const detailUrl = `https://detail.1688.com/offer/${firstOffer}.html`;
      await gotoRetry(page, detailUrl);
      await page.waitForTimeout(6_000);
      detail = await page.evaluate(DIAG_SOURCE);
      console.log('[probe1688] 详情:', detail.url.slice(0, 90), '|', detail.title);
    } else {
      console.log('[probe1688] 未取得 offer 锚点（可能登录墙/风控），详情跳过');
    }

    const report = { stage: detail ? 'detail' : 'search', keyword: KEYWORD, home, search, detail };
    await writeFile(path.join(OUT_DIR, 'probe-1688.json'), JSON.stringify(report, null, 2));
    for (const [label, diag] of [['home', home], ['search', search], ['detail', detail]]) {
      if (!diag) continue;
      console.log(`[probe1688] === ${label} 非零命中 ===`);
      for (const [sel, n] of Object.entries(diag.counts)) if (n !== 0) console.log(`  ${n >= 0 ? '✓' : '✗'} ${sel} = ${n}`);
    }
    console.log('[probe1688] === 搜索页高频卡片容器 ===');
    for (const [cls, n] of (search.topCards ?? [])) console.log(`  ×${n} ${cls.slice(0, 78)}`);
    console.log('[probe1688] === 前 6 锚点文本 ===');
    for (const c of (search.cardSamples ?? []).slice(0, 6)) console.log(`  ${c.offerId.slice(0, 14)} | ${c.text.slice(0, 66)}`);
    console.log('[probe1688] 完整报告: scripts/out/probe-1688.json');
    await sleep(3_000);
    await browser.close();
  } finally {
    if (!child.killed) { try { child.kill(); } catch { /* 忽略 */ } }
    await sleep(1_500);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => { console.error('[probe1688] 失败:', e); process.exit(1); });

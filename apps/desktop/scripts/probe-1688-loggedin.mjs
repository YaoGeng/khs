// 1688 登录态取证 probe（T-M2-04 前置校准；只读诊断，绝不点击收藏/询盘等写操作）。
//
// 目的：为 T-M2-04 校准三类位点——
//   ① 搜索结果卡内 offerTitle/price/sales/supplier/address 锚点（2026-10-18 验收：
//      card.textContent 整卡噪声、sales/supplier 全 null）；
//   ② 详情页字段（图集/文案描述/起批量）；
//   ③ favorite/inquiry 写操作位点 DOM 结构（只看不点；真实点击联调须用户在场）。
//
// 运行形态：主应用/受控浏览器在跑时 profile 被锁（pipe 传输无 TCP 口）→ 复制 profile
// 到临时目录独立起浏览器（排除缓存目录；Cookies 在 Default/Network/ 必须带上）。
// 登录态校验：selloffer 结果页 body 含关键词（匿名=推荐流，body 关键词 0 次，T-M2-01
// 取证）+ 无登录墙特征。副本登录态损坏则如实报告退出，不硬跑。
//
// 用法：node scripts/probe-1688-loggedin.mjs [--live] [关键词]（默认「防晒帽」）
//   默认 = 复制 profile 路线（应用在跑时安全；实测 Cookies 被活体锁独占 → 副本无登录态，
//   会走 login-check-failed 如实退出）；--live = 直接用真 profile（须先退出应用与受控
//   浏览器释放 profile 锁，起前删陈旧 DevToolsActivePort，见记忆坑 5）。
// 报告：scripts/out/probe-1688-loggedin.json
/* global process, console, setTimeout */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const OUT_DIR = path.resolve(DESKTOP, '../../scripts/out');
const BUILTIN_EXE = path.join(
  process.env.LOCALAPPDATA ?? '',
  'xinglian-workbench', 'browsers', 'chromium-1710741', 'chrome-win', 'chrome.exe',
);
const LIVE_PROFILE = path.join(
  process.env.LOCALAPPDATA ?? '',
  'xinglian-workbench', 'cdp-profiles', '1688',
);
const KEYWORD = process.argv.filter((a) => !a.startsWith('--'))[2] ?? '防晒帽';
const LIVE_MODE = process.argv.includes('--live');
const SEARCH_URL = `https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=${encodeURIComponent(KEYWORD)}`;

const require = createRequire(path.join(DESKTOP, 'package.json'));
const { chromium } = require('@playwright/test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function robocopy(src, dest) {
  return new Promise((resolve) => {
    // /E 含子目录；/XD 排除缓存（~950M）；/NFL /NDL 静音；退出码 <8 = 成功（robocopy 语义）
    execFile('robocopy', [
      src, dest, '/E', '/NFL', '/NDL', '/NJH', '/R:1', '/W:1',
      '/XD', 'Cache', 'Code Cache', 'GPUCache', 'component_crx_cache',
      'SODALanguagePacks', 'SODA', 'WasmTtsEngine', 'DawnWebGPUCache', 'DawnGraphiteCache',
      'GrShaderCache', 'ShaderCache', 'Crashpad', 'BrowserMetrics-spare.pma',
    ], { windowsHide: true }, (code) => resolve(code));
  });
}

async function waitDevToolsPort(profileDir, timeoutMs = 20_000) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file)) {
      const raw = await readFile(file, 'utf8');
      const [port] = raw.trim().split('\n');
      if (port) return Number(port);
    }
    if (Date.now() > deadline) throw new Error('DevToolsActivePort 未出现（副本浏览器启动失败）');
    await sleep(300);
  }
}

async function gotoRetry(page, url, attempts = 3) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      return;
    } catch (e) {
      console.log(`[probe1688li] goto 第 ${i} 次失败: ${String(e).slice(0, 90)}`);
      if (i === attempts) throw e;
      await sleep(4_000);
    }
  }
}

/** 卡片深度取证：单卡 = a.offerCard 锚自身（2026-10-18 登录态取证：CSS Modules 哈希类，
 * 卡容器类名 offerCard--xxxx；列表容器 offerList--xxxx 会爬过头）→ 全量结构 + 元素清单 */
const CARD_SOURCE = `(function () {
  var anchors = document.querySelectorAll('a[href*="detail.1688.com/offer"]');
  var seen = {};
  var cards = [];
  for (var i = 0; i < anchors.length && cards.length < 3; i += 1) {
    var a = anchors[i];
    var m = /offer\\/(\\d+)/.exec(a.getAttribute('href') || '');
    if (!m || seen[m[1]]) continue;
    seen[m[1]] = 1;
    var card = a.closest('[class*="offerCard"]') || a;
    var inner = [];
    var walker = card.querySelectorAll('*');
    for (var j = 0; j < walker.length && inner.length < 80; j += 1) {
      var el = walker[j];
      var own = Array.prototype.slice.call(el.childNodes)
        .filter(function (n) { return n.nodeType === 3; })
        .map(function (n) { return n.textContent; }).join(' ')
        .replace(/\\s+/g, ' ').trim();
      if (!own) continue;
      inner.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 90),
        text: own.slice(0, 90)
      });
    }
    cards.push({
      offerId: m[1],
      containerCls: (card.className || '').toString().slice(0, 100),
      containerTag: card.tagName.toLowerCase(),
      html: card.outerHTML.replace(/\\s+/g, ' ').slice(0, 20000),
      inner: inner
    });
  }
  return cards;
})()`;

/** 详情页写操作位点取证（只读）：data-click 动作全量枚举 + 联系类文案反查 + 字段锚 */
const ACTION_SOURCE = `(function () {
  var words = ['收藏', '关注', '询盘', '和我联系', '联系', '旺旺', '会话', '客服', '留言', '聊天'];
  var hits = [];
  var els = document.querySelectorAll('a, button, [role="button"], [data-click], [class*="btn"], [class*="button"], [class*="Button"]');
  for (var i = 0; i < els.length && hits.length < 40; i += 1) {
    var t = (els[i].textContent || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 30) continue;
    for (var w = 0; w < words.length; w += 1) {
      if (t.indexOf(words[w]) >= 0) {
        hits.push({
          word: words[w],
          tag: els[i].tagName.toLowerCase(),
          cls: (els[i].className || '').toString().slice(0, 100),
          dataClick: els[i].getAttribute('data-click') || '',
          text: t.slice(0, 30),
          html: els[i].outerHTML.replace(/\\s+/g, ' ').slice(0, 260)
        });
        break;
      }
    }
  }
  // data-click 动作词汇全量枚举（FAV/ORDER/follow-shop…已见；找会话/询盘类动作）
  var clickActions = {};
  var clickEls = document.querySelectorAll('[data-click]');
  for (var c = 0; c < clickEls.length; c += 1) {
    var action = clickEls[c].getAttribute('data-click') || '';
    if (!action) continue;
    if (!clickActions[action]) clickActions[action] = { count: 0, sample: '' };
    clickActions[action].count += 1;
    if (!clickActions[action].sample) {
      clickActions[action].sample = ((clickEls[c].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24)) + ' <' + clickEls[c].tagName.toLowerCase() + ' ' + ((clickEls[c].className || '') + '').slice(0, 60) + '>';
    }
  }
  // 详情字段锚候选
  var fieldSels = {
    h1: 'h1', h1_cls: 'h1[class]', subject: '[class*="subject"]', Title: '[class*="Title"]',
    price_all: '[class*="price"]', priceTiers: '[class*="PriceItem"]', sales: '[class*="sales"]', sales2: '[class*="Sales"]',
    company: '.company-name', shop: '[class*="shop"]', address: '[class*="address"]', Address: '[class*="Address"]',
    moq_text: '[class*="batch"]', moq_ladder: '[class*="ladder"]', moq_price: '[class*="ladderPrice"]',
    gallery_img: '[class*="gallery"] img', desc_area: '[class*="detail-desc"]', desc_content: '[class*="content"] img'
  };
  var counts = {};
  for (var k in fieldSels) {
    try { counts[k] = document.querySelectorAll(fieldSels[k]).length; } catch (e) { counts[k] = -1; }
  }
  // h1 全量（详情页有多 h1：首个=公司名，需定位商品标题 h1 的父链）+ 主信息区取样
  var h1s = [];
  var h1Els = document.querySelectorAll('h1');
  for (var hi = 0; hi < h1Els.length && h1s.length < 8; hi += 1) {
    var p = h1Els[hi].parentElement;
    h1s.push({
      text: (h1Els[hi].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50),
      selfCls: (h1Els[hi].className || '').toString().slice(0, 60),
      parentCls: p ? (p.className || '').toString().slice(0, 60) : '',
      grandCls: p && p.parentElement ? (p.parentElement.className || '').toString().slice(0, 60) : ''
    });
  }
  var sample = {};
  sample.h1s = h1s;
  var imgs = [];
  var g = document.querySelectorAll('[class*="gallery"] img');
  for (var n = 0; n < g.length && imgs.length < 10; n += 1) {
    var src = g[n].src || '';
    if (/\\.(jpg|jpeg|png|webp)/.test(src) && src.indexOf('tps-1') < 0) imgs.push(src.slice(0, 140));
  }
  return { hits: hits, clickActions: clickActions, counts: counts, sample: sample, gallerySrcs: imgs };
})()`;

/** 页面级选择器命中计数（字段候选 + 写操作候选 + 墙特征，全只读） */
const COUNT_SOURCE = `(function () {
  var sels = {
    title_h1: 'h1', title_meta: '[class*="title"]',
    price: '[class*="price"]', price_big: '[class*="Price"]',
    sales: '[class*="sales"]', sales_month: '[class*="month-sales"]', sales_count: '[class*="sale-count"]', sales_count2: '[class*="salesCount"]',
    company: '.company-name', company2: '[class*="company"]', supplier: '[class*="supplier"]',
    address: '[class*="address"]', moq: '[class*="moq"]', moq2: '[class*="range"]',
    gallery: '[class*="gallery"] img', thumb: '[class*="thumb"] img', main_img: '[class*="main-image"] img',
    fav_btn: '[class*="favor"]', fav_btn2: '[class*="collect"]', fav_btn3: '[class*="Favor"]',
    fav_done: '[class*="favor-done"]', fav_done2: '[class*="collected"]',
    inquiry: '[class*="inquiry"]', ww: '[class*="wangwang"]', chat: '[class*="chat"]', contact: '[class*="contact"]',
    login_panel: '.login-panel', login_dialog: '[class*="login-dialog"]', login_iframe: 'iframe[src*="login"]',
    captcha: '#nc_1_wrapper, .nc-container, [class*="punish"], #captcha'
  };
  var counts = {};
  for (var k in sels) {
    try { counts[k] = document.querySelectorAll(sels[k]).length; } catch (e) { counts[k] = -1; }
  }
  return {
    url: location.href.slice(0, 140),
    title: (document.title || '').slice(0, 140),
    keywordInBody: (document.body.textContent || '').split(KEYWORD_TOKEN).length - 1,
    counts: counts
  };
})()`.replace('KEYWORD_TOKEN', JSON.stringify(KEYWORD));

async function main() {
  if (!existsSync(BUILTIN_EXE)) {
    console.error(`[probe1688li] 内置 Chromium 不存在: ${BUILTIN_EXE}`);
    process.exit(1);
  }
  if (!existsSync(LIVE_PROFILE)) {
    console.error(`[probe1688li] 登录态 profile 不存在: ${LIVE_PROFILE}`);
    process.exit(1);
  }
  await mkdir(OUT_DIR, { recursive: true });
  let copy;
  if (LIVE_MODE) {
    copy = LIVE_PROFILE;
    // 陈旧端口文件必删（记忆坑 5：残留 DevToolsActivePort 会让端口探测读到死端口）
    await rm(path.join(copy, 'DevToolsActivePort'), { force: true }).catch(() => {});
    console.log('[probe1688li] --live：直接使用真实 profile（须已退出应用释放 profile 锁）');
  } else {
    copy = path.join(tmpdir(), `khs-probe1688-copy-${Date.now()}`);
    console.log(`[probe1688li] 复制 profile（排除缓存）…`);
    const rc = await robocopy(LIVE_PROFILE, copy);
    if (rc >= 8) {
      console.error(`[probe1688li] robocopy 失败 exit=${rc}`);
      process.exit(1);
    }
    // 陈旧端口文件（记忆：复用 profile 的 DevToolsActivePort 残留坑——副本同样适用）
    await rm(path.join(copy, 'DevToolsActivePort'), { force: true }).catch(() => {});
    await rm(path.join(copy, 'Default', 'DevToolsActivePort'), { force: true }).catch(() => {});
    // 原浏览器活着，锁文件/日志副本一律清掉防误判
    await rm(path.join(copy, 'Default', 'LOCK'), { force: true }).catch(() => {});
  }

  const child = spawn(BUILTIN_EXE, [
    '--remote-debugging-port=0',
    `--user-data-dir=${copy}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: false });
  console.log(`[probe1688li] chromium pid=${child.pid}`);

  try {
    const port = await waitDevToolsPort(copy);
    console.log(`[probe1688li] cdp=127.0.0.1:${port} 关键词=${KEYWORD}`);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());

    // 1) 搜索结果页（登录态判定 + 卡片深度取证）
    await gotoRetry(page, SEARCH_URL);
    await page.waitForTimeout(6_000);
    const search = await page.evaluate(COUNT_SOURCE);
    const searchCards = await page.evaluate(CARD_SOURCE);
    console.log(`[probe1688li] 搜索: ${search.title} | body 含关键词 ${search.keywordInBody} 次 | 卡片 ${searchCards.length} 张`);
    const loggedIn = search.keywordInBody >= 3 && search.counts.login_panel === 0 && search.counts.login_iframe === 0;
    if (!loggedIn) {
      const report = { stage: 'login-check-failed', keyword: KEYWORD, search, searchCards: [] };
      await writeFile(path.join(OUT_DIR, 'probe-1688-loggedin.json'), JSON.stringify(report, null, 2));
      console.error('[probe1688li] 副本登录态校验未过（body 关键词少/登录墙在场）——如实退出，不硬跑。报告已落盘。');
      await browser.close().catch(() => {});
      return;
    }

    // 2) 首个商品详情（字段 + 写操作位点结构取证；只读不点击）
    let detail = null;
    let action = null;
    const firstOffer = searchCards.find((c) => c.offerId)?.offerId ?? null;
    if (firstOffer) {
      await gotoRetry(page, `https://detail.1688.com/offer/${firstOffer}.html`);
      await page.waitForTimeout(6_000);
      detail = await page.evaluate(COUNT_SOURCE);
      action = await page.evaluate(ACTION_SOURCE);
      console.log(`[probe1688li] 详情: ${detail.title}`);
      console.log(`[probe1688li] 写操作文案命中 ${action.hits.length} 处、类名候选: ${JSON.stringify(action.counts)}`);
    }

    const report = { stage: detail ? 'detail' : 'search', keyword: KEYWORD, loggedIn: true, search, searchCards, detail, action };
    await writeFile(path.join(OUT_DIR, 'probe-1688-loggedin.json'), JSON.stringify(report, null, 2));
    console.log('[probe1688li] === 搜索页字段候选命中 ===');
    for (const [k, v] of Object.entries(search.counts)) if (v !== 0) console.log(`  ${k} = ${v}`);
    if (detail) {
      console.log('[probe1688li] === 详情页候选命中 ===');
      for (const [k, v] of Object.entries(detail.counts)) if (v !== 0) console.log(`  ${k} = ${v}`);
    }
    console.log(`[probe1688li] 完整报告: scripts/out/probe-1688-loggedin.json`);
    if (action) {
      console.log('[probe1688li] === 详情页 data-click 动作词汇 ===');
      for (const [name, info] of Object.entries(action.clickActions)) console.log(`  ${name} ×${info.count} | ${info.sample}`);
      console.log('[probe1688li] === 详情页字段取样 ===');
      console.log(' ', JSON.stringify(action.sample, null, 1).slice(0, 1800));
      console.log('[probe1688li] === 详情页联系类文案命中 ===');
      for (const h of action.hits.slice(0, 24)) console.log(`  [${h.word}] <${h.tag} data-click=${h.dataClick || '-'}> ${h.cls.slice(0, 44)} | ${h.text}`);
    }
    await sleep(2_000);
    await browser.close().catch(() => {});
  } finally {
    if (!child.killed) { try { child.kill(); } catch { /* 忽略 */ } }
    await sleep(1_500);
    // live 模式 copy=LIVE_PROFILE，绝不能删真实 profile
    if (!LIVE_MODE) await rm(copy, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => { console.error('[probe1688li] 失败:', e); process.exit(1); });

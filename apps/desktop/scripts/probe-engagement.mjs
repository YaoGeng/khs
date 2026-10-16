// 互动数选择器取证 probe（只读诊断；不入采集任务、不烧配额账本）。
// 背景：133/133 笔记赞/藏/评为 0、图片 133/133 为空 —— readDetailSource 的
// `.engage-bar .like/.collect/.chat .count` 与 og:image `meta[name=]` 疑似双漂移。
// 方法：用内置 Chromium + 全新临时 profile 匿名打开一篇真实笔记详情，dump 互动区
// 真实 DOM 类名 / og:image 属性形态 / 新旧选择器链命中对照，落 JSON 到 scripts/out/。
// 用法：node scripts/probe-engagement.mjs [关键词]（默认「防晒衣推荐」）
// 红线对齐：FR-3.1 不触碰账密；端口只绑 127.0.0.1；退出即关浏览器。
/* global process, console, setTimeout, URL */
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
const KEYWORD = process.argv[2] ?? '防晒衣推荐';
const HOME = 'https://www.xiaohongshu.com';
// KHS_PROBE_PROFILE=<dir>：复用真实登录态 profile 跑「登录态搜索详情」取证
// （须先退出应用释放 profile 锁）；默认一次性临时 profile 走匿名路径。
const PROFILE_OVERRIDE = process.env.KHS_PROBE_PROFILE ?? '';
// KHS_PROBE_HIDDEN=1：窗口掷到离屏（-32000）复现「后台/被遮挡 tab」条件——验证
// 页面 visibility=hidden 时 Chrome 节流定时器是否把 React hydration 拖过补轮窗
// （应用内 19/20 互动数 0 而 probe 前台窗 2.5s 即挂载的根因假设）。
const HIDDEN = process.env.KHS_PROBE_HIDDEN === '1';
// 定点取证模式：KHS_PROBE_NOTE_ID=<id>（搜索词走 argv[2]）——按标题搜索、
// 在结果锚点里按笔记 id 定位（拿带 xsec_token 的 href；裸 /explore/<id> 会触 300031），
// 前台窗读真实互动数。用于归因「应用内零互动」笔记（真实 0 / 视频笔记 / 间歇漏挂载）。
const NOTE_ID_TARGET = process.env.KHS_PROBE_NOTE_ID ?? '';

const require = createRequire(path.join(DESKTOP, 'package.json'));
const { chromium } = require('@playwright/test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 页面内执行的多选择器命中计数 + 样本抓取（全部只读）。 */
const DIAG_SOURCE = `(function () {
  var sels = [
    '#detail-title', '#detail-desc', '.author-container .username', '.date', 'a.tag',
    '.engage-bar', '.engage-bar .like .count', '.engage-bar .like-wrapper', '.engage-bar .like-wrapper .count',
    '.engage-bar .collect-wrapper', '.engage-bar .collect-wrapper .count',
    '.engage-bar .chat-wrapper', '.engage-bar .chat-wrapper .count',
    '.interact-container', '.like-wrapper .count', '.collect-wrapper .count', '.chat-wrapper .count',
    '.like-wrapper', '.collect-wrapper', '.chat-wrapper',
    '[class*="engage"]', '[class*="interact"]',
    'meta[property="og:image"]', 'meta[name="og:image"]', 'meta[property="og:title"]',
    '.note-content img', '.media-container img', '.swiper-slide img', 'img.note-slider-img',
    '[class*="swiper"] img', '[class*="slider"] img', '[class*="carousel"] img',
    '.img-container img', '.image-container img', '.note-detail img', 'div[class*="media"] img'
  ];
  var counts = {};
  for (var i = 0; i < sels.length; i++) {
    try { counts[sels[i]] = document.querySelectorAll(sels[i]).length; } catch (e) { counts[sels[i]] = -1; }
  }
  var interactEl = document.querySelector('.engage-bar') || document.querySelector('[class*="interact"]') || document.querySelector('.note-content');
  var countText = function (el) { return el ? (el.textContent || '').trim() : null; };
  var imgSamples = Array.prototype.slice.call(document.querySelectorAll('img')).slice(0, 14).map(function (img) {
    return {
      src: (img.currentSrc || img.src || '').slice(0, 120),
      cls: (img.className || '').slice(0, 70),
      w: img.naturalWidth,
      parentCls: (img.parentElement && img.parentElement.className || '').slice(0, 70)
    };
  });
  return {
    url: location.href,
    title: countText(document.querySelector('#detail-title')),
    counts: counts,
    interactHTML: interactEl ? interactEl.outerHTML.slice(0, 2500) : null,
    chatWrapperHTML: (function () {
      var el = document.querySelector('.engage-bar .chat-wrapper') || document.querySelector('.chat-wrapper');
      return el ? el.outerHTML.slice(0, 600) : null;
    })(),
    ogImageProperty: (document.querySelector('meta[property="og:image"]') || {}).content || null,
    ogImageName: (document.querySelector('meta[name="og:image"]') || {}).content || null,
    imgSamples: imgSamples
  };
})()`;

async function main() {
  if (!existsSync(BUILTIN_EXE)) {
    console.error(`[probe] 内置 Chromium 不存在: ${BUILTIN_EXE}`);
    process.exit(1);
  }
  await mkdir(OUT_DIR, { recursive: true });
  const profile = PROFILE_OVERRIDE || (await mkdtemp(path.join(tmpdir(), 'khs-probe-eng-')));
  const keepProfile = Boolean(PROFILE_OVERRIDE);
  // 复用 profile 时上次的 DevToolsActivePort 可能残留（陈旧端口），先删再等新文件
  if (keepProfile) await rm(path.join(profile, 'DevToolsActivePort'), { force: true }).catch(() => {});
  const child = spawn(BUILTIN_EXE, [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,900',
    ...(HIDDEN ? ['--window-position=-32000,-32000'] : []),
    'about:blank',
  ], { stdio: 'ignore', windowsHide: false });

  try {
    const { port } = await waitForDevToolsPort(profile);
    console.log(`[probe] chromium pid=${child.pid} cdp=127.0.0.1:${port}`);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(4_000);
    const home = await page.evaluate(DIAG_SOURCE);
    console.log('[probe] 首页 URL:', home.url);

    await page.goto(`${HOME}/search_result?keyword=${encodeURIComponent(KEYWORD)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // 等搜索结果出现（匿名可能被墙：登录弹窗/空结果）
    let firstHref = null;
    try {
      await page.waitForSelector('a[href*="xsec_token"]', { timeout: 15_000 });
      firstHref = await page.$eval('a[href*="xsec_token"]', (a) => a.href);
    } catch { /* 落到诊断输出 */ }
    // 定点模式：在全部结果锚点里按 id 找目标（覆盖 first-result-only 的盲区）
    if (NOTE_ID_TARGET) {
      const allHrefs = await page.evaluate(`(function () {
        var links = document.querySelectorAll('a[href*="xsec_token"]');
        var out = [];
        for (var i = 0; i < links.length; i += 1) {
          var href = links[i].getAttribute('href') || '';
          var m = /(?:\\/explore\\/|\\/search_result\\/|note=)([0-9a-fA-F]{16,32})/.exec(href);
          if (m) out.push({ id: m[1], href: href });
        }
        return out;
      })()`);
      const hit = allHrefs.find((l) => l.id === NOTE_ID_TARGET);
      console.log(`[probe] 定点查找 ${NOTE_ID_TARGET.slice(0, 10)}：结果锚点 ${allHrefs.length} 个，${hit ? '命中' : '未在结果页（换 KHS_PROBE_TITLE 搜索词）'}`);
      if (hit) firstHref = new URL(hit.href, HOME).toString();
    }
    console.log('[probe] 首条结果:', firstHref ?? '未取到（可能登录墙/风控）', '当前 URL:', page.url());
    if (!firstHref) {
      const diag = await page.evaluate(DIAG_SOURCE);
      await writeFile(path.join(OUT_DIR, 'probe-engagement.json'), JSON.stringify({ stage: 'search-blocked', home, search: diag }, null, 2));
      console.log('[probe] 搜索不可达，诊断已落盘（含页面类名样本），浏览器保留 90s 供人工查看');
      await sleep(90_000);
      return;
    }

    await page.goto(firstHref, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try {
      await page.waitForSelector('#detail-title, .note-content', { timeout: 15_000 });
    } catch { /* 照常 dump */ }

    // 挂载时间线（500ms × 20 = 10s）：标题出现后每采样点记录 visibility + 互动计数，
    // 定位 hydration 在可见/离屏窗口下的挂载时刻（run-c 19/20 零值根因取证）
    const mountTimeline = [];
    for (let i = 0; i < 20; i += 1) {
      const sample = await page.evaluate(`(function () {
        var count = function (sel) {
          var el = document.querySelector(sel);
          if (!el) return 0;
          var m = /[\\d.]+\\s*(万|w|k)?/i.exec((el.textContent || '').trim());
          if (!m) return 0;
          var u = (m[2] || '').toLowerCase();
          return Math.round(parseFloat(m[1]) * (u === '万' || u === 'w' ? 10000 : u === 'k' ? 1000 : 1));
        };
        return {
          vis: document.visibilityState,
          title: Boolean(document.querySelector('#detail-title')),
          video: document.querySelectorAll('video').length,
          likes: count('.engage-bar .like-wrapper .count'),
          collects: count('.engage-bar .collect-wrapper .count'),
          comments: count('.engage-bar .chat-wrapper .count'),
          webpics: Array.prototype.filter.call(document.querySelectorAll('img'), function (img) {
            return (img.currentSrc || img.src || '').indexOf('sns-webpic') >= 0;
          }).length
        };
      })()`);
      mountTimeline.push({ t: i * 0.5, ...sample });
      await page.waitForTimeout(500);
    }
    const firstMount = mountTimeline.find((s) => s.likes + s.collects + s.comments > 0) ?? null;
    console.log(`[probe] 窗口模式=${HIDDEN ? '离屏(hidden)' : '前台(visible)'} visibility=${mountTimeline[0]?.vis} video元素=${mountTimeline[0]?.video ?? 0}`);
    console.log(`[probe] 互动计数首次挂载: ${firstMount ? `t=+${firstMount.t}s (${firstMount.likes}/${firstMount.collects}/${firstMount.comments})` : '10s 内未挂载'}`);
    console.log(`[probe] webpic 图片数（首/末采样）: ${mountTimeline[0]?.webpics ?? 0}/${mountTimeline[mountTimeline.length - 1]?.webpics ?? 0}`);
    await page.waitForTimeout(2_500);
    const diag = await page.evaluate(DIAG_SOURCE);

    // 新旧选择器链试提取对照（与 readDetailSource 同款量级解析）
    const trial = await page.evaluate(`(function () {
      var count = function (sel) {
        var el = document.querySelector(sel);
        if (!el) return 0;
        var m = /[\\d.]+\\s*(万|w|k)?/i.exec((el.textContent || '').trim());
        if (!m) return 0;
        var u = (m[2] || '').toLowerCase();
        return Math.round(parseFloat(m[1]) * (u === '万' || u === 'w' ? 10000 : u === 'k' ? 1000 : 1));
      };
      var srcs = function (sel) {
        return Array.prototype.slice.call(document.querySelectorAll(sel)).map(function (img) {
          return (img.currentSrc || img.src || '').slice(0, 110);
        }).filter(Boolean).slice(0, 6);
      };
      return {
        legacy: { likes: count('.engage-bar .like .count'), collects: count('.engage-bar .collect .count'), comments: count('.engage-bar .chat .count') },
        modern: { likes: count('.like-wrapper .count'), collects: count('.collect-wrapper .count'), comments: count('.chat-wrapper .count') },
        scoped: { likes: count('.engage-bar .like-wrapper .count'), collects: count('.engage-bar .collect-wrapper .count'), comments: count('.engage-bar .chat-wrapper .count') },
        coverTrials: {
          mediaContainer: srcs('.media-container img'),
          swiperSlide: srcs('.swiper-slide img'),
          noteSliderImg: srcs('img.note-slider-img'),
          noteContentImg: srcs('.note-content img')
        }
      };
    })()`);

    const report = { stage: 'detail', keyword: KEYWORD, hidden: HIDDEN, mountTimeline, diag, trial };
    await writeFile(path.join(OUT_DIR, 'probe-engagement.json'), JSON.stringify(report, null, 2));
    console.log('[probe] === 选择器命中计数 ===');
    for (const [sel, n] of Object.entries(diag.counts)) if (n !== 0) console.log(`  ${n >= 0 ? '✓' : '✗'} ${sel} = ${n}`);
    console.log('[probe] 旧链提取:', JSON.stringify(trial.legacy), ' 新链提取:', JSON.stringify(trial.modern));
    console.log('[probe] og:image property:', diag.ogImageProperty?.slice(0, 80), ' name:', diag.ogImageName?.slice(0, 80));
    console.log('[probe] 完整报告: scripts/out/probe-engagement.json');
    await sleep(5_000);
    await browser.close();
  } finally {
    if (!child.killed) { try { child.kill(); } catch { /* 忽略 */ } }
    await sleep(1_500);
    if (!keepProfile) await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => { console.error('[probe] 失败:', e); process.exit(1); });

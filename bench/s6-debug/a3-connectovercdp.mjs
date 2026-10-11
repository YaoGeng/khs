// S6 a3: Playwright chromium.connectOverCDP against a port-mode browser (route B
// integration shape). Also documents the pipe-mode counterpart: a pipe-launched browser
// has NO http/ws endpoint (no DevToolsActivePort file, no TCP listener) => connectOverCDP
// is inapplicable there; the launcher itself owns the full Playwright API instead.
//
// Usage: node a3-connectovercdp.mjs [--repeat N] [--headless]
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskKillTree, median } from './lib/util.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const repeat = Number(arg('--repeat', '2'));
const headless = has('--headless');
const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const { chromium } = await import('playwright-core');

const results = [];
for (let i = 1; i <= repeat; i++) {
  const profile = join(mkdtempSync(join(tmpdir(), 's6-a3-')), 'profile');
  const t0 = performance.now();
  const child = spawn(exe, [
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 15000;
  while (!existsSync(portFile) && Date.now() < deadline) await sleep(20);
  if (!existsSync(portFile)) { console.log(`[A3] run${i}: FAIL no DevToolsActivePort`); await taskKillTree(child.pid); continue; }
  const tFile = performance.now() - t0;
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0].trim());
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
    const tCdp = performance.now() - t0;
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('about:blank');
    const v = await page.evaluate('1+1');
    const tFull = performance.now() - t0;
    console.log(`[A3] run${i}: OK port=${port} file=${tFile.toFixed(0)}ms connectOverCDP->ready=${tCdp.toFixed(0)}ms pageEval=${tFull.toFixed(0)}ms eval=${v} browserVersion=${browser.version()}`);
    results.push({ ok: true, ms: tCdp });
    await browser.close();
  } catch (e) {
    console.log(`[A3] run${i}: FAIL ${String(e).split('\n').slice(0, 3).join(' | ')}`);
    results.push({ ok: false });
  } finally {
    await taskKillTree(child.pid);
    await sleep(250);
    rmSync(profile, { recursive: true, force: true });
  }
}
const oks = results.filter(r => r.ok);
console.log(`[A3] SUMMARY ok=${oks.length}/${results.length}` + (oks.length ? ` connectOverCDP_ms=[${oks.map(r => r.ms.toFixed(0)).join(',')}] median=${median(oks.map(r => r.ms)).toFixed(0)}` : ''));
process.exit(oks.length ? 0 : 1);

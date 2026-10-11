// S6 Route A integration test: Playwright (playwright-core@1.64.0, root devDep @playwright/test@1
// resolves to this engine) launches REAL Chrome with --remote-debugging-pipe internally.
// This is the exact integration shape todo 10 (browser-service) would use.
//
// Usage: node a2-pipe-playwright.mjs [--repeat N] [--headless] [--browser chrome|edge]
// Prints: launch->context ready latency, page eval latency, verify chrome args actually
// contain --remote-debugging-pipe (via browser process cmdline), zero TCP exposure check.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProcesses, isInProcessTree, netstatAll, median, taskKillTree } from './lib/util.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes(name);

const repeat = Number(arg('--repeat', '3'));
const headless = has('--headless');
const which = arg('--browser', 'chrome');
const exe = which === 'edge'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const { chromium } = await import('playwright-core');

console.log(`[A2] playwright-core=${(await import('playwright-core/package.json', { with: { type: 'json' } })).default.version} exe=${exe} headless=${headless} repeat=${repeat}`);

const results = [];
for (let i = 1; i <= repeat; i++) {
  const profile = mkdtempSync(join(tmpdir(), 's6-a2-'));
  const t0 = performance.now();
  try {
    const ctx = await chromium.launchPersistentContext(profile, {
      executablePath: exe,
      headless,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-sync'],
    });
    const tReady = performance.now() - t0;
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('about:blank');
    const eval1 = await page.evaluate('1+1');
    const tEval = performance.now() - t0;

    // Verify the chrome process was launched with --remote-debugging-pipe (process cmdline via CIM)
    const procs = await listProcesses();
    const tree = [];
    for (const p of procs) {
      const nm = which === 'edge' ? 'msedge.exe' : 'chrome.exe';
      if (p.name === nm && await isInProcessTree(p.pid, process.pid, procs)) tree.push(p.pid);
    }
    let pipeArgSeen = false, portArgSeen = false;
    if (tree.length) {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const ps = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      const { stdout } = await promisify(execFile)(ps, [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${tree[0]}").CommandLine`
      ], { windowsHide: true });
      pipeArgSeen = stdout.includes('--remote-debugging-pipe');
      portArgSeen = /--remote-debugging-port=\d+/.test(stdout);
      var browserPid = tree[0];
    }
    // TCP exposure for the whole browser tree
    const rows = await netstatAll();
    const listeners = rows.filter(r => tree.includes(r.pid) && r.state === 'LISTENING');

    console.log(`[A2] run${i}: OK ready=${tReady.toFixed(0)}ms eval=${tEval.toFixed(0)}ms evalResult=${eval1} pipeArg=${pipeArgSeen} portArg=${portArgSeen} browserPid=${browserPid ?? 'n/a'} treeListeners=${JSON.stringify(listeners)} version=${ctx.browser()?.version?.() ?? ctx.constructor.name}`);
    results.push({ ok: true, ms: tReady });

    await ctx.close();
  } catch (e) {
    console.log(`[A2] run${i}: FAIL ${String(e).split('\n').slice(0, 4).join(' | ')}`);
    results.push({ ok: false });
  } finally {
    // cleanup: kill any orphan browser tree from this run
    try {
      const procs = await listProcesses();
      for (const p of procs) {
        const nm = which === 'edge' ? 'msedge.exe' : 'chrome.exe';
        if (p.name === nm && await isInProcessTree(p.pid, process.pid, procs)) await taskKillTree(p.pid);
      }
    } catch { }
    rmSync(profile, { recursive: true, force: true });
  }
}
const oks = results.filter(r => r.ok);
console.log(`[A2] SUMMARY ok=${oks.length}/${results.length}` + (oks.length ? ` ready_ms=[${oks.map(r => r.ms.toFixed(0)).join(',')}] median=${median(oks.map(r => r.ms)).toFixed(0)}` : ''));
process.exit(oks.length ? 0 : 1);

// S6 Route A: --remote-debugging-pipe with RAW node child_process (no Playwright).
// Recipe replicated from local playwright-core@1.64.0 source:
//   stdio: ["ignore","pipe","pipe","pipe","pipe"]; parent writes CDP to stdio[3],
//   reads CDP (NUL-delimited JSON) from stdio[4]; args include --remote-debugging-pipe.
//
// Usage: node a1-pipe-raw.mjs [--repeat N] [--browser chrome|edge|electron] [--headless]
//
// Evidence printed: spawn->Browser.getVersion latency (ms), per run + median;
// TCP exposure check for browser tree (netstat); DevToolsActivePort file existence.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProcesses, isInProcessTree, netstatAll, median, taskKillTree } from './lib/util.mjs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ELECTRON = join(process.cwd(), '..', 'sqlite-vec-electron', 'node_modules', 'electron', 'dist', 'electron.exe');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes(name);

const repeat = Number(arg('--repeat', '3'));
const browser = arg('--browser', 'chrome');
const headless = has('--headless');

const exe = { chrome: CHROME, edge: EDGE, electron: ELECTRON }[browser];
if (!exe || !existsSync(exe)) { console.error(`[FATAL] executable not found: ${exe}`); process.exit(2); }

const procName = { chrome: 'chrome.exe', edge: 'msedge.exe', electron: 'electron.exe' }[browser];

async function runOnce(runNo) {
  const profile = join(mkdtempSync(join(tmpdir(), 's6-a1-')), 'profile');
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions',
    ...(headless ? ['--headless=new'] : []),
    ...(browser === 'electron' ? [arg('--app', join(process.cwd(), '..', 'sqlite-vec-electron'))] : ['about:blank']),
  ];
  const t0 = performance.now();
  let child;
  try {
    child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, stage: 'spawn', error: String(e), profile };
  }

  const result = await new Promise((resolve) => {
    let done = false;
    const stderrChunks = [];
    child.stderr?.on('data', d => stderrChunks.push(d));
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const fail = (stage, error) => finish({ ok: false, stage, error: String(error).slice(0, 600) });

    child.on('error', (e) => fail('spawn-error', e));

    // fd4: browser -> parent, NUL-delimited JSON frames
    let rx = Buffer.alloc(0);
    const fd4 = child.stdio[4];
    const fd3 = child.stdio[3];
    if (!fd3 || !fd4) { fail('stdio', `child.stdio[3/4] missing: [${child.stdio.map(s => s === null ? 'null' : typeof s).join(',')}]`); return; }

    fd4.on('data', (d) => {
      rx = Buffer.concat([rx, d]);
      const frames = [];
      let z;
      while ((z = rx.indexOf(0)) >= 0) { frames.push(rx.slice(0, z).toString('utf8')); rx = rx.slice(z + 1); }
      const first = frames.find(b => b.includes('"id":1'));
      if (first && !done) {
        try { finish({ ok: true, msg: JSON.parse(first), ms: performance.now() - t0 }); }
        catch (e) { fail('parse', `bad JSON from fd4: ${first.slice(0, 200)}`); }
      }
    });
    fd4.on('error', (e) => fail('fd4-stream', e));
    fd3.on('error', (e) => fail('fd3-stream', e));
    fd4.on('end', () => fail('fd4-end', 'fd4 closed by child before CDP response'));
    child.on('exit', (code) => fail('child-exit', `child exited code=${code} stderr=${Buffer.concat(stderrChunks).toString('utf8').slice(0, 300)}`));

    // Send Browser.getVersion over fd3 as soon as the child is spawned.
    child.on('spawn', () => {
      try {
        fd3.write(Buffer.concat([Buffer.from(JSON.stringify({ id: 1, method: 'Browser.getVersion', params: {} })), Buffer.from([0])]));
      } catch (e) { fail('fd3-write', e); }
    });

    setTimeout(() => fail('timeout', 'no CDP response within 15000ms'), 15000).unref?.();
  });

  // Exposure checks: does a pipe-mode browser listen on any TCP port at all?
  let exposure = null;
  try {
    const procs = await listProcesses();
    const tree = [];
    for (const p of procs) {
      if (p.name === procName && await isInProcessTree(p.pid, child.pid, procs)) tree.push(p.pid);
    }
    const rows = await netstatAll();
    const listeners = rows.filter(r => tree.includes(r.pid) && r.state === 'LISTENING');
    const portFile = existsSync(join(profile, 'DevToolsActivePort'))
      ? readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').replace(/\0/g, '|').trim()
      : null;
    exposure = { treePids: tree, listeningSockets: listeners, devToolsActivePortFile: portFile };
  } catch (e) { exposure = { error: String(e) }; }

  await taskKillTree(child.pid);
  await new Promise(r => setTimeout(r, 250));
  return { ...result, exposure, profile };
}

// ---- main ----
console.log(`[A1] browser=${browser} exe=${exe} headless=${headless} repeat=${repeat}`);
const results = [];
for (let i = 1; i <= repeat; i++) {
  const r = await runOnce(i);
  results.push(r);
  if (r.ok) console.log(`[A1] run${i}: OK attach=${r.ms.toFixed(0)}ms product=${r.msg.result?.product} protocol=${r.msg.result?.protocolVersion} exposure=${JSON.stringify(r.exposure)}`);
  else console.log(`[A1] run${i}: FAIL stage=${r.stage} error=${r.error.replace(/\r?\n/g, ' | ')}`);
}
const oks = results.filter(r => r.ok);
console.log(`[A1] SUMMARY ok=${oks.length}/${results.length}` + (oks.length ? ` attach_ms=[${oks.map(r => r.ms.toFixed(0)).join(',')}] median=${median(oks.map(r => r.ms)).toFixed(0)}` : ''));
process.exit(oks.length ? 0 : 1);

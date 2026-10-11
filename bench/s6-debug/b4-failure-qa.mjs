// S6 failure QA orchestrator: launch browser in port mode, run an INDEPENDENT foreign
// node process against the debug port, and run the TCP-table detector concurrently.
//
// Usage: node b4-failure-qa.mjs [--headless]
//
// Demonstrates:
//  [F1] foreign HTTP access SUCCEEDS (port mode has no access-layer rejection)
//  [F2] detector: foreign ESTABLISHED peer is visible via Get-NetTCPConnection and is
//       classifiable as NOT in the browser process tree -> detection feasible
//  [F3] our ws takeover remains functional while a foreign ws client is attached
//       (Chrome accepts multiple CDP clients -> no isolation/rejection between clients)
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProcesses, isInProcessTree, taskKillTree, netstatAll, POWERSHELL } from './lib/util.mjs';
import WebSocket from 'ws';

const pExecFile = promisify(execFile);
const has = (n) => process.argv.includes(n);
const headless = has('--headless');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// 1) launch browser with --remote-debugging-port=0
const profile = join(mkdtempSync(join(tmpdir(), 's6-b4-')), 'profile');
const child = spawn(exe, [
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  ...(headless ? ['--headless=new'] : []),
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

// 2) discover port via DevToolsActivePort
const portFile = join(profile, 'DevToolsActivePort');
const deadline = Date.now() + 15000;
while (!existsSync(portFile) && Date.now() < deadline) await sleep(25);
if (!existsSync(portFile)) { console.error('[B4] DevToolsActivePort never appeared'); process.exit(1); }
const port = Number(readFileSync(portFile, 'utf8').split('\n')[0].trim());
console.log(`[B4] browser pid=${child.pid} debug port=${port} (from DevToolsActivePort file)`);

// 3) our legitimate takeover: ws Browser.getVersion over the browser endpoint
import http from 'node:http';
const verBody = await new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b));
  }).on('error', reject);
});
const wsUrl = JSON.parse(verBody).webSocketDebuggerUrl;
const ours = await new Promise((resolve) => {
  const s = new WebSocket(wsUrl);
  const fin = (r) => { try { s.close(); } catch { } resolve(r); };
  s.on('open', () => s.send(JSON.stringify({ id: 1, method: 'Browser.getVersion', params: {} })));
  s.on('message', d => { const m = JSON.parse(d.toString()); if (m.id === 1) fin({ ok: true, product: m.result?.product }); });
  s.on('error', e => fin({ ok: false, error: String(e) }));
  setTimeout(() => fin({ ok: false, error: 'timeout' }), 8000);
});
console.log(`[B4] [our client] ws Browser.getVersion -> ${ours.ok ? 'OK ' + ours.product : 'FAIL ' + ours.error}`);

// 4) launch the INDEPENDENT foreign process (sibling, not our child)
const foreign = spawn(process.execPath, [join(process.cwd(), 'b2-foreign.mjs'), String(port), '--hold', '12000'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false, // still a child of THIS launcher, but NOT of the browser tree; detector classifies by tree, not by parentage
});
let foreignOut = '';
foreign.stdout.on('data', d => { foreignOut += d; });
foreign.stderr.on('data', d => { foreignOut += d; });

// wait for the foreign TCP hold
await sleep(2500);

// 5) detector: sample TCP table, classify every established peer on the debug port
const procs = await listProcesses();
const browserTree = [];
for (const p of procs) if (p.name === 'chrome.exe' && await isInProcessTree(p.pid, child.pid, procs)) browserTree.push(p.pid);
const rows = await netstatAll();
// server-side rows (local = debug port) AND client-side rows (remote = debug port)
const established = rows.filter(r => (r.port === port || r.remote.endsWith(':' + port)) && r.state === 'ESTABLISHED');
const peers = []; // client-side sockets: local ephemeral port, remote = debug port
for (const r of established) {
  if (r.remote.endsWith(':' + port) && !browserTree.includes(r.pid) && r.pid !== process.pid) peers.push(r);
}
console.log(`[B4] detector: browserTreePids=[${browserTree.join(',')}] myPid=${process.pid}`);
console.log(`[B4] detector: established rows on port ${port}: ${JSON.stringify(established)}`);
console.log(`[B4] detector: foreign client peer(s) detected: ${peers.length ? 'YES' : 'NO'} ${JSON.stringify(peers)}`);
if (peers.length) {
  for (const p of peers) {
    const meta = procs.find(x => x.pid === p.pid);
    console.log(`[B4] detector: foreign pid=${p.pid} name=${meta?.name ?? '?'} ppid=${meta?.ppid ?? '?'} inBrowserTree=false => ALERT/KILL candidate`);
  }
}

// 6) prove a foreign ws client can coexist with ours (no isolation between CDP clients)
const foreignWs = await new Promise((resolve) => {
  const s = new WebSocket(wsUrl);
  const fin = (r) => { try { s.close(); } catch { } resolve(r); };
  s.on('open', () => s.send(JSON.stringify({ id: 1, method: 'Target.getTargets', params: {} })));
  s.on('message', d => { const m = JSON.parse(d.toString()); if (m.id === 1) fin({ ok: true, targets: m.result?.targetInfos?.length }); });
  s.on('error', e => fin({ ok: false, error: String(e) }));
  setTimeout(() => fin({ ok: false, error: 'timeout' }), 8000);
});
console.log(`[B4] [foreign ws client] Target.getTargets -> ${foreignWs.ok ? `OK targets=${foreignWs.targets} (foreign ws attach ACCEPTED by Chrome)` : 'FAIL ' + foreignWs.error}`);
console.log(`[B4] [our client re-check] ws still functional after foreign attach: re-run ours`);
const oursAgain = await new Promise((resolve) => {
  const s = new WebSocket(wsUrl);
  const fin = (r) => { try { s.close(); } catch { } resolve(r); };
  s.on('open', () => s.send(JSON.stringify({ id: 2, method: 'Browser.getVersion', params: {} })));
  s.on('message', d => { const m = JSON.parse(d.toString()); if (m.id === 2) fin({ ok: true, product: m.result?.product }); });
  s.on('error', e => fin({ ok: false, error: String(e) }));
  setTimeout(() => fin({ ok: false, error: 'timeout' }), 8000);
});
console.log(`[B4] [our client re-check] -> ${oursAgain.ok ? 'OK ' + oursAgain.product : 'FAIL ' + oursAgain.error}`);

// 7) wait for foreign process to finish and print its transcript
await new Promise(r => setTimeout(r, 9000));
console.log('[B4] --- foreign process transcript ---');
for (const line of foreignOut.split(/\r?\n/)) if (line.trim()) console.log('[B4] FOREIGN-OUT: ' + line);

await taskKillTree(child.pid);
await sleep(300);
rmSync(profile, { recursive: true, force: true });
console.log('[B4] done');
process.exit(0);

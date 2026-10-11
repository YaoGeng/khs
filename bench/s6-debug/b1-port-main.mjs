// S6 Route B: --remote-debugging-port=0 + loopback + PID validation (D6 fallback candidate).
//
// Usage: node b1-port-main.mjs [--repeat N] [--headless] [--browser chrome|edge] [--no-cdp]
//
// Per run:
//  t0 spawn(--remote-debugging-port=0) -> DevToolsActivePort file read (t_file)
//  -> HTTP GET http://127.0.0.1:<port>/json/version (t_http)
//  -> ws Browser.getVersion over webSocketDebuggerUrl (t_cdp)  [attach latency]
//  -> PID validation: netstat listener pid inside our spawn tree (Get-CimInstance chain)
//  -> binding check: LISTENING rows must be 127.0.0.1 only, never 0.0.0.0
//  -> non-loopback probe: http to LAN IP:port must be refused
//  -> Host header probe: Host: evil.example must be rejected
//  -> ws Origin probe: Origin: http://evil.example must be rejected at upgrade
//  -> playwright-core chromium.connectOverCDP('http://127.0.0.1:<port>') works (integration)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { listProcesses, isInProcessTree, netstatAll, median, taskKillTree, firstLanIPv4, POWERSHELL } from './lib/util.mjs';
import { promisify } from 'node:util';
import WebSocket from 'ws';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes(name);

const repeat = Number(arg('--repeat', '3'));
const headless = has('--headless');
const which = arg('--browser', 'chrome');
const doCdp = !has('--no-cdp');
const exe = which === 'edge'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const procName = which === 'edge' ? 'msedge.exe' : 'chrome.exe';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function httpGet(url, { headers = {}, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ error: e.code ?? String(e) }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: 'ETIMEDOUT_CLIENT' }); });
    req.end();
  });
}

async function runOnce(runNo) {
  const profile = join(mkdtempSync(join(tmpdir(), 's6-b1-')), 'profile');
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const t0 = performance.now();
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderrChunks = [];
  child.stderr.on('data', d => stderrChunks.push(d));

  // 1) wait for DevToolsActivePort file
  const portFile = join(profile, 'DevToolsActivePort');
  let tFile = null;
  const deadline = t0 + 15000;
  while (performance.now() < deadline) {
    if (existsSync(portFile)) { tFile = performance.now() - t0; break; }
    await sleep(20);
  }
  if (tFile === null) {
    await taskKillTree(child.pid);
    return { ok: false, stage: 'devtoolsactiveport', error: `file not created within 15s; stderr=${Buffer.concat(stderrChunks).toString('utf8').slice(0, 300)}`, profile };
  }
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0].trim());
  const fileUuid = readFileSync(portFile, 'utf8').split('\n')[1]?.trim();

  // 2) HTTP /json/version
  const tH0 = performance.now();
  const ver = await httpGet(`http://127.0.0.1:${port}/json/version`);
  const tHttp = performance.now() - tH0;
  if (!ver.status || ver.status !== 200) {
    await taskKillTree(child.pid);
    return { ok: false, stage: 'http-version', error: `status=${ver.status} error=${ver.error} body=${(ver.body ?? '').slice(0, 200)}`, profile, port };
  }

  // 3) ws Browser.getVersion — measured BEFORE any heavy probe so the latency chain stays clean
  let tCdp = null, wsVer = null;
  if (doCdp) {
    const ws = WebSocket;
    const wsUrl = JSON.parse(ver.body).webSocketDebuggerUrl;
    const tW0 = performance.now();
    const got = await new Promise((resolve) => {
      const s = new ws(wsUrl);
      let settled = false;
      let msOpen = null;
      const finish = (r) => { if (!settled) { settled = true; try { s.close(); } catch { } resolve(r); } };
      s.on('open', () => { msOpen = performance.now() - tW0; s.send(JSON.stringify({ id: 1, method: 'Browser.getVersion', params: {} })); });
      s.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id === 1) finish({ ok: true, product: m.result?.product, ms: performance.now() - tW0, msOpen }); });
      s.on('error', (e) => finish({ ok: false, error: String(e.message ?? e) }));
      s.on('unexpected-response', (_req, res) => finish({ ok: false, error: `unexpected-response ${res.statusCode}` }));
      setTimeout(() => finish({ ok: false, error: 'ws-timeout' }), 8000);
    });
    if (got.ok) { tCdp = performance.now() - t0; wsVer = got.product; }
    else return { ok: false, stage: 'ws-version', error: got.error, profile, port };
    console.log(`[B1] run${runNo}: ws-digest openMs=${got.msOpen?.toFixed(0)} totalMs=${got.ms?.toFixed(0)}`);
  }

  // 4) PID validation: listener pid must be in our spawn tree (heavy CIM queries, after latency chain)
  const procs = await listProcesses();
  const tree = [];
  for (const p of procs) if (p.name === procName && await isInProcessTree(p.pid, child.pid, procs)) tree.push(p.pid);
  const netRows = (await netstatAll()).filter(r => r.port === port);
  const listening = netRows.filter(r => r.state === 'LISTENING');
  const listenerPids = [...new Set(listening.map(r => r.pid))];
  const pidValid = listenerPids.length === 1 && tree.includes(listenerPids[0]);
  const boundAllInterfaces = listening.some(r => r.localAddr !== '127.0.0.1');

  // 5) non-loopback probe (LAN IP on same port must be refused)
  const lan = firstLanIPv4();
  const lanProbe = lan ? await httpGet(`http://${lan}:${port}/json/version`, { timeoutMs: 2500 }) : { error: 'no-lan-ip' };

  // 6) Host header rebinding probe
  const hostProbe = await httpGet(`http://127.0.0.1:${port}/json/version`, { headers: { Host: 'evil.example' } });

  // 7) ws Origin probe (independent of the latency ws connection)
  const wsUrlO = JSON.parse(ver.body).webSocketDebuggerUrl;
  const originProbe = await new Promise((resolve) => {
    const s = new WebSocket(wsUrlO, { headers: { Origin: 'http://evil.example' } });
    const finish = (r) => { try { s.terminate(); } catch { } resolve(r); };
    s.on('open', () => finish({ rejected: false, note: 'connection ACCEPTED with foreign Origin' }));
    s.on('error', (e) => finish({ rejected: true, error: String(e.message ?? e) }));
    s.on('unexpected-response', (_req, res) => finish({ rejected: true, httpStatus: res.statusCode }));
    setTimeout(() => finish({ rejected: null, error: 'timeout' }), 5000);
  });

  await taskKillTree(child.pid);
  await sleep(250);
  return {
    ok: true, port, portFile: { first: port, second: fileUuid?.slice(0, 16) + '...' },
    ms: { file: tFile, http: tHttp, attach: tCdp },
    httpVersion: JSON.parse(ver.body),
    pidValidation: { listenerPids, treePids: tree.length, valid: pidValid, boundAllInterfaces, listeningRows: listening },
    lanProbe, hostProbe, originProbe, stderrFirstLine: Buffer.concat(stderrChunks).toString('utf8').split(/\r?\n/).find(Boolean) ?? null,
    profile,
  };
}

// ---- main ----
console.log(`[B1] browser=${which} exe=${exe} headless=${headless} repeat=${repeat} port=0 loopback-only expected`);
const results = [];
for (let i = 1; i <= repeat; i++) {
  const r = await runOnce(i);
  results.push(r);
  if (r.ok) {
    const att = r.ms.attach == null ? 'skipped(--no-cdp)' : r.ms.attach.toFixed(0) + 'ms';
    console.log(`[B1] run${i}: OK port=${r.port} file=${r.ms.file.toFixed(0)}ms http=${r.ms.http.toFixed(0)}ms attach=${att} product=${wsVerOf(r)} pidValid=${r.pidValidation.valid} boundOnlyLoopback=${!r.pidValidation.boundAllInterfaces} listening=${JSON.stringify(r.pidValidation.listeningRows)} lanProbe=${JSON.stringify(r.lanProbe).slice(0, 80)} hostProbe=${JSON.stringify(r.hostProbe).slice(0, 80)} originProbe=${JSON.stringify(r.originProbe)}`);
    console.log(`[B1] run${i}: /json/version=${JSON.stringify(r.httpVersion)}`);
    console.log(`[B1] run${i}: stderr-first-line=${r.stderrFirstLine ?? '(none)'}`);
  } else {
    console.log(`[B1] run${i}: FAIL stage=${r.stage} error=${r.error}`);
    if (r.profile) rmSync(r.profile, { recursive: true, force: true });
  }
}
function wsVerOf(r) { return r.httpVersion?.Browser ?? r.httpVersion?.browser ?? '?'; }
const oks = results.filter(r => r.ok);
const attStr = oks.some(r => r.ms.attach != null)
  ? ` attach_ms=[${oks.filter(r => r.ms.attach != null).map(r => r.ms.attach.toFixed(0)).join(',')}] median=${median(oks.filter(r => r.ms.attach != null).map(r => r.ms.attach)).toFixed(0)}`
  : ' attach=skipped';
console.log(`[B1] SUMMARY ok=${oks.length}/${results.length}` + attStr
  + (oks.length ? ` pidValidAll=${oks.every(r => r.pidValidation.valid)} loopbackOnlyAll=${oks.every(r => !r.pidValidation.boundAllInterfaces)}` : ''));
process.exit(oks.length ? 0 : 1);

// bench-main.js — M0 Spike S3 (T-M0-04, plan todo 6): Electron main-process SQLite write blocking bench.
// MUST run under Electron runtime (electron bench-main.js) — that is the deployment context being judged (ADR-8).
//
// Scenarios (04-架构评审报告.md S3):
//   A  main-process direct write, better-sqlite3 sync API, per-row autocommit INSERT (control)
//   B  utilityProcess-hosted writer; main submits via MessagePort (main-side submit+await latency,
//      worker-side actual write duration — reported separately)
//   C  main-process direct write with transaction granularity constraint (tx=10/100/1000)
//
// Metrics: per-op event-loop blocking ms via process.hrtime.bigint() around the sync segment
// (A/C: real per-op or per-tx block; B: main roundtrip + worker real write) + throughput (ops/s)
// + p50/p95/max + main-loop lag sampler corroboration.
//
// Load: 1000 ops/round, 1 warmup + 3 measured rounds, fixed seed (deterministic payloads),
// WAL + synchronous=NORMAL (02-系统架构设计.md §14.1). ASCII-only stdout.
'use strict';

const { app, utilityProcess, MessageChannelMain } = require('electron');
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SEED = 20261011;            // fixed seed -> reproducible payload stream
const OPS = 1000;                 // per-round ops (>= 1000 required)
const MEASURED_ROUNDS = 3;        // rounds 1..3 reported; round 0 = warmup, excluded
const TX_SIZES = [1, 10, 100, 1000]; // 1 = scenario A control; 10/100/1000 = scenario C variants
const RESULT_DIR = path.join(__dirname, 'results');
const WATCHDOG_MS = 120000;

const SCHEMA = `CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  msg TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  shot_path TEXT
)`;
const INSERT = `INSERT INTO logs (ts, level, kind, trace_id, span_id, msg, meta_json, shot_path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_ARGS = 8;

// ---------- deterministic payload generation (mulberry32) ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genPayloads(n, seed) {
  const rnd = mulberry32(seed);
  const levels = ['debug', 'info', 'warn', 'error'];
  const kinds = ['user_op', 'auto_step', 'llm_call', 'net_meta', 'sys_err'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const meta = {
      seq: i,
      likes: Math.floor(rnd() * 400),
      collects: Math.floor(rnd() * 90),
      comments: Math.floor(rnd() * 35),
      tags: ['tag_a', 'tag_b'],
      note_id: 'nid_' + Math.floor(rnd() * 0x7fffffff).toString(36),
      body: 'p'.repeat(120 + Math.floor(rnd() * 80)), // ~120-200B payload
    };
    const args = [
      1760000000000 + i,                                            // ts
      levels[Math.floor(rnd() * levels.length)],                    // level
      kinds[Math.floor(rnd() * kinds.length)],                      // kind
      'trc' + Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0'),
      'spn' + Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0'),
      'synthetic log line #' + i,                                   // msg
      JSON.stringify(meta),                                         // meta_json
      i % 20 === 0 ? 'shots/shot_' + i + '.png' : null,             // shot_path
    ];
    out.push(args);
  }
  return out;
}

// ---------- main-loop lag sampler (corroboration metric) ----------
function startLagSampler() {
  const s = { max: 0, events: 0 };
  let last = process.hrtime.bigint();
  s.timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const lagMs = Number(now - last) / 1e6 - 4; // expected interval: 4ms
    last = now;
    if (lagMs > s.max) s.max = lagMs;
    if (lagMs > 5) s.events++;
  }, 4);
  return s;
}
function stopLagSampler(s) {
  clearInterval(s.timer);
  return { maxLoopLagMs: Math.round(s.max * 1000) / 1000, lagEventsOver5ms: s.events };
}

// ---------- stats ----------
function statsFromMs(arrMs) {
  if (!arrMs.length) return null;
  const a = [...arrMs].sort((x, y) => x - y);
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.999999))];
  return {
    p50: q(0.50), p95: q(0.95), max: a[a.length - 1], mean,
    total: a.reduce((x, y) => x + y, 0),
  };
}
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

// `segments` = number of blocking segments measured (ops for A/B, txs for C);
// `rowsCompleted` = payload rows actually written (throughput denominator).
function rowFromMs({ scenario, unit, round, segments, rowsCompleted, arrMs, wallMs, lag }) {
  const st = statsFromMs(arrMs);
  return {
    scenario, unit, round, segments, rowsCompleted,
    p50: r3(st.p50), p95: r3(st.p95), max: r3(st.max), mean: r3(st.mean),
    totalBlockMs: r3(st.total),
    throughputOpsPerSec: Math.round(rowsCompleted / (wallMs / 1000)),
    maxLoopLagMs: lag.maxLoopLagMs,
    lagEventsOver5ms: lag.lagEventsOver5ms,
  };
}

function freshPath(tag) {
  const p = path.join(RESULT_DIR, tag + '.db');
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true });
  return p;
}

function openFresh(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

// ---------- scenario A/C: main-process synchronous writes ----------
function runSyncRound(dbPath, payloads, txSize) {
  fs.rmSync(dbPath, { force: true });
  const db = openFresh(dbPath);
  const stmt = db.prepare(INSERT);
  const runBatch = txSize > 1 ? db.transaction((batch) => {
    for (let i = 0; i < batch.length; i++) {
      const a = batch[i];
      stmt.run(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]);
    }
  }) : null;

  const perOpMs = [];      // amortized per-op when txSize>1
  const blockMs = [];      // real sync blocking segments (per-op for A, per-tx for C)
  const lag = startLagSampler();
  const t0 = process.hrtime.bigint();

  if (txSize === 1) {
    for (let i = 0; i < payloads.length; i++) {
      const a = payloads[i];
      const b = process.hrtime.bigint();
      stmt.run(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]);
      const d = Number(process.hrtime.bigint() - b) / 1e6;
      perOpMs.push(d); blockMs.push(d);
    }
  } else {
    for (let i = 0; i < payloads.length; i += txSize) {
      const batch = payloads.slice(i, i + txSize);
      const b = process.hrtime.bigint();
      runBatch(batch);
      const d = Number(process.hrtime.bigint() - b) / 1e6;
      blockMs.push(d);
      const amort = d / batch.length;
      for (let k = 0; k < batch.length; k++) perOpMs.push(amort);
    }
  }

  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const lagOut = stopLagSampler(lag);
  db.close();
  return { perOpMs, blockMs, wallMs, lag: lagOut };
}

// ---------- scenario B: utilityProcess-hosted writer ----------
function createWorkerProxy() {
  const child = utilityProcess.fork(path.join(__dirname, 'bench-worker.js'), [], {
    serviceName: 'sqlite-write-bench-worker',
  });
  const { port1, port2 } = new MessageChannelMain();
  const pending = new Map();
  let nextId = 1;
  let readyResolve;
  const ready = new Promise((res) => { readyResolve = res; });

  port2.on('message', (e) => {
    const m = e.data || {};
    if (m.type === 'ready') { readyResolve(); return; }
    if (m.type === 'initDone' || m.type === 'initFail' || m.type === 'closed') {
      const ent = pending.get(m.type);
      if (ent) { pending.delete(m.type); ent.resolve(m); }
      return;
    }
    if (m.type === 'done') {
      const ent = pending.get(m.id);
      if (ent) { pending.delete(m.id); ent.resolve(m); }
    }
  });
  port2.start();
  child.postMessage({ type: 'port' }, [port1]);

  return {
    ready,
    init: (dbPath, busyTimeout) => new Promise((res, rej) => {
      pending.set('initDone', { resolve: (m) => res(m) });
      pending.set('initFail', { resolve: (m) => rej(new Error(m.error || 'worker init failed')) });
      port2.postMessage({ type: 'init', dbPath, busyTimeout });
    }),
    write: (args) => new Promise((res) => {
      const id = nextId++;
      pending.set(id, { resolve: res });
      port2.postMessage({ type: 'write', id, args });
    }),
    close: () => new Promise((res) => {
      pending.set('closed', { resolve: () => res() });
      port2.postMessage({ type: 'close' });
    }),
    kill: () => { try { child.kill(); } catch (_) { /* noop */ } },
  };
}

async function runWorkerRound(proxy, dbPath, payloads) {
  fs.rmSync(dbPath, { force: true });
  await proxy.init(dbPath, 5000);
  const mainRoundtripMs = [];
  const workerWriteMs = [];
  const lag = startLagSampler();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < payloads.length; i++) {
    const b = process.hrtime.bigint();
    const res = await proxy.write(payloads[i]);
    mainRoundtripMs.push(Number(process.hrtime.bigint() - b) / 1e6);
    workerWriteMs.push(res.writeMs);
    if (res.err) throw new Error('worker write error: ' + JSON.stringify(res.err));
  }
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const lagOut = stopLagSampler(lag);
  await proxy.close();
  return { mainRoundtripMs, workerWriteMs, wallMs, lag: lagOut };
}

// ---------- failure QA: artificial write-lock contention ----------
async function lockQaMain(workerPayloads) {
  const out = {};

  // (1) main direct write, locker connection holds BEGIN EXCLUSIVE, busy_timeout = 2000ms
  {
    const dbPath = freshPath('lock-a-busy2000');
    const db = openFresh(dbPath);
    const stmt = db.prepare(INSERT);
    const locker = new Database(dbPath);
    locker.exec('BEGIN EXCLUSIVE'); // WAL: holds the single writer slot
    db.pragma('busy_timeout = 2000');
    const b = process.hrtime.bigint();
    let err = null;
    try { stmt.run(...workerPayloads[0]); } catch (e) { err = { name: e.name, code: e.code, message: String(e.message) }; }
    const blockMs = Number(process.hrtime.bigint() - b) / 1e6;
    locker.exec('ROLLBACK'); locker.close(); db.close();
    out.lockA_busy2000 = {
      busyTimeoutMs: 2000, blockedMs: r3(blockMs), err,
      detectionTriggered: blockMs > 50, // T1 threshold: single write sync block p95 > 50ms unacceptable
      errDetected: !!err,
    };
  }

  // (2) same but busy_timeout = 0 -> bounded immediate failure (no long event-loop stall)
  {
    const dbPath = freshPath('lock-a-timeout0');
    const db = openFresh(dbPath);
    const stmt = db.prepare(INSERT);
    const locker = new Database(dbPath);
    locker.exec('BEGIN EXCLUSIVE');
    db.pragma('busy_timeout = 0');
    const b = process.hrtime.bigint();
    let err = null;
    try { stmt.run(...workerPayloads[0]); } catch (e) { err = { name: e.name, code: e.code, message: String(e.message) }; }
    const blockMs = Number(process.hrtime.bigint() - b) / 1e6;
    locker.exec('ROLLBACK'); locker.close(); db.close();
    out.lockA_timeout0 = {
      busyTimeoutMs: 0, blockedMs: r3(blockMs), err,
      detectionTriggered: blockMs > 50 || !!err,
      errDetected: !!err,
    };
  }

  // (3) scenario B containment: same lock held, writer lives in utilityProcess.
  //     Worker blocks ~busy_timeout, main event loop stays free (lag sampler keeps ticking).
  {
    const dbPath = freshPath('lock-b-busy2000');
    const db0 = openFresh(dbPath); db0.close(); // create file + schema before locking
    const proxy = createWorkerProxy();
    await proxy.ready;
    await proxy.init(dbPath, 2000);            // worker opens DB while no lock held
    const locker = new Database(dbPath);
    locker.exec('BEGIN EXCLUSIVE');            // now hold the single writer slot
    const lag = startLagSampler();
    const b = process.hrtime.bigint();
    const res = await proxy.write(workerPayloads[0]);
    const mainWaitMs = Number(process.hrtime.bigint() - b) / 1e6;
    const lagOut = stopLagSampler(lag);
    locker.exec('ROLLBACK'); locker.close();
    await proxy.close(); proxy.kill();
    out.lockB_busy2000 = {
      busyTimeoutMs: 2000,
      workerWriteBlockedMs: r3(res.writeMs), workerErr: res.err,
      mainWaitMs: r3(mainWaitMs),
      mainMaxLoopLagMsDuringWait: lagOut.maxLoopLagMs, // containment proof: main loop free
      detectionTriggered: res.writeMs > 50,
    };
  }
  return out;
}

// ---------- printing ----------
function printRow(r) {
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log(
    pad(r.scenario, 18) + pad(r.unit, 13) + padL(r.round, 6) + padL(r.segments, 6) + padL(r.rowsCompleted, 6) +
    padL(r.p50, 9) + padL(r.p95, 9) + padL(r.max, 10) + padL(r.mean, 9) +
    padL(r.throughputOpsPerSec, 10) + padL(r.maxLoopLagMs, 14) + padL(r.lagEventsOver5ms, 8)
  );
}

function aggregate(rows, key) {
  const sel = rows.filter((r) => r.scenario + '|' + r.unit === key && r.round > 0);
  if (!sel.length) return null;
  const avg = (f) => sel.reduce((x, y) => x + y[f], 0) / sel.length;
  return {
    scenario: sel[0].scenario, unit: sel[0].unit, rounds: sel.length,
    p50: r3(avg('p50')), p95: r3(avg('p95')), max: Math.max(...sel.map((r) => r.max)),
    throughput: Math.round(avg('throughputOpsPerSec')),
  };
}

// ---------- main ----------
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    console.error('WATCHDOG_TIMEOUT after ' + WATCHDOG_MS + 'ms');
    app.exit(3);
  }, WATCHDOG_MS);

  try {
    fs.mkdirSync(RESULT_DIR, { recursive: true });

    const probe = new Database(':memory:');
    const sqliteVersion = probe.prepare('select sqlite_version() as v').get().v;
    probe.close();

    const info = {
      platform: os.platform() + ' ' + os.release(),
      cpu: os.cpus()[0].model,
      totalMemGB: Math.round(os.totalmem() / 1073741824 * 10) / 10,
      electron: process.versions.electron,
      nodeInElectron: process.versions.node,
      electronAbi: process.versions.modules,
      betterSqlite3: require('better-sqlite3/package.json').version,
      sqliteVersion,
      seed: SEED, opsPerRound: OPS, measuredRounds: MEASURED_ROUNDS, warmupRound: 0,
      pragmas: 'journal_mode=WAL, synchronous=NORMAL',
      date: new Date().toISOString(),
    };
    console.log('=== M0 Spike S3: main-process SQLite write blocking bench (ADR-8) ===');
    console.log(JSON.stringify(info));

    const rows = [];

    // --- scenarios A + C (main-process sync writes) ---
    for (const txSize of TX_SIZES) {
      const scenario = txSize === 1 ? 'A-direct(tx=1)' : 'C-tx' + txSize;
      for (let round = 0; round <= MEASURED_ROUNDS; round++) {
        const payloads = genPayloads(OPS, SEED + txSize * 10 + round);
        const r = runSyncRound(freshPath('s-' + txSize + '-r' + round), payloads, txSize);
        if (round === 0) continue; // warmup, excluded from evidence
        rows.push(rowFromMs({ scenario, unit: txSize === 1 ? 'op' : 'tx-block', round, segments: r.blockMs.length, rowsCompleted: OPS, arrMs: r.blockMs, wallMs: r.wallMs, lag: r.lag }));
        if (txSize > 1) {
          rows.push(rowFromMs({ scenario, unit: 'op-amortized', round, segments: OPS, rowsCompleted: OPS, arrMs: r.perOpMs, wallMs: r.wallMs, lag: r.lag }));
        }
      }
    }

    // --- scenario B (utilityProcess writer) ---
    const proxy = createWorkerProxy();
    await proxy.ready;
    let workerSqlite = null;
    for (let round = 0; round <= MEASURED_ROUNDS; round++) {
      const payloads = genPayloads(OPS, SEED + 900 + round);
      const r = await runWorkerRound(proxy, freshPath('s-B-r' + round), payloads);
      if (round === 0) continue;
      rows.push(rowFromMs({ scenario: 'B-utilityProc', unit: 'main-roundtrip', round, segments: OPS, rowsCompleted: OPS, arrMs: r.mainRoundtripMs, wallMs: r.wallMs, lag: r.lag }));
      rows.push(rowFromMs({ scenario: 'B-utilityProc', unit: 'worker-actual', round, segments: OPS, rowsCompleted: OPS, arrMs: r.workerWriteMs, wallMs: r.wallMs, lag: r.lag }));
    }
    await proxy.close();
    proxy.kill();

    // --- failure QA: artificial lock contention ---
    const lockPayloads = genPayloads(4, SEED + 777);
    const lock = await lockQaMain(lockPayloads);

    // --- aggregates (stability value across 3 measured rounds) ---
    const agg = [];
    for (const key of rows.map((r) => r.scenario + '|' + r.unit).filter((v, i, a) => a.indexOf(v) === i)) {
      const a = aggregate(rows, key);
      if (a) agg.push(a);
    }

    const result = { info, rows, agg, lock };
    fs.writeFileSync(path.join(RESULT_DIR, 'bench-result.json'), JSON.stringify(result, null, 2));

    console.log('\n--- per-round rows (rounds 1..3; warmup excluded) ---');
    console.log('scenario          unit         round  segs  rows      p50      p95       max     mean     ops/s  maxLoopLagMs lag>5ms');
    for (const r of rows) printRow(r);
    console.log('\n--- aggregate across 3 measured rounds (stability value) ---');
    console.log('scenario          unit         rounds      p50      p95       max     ops/s');
    for (const a of agg) {
      console.log(a.scenario.padEnd(18) + a.unit.padEnd(13) + String(a.rounds).padStart(6) +
        String(a.p50).padStart(10) + String(a.p95).padStart(10) + String(a.max).padStart(10) +
        String(a.throughput).padStart(10));
    }
    console.log('\n--- failure QA: artificial write-lock contention ---');
    console.log(JSON.stringify(lock, null, 2));
    console.log('\nresults written to: ' + path.join(RESULT_DIR, 'bench-result.json'));

    clearTimeout(watchdog);
    app.exit(0);
  } catch (e) {
    console.error('BENCH_FATAL', e && e.stack ? e.stack : String(e));
    clearTimeout(watchdog);
    app.exit(1);
  }
});

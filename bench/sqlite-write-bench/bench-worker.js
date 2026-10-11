// bench-worker.js — utilityProcess entry: hosts the SQLite write connection off the main process.
// Protocol (over MessagePort transferred via process.parentPort):
//   main -> worker : { type:'port' }                      (port transfer, e.ports[0])
//   main -> worker : { type:'init', dbPath, busyTimeout } -> { type:'initDone', sqlite }
//   main -> worker : { type:'write', id, args:[...] }     -> { type:'done', id, writeMs, err }
//   main -> worker : { type:'close' }                     -> { type:'closed' }
// writeMs = actual synchronous stmt.run() duration measured with process.hrtime.bigint() (worker side).
'use strict';

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

let db = null;
let stmt = null;

function openDb(dbPath, busyTimeout) {
  const Database = require('better-sqlite3');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma(`busy_timeout = ${busyTimeout}`);
  db.exec(SCHEMA);
  stmt = db.prepare(INSERT);
}

function handle(msg, port) {
  switch (msg.type) {
    case 'init': {
      try {
        openDb(msg.dbPath, msg.busyTimeout == null ? 5000 : msg.busyTimeout);
        port.postMessage({ type: 'initDone', sqlite: db.prepare('select sqlite_version() as v').get().v });
      } catch (e) {
        port.postMessage({ type: 'initFail', error: String(e && e.message ? e.message : e) });
      }
      break;
    }
    case 'write': {
      const t0 = process.hrtime.bigint();
      let err = null;
      try {
        stmt.run(msg.args[0], msg.args[1], msg.args[2], msg.args[3], msg.args[4], msg.args[5], msg.args[6], msg.args[7]);
      } catch (ex) {
        err = { name: ex.name, code: ex.code, message: String(ex.message) };
      }
      const writeMs = Number(process.hrtime.bigint() - t0) / 1e6;
      port.postMessage({ type: 'done', id: msg.id, writeMs, err });
      break;
    }
    case 'close': {
      try { db.close(); } catch (_) { /* noop */ }
      port.postMessage({ type: 'closed' });
      break;
    }
    default:
      break;
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'port' && e.ports && e.ports[0]) {
    const port = e.ports[0];
    port.on('message', (m) => handle(m.data, port));
    port.start();
    port.postMessage({ type: 'ready' });
  }
});

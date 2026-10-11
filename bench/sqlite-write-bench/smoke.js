// smoke.js — verify better-sqlite3 (electron ABI prebuild) loads inside Electron main process.
// ASCII-only output. Exit 0 on success.
const { app } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    const wal = db.pragma('journal_mode = WAL', { simple: true });
    db.pragma('synchronous = NORMAL');
    const sv = db.prepare('select sqlite_version() as v').get().v;
    db.exec('CREATE TABLE t(a)'); db.prepare('INSERT INTO t VALUES (?)').run(1);
    const ok = db.prepare('SELECT a FROM t').get().a === 1;
    db.close();
    console.log(JSON.stringify({
      ok,
      electron: process.versions.electron,
      nodeInElectron: process.versions.node,
      electronAbi: process.versions.modules,
      sqliteVersion: sv,
      journalMode: wal,
      betterSqlite3: require('better-sqlite3/package.json').version,
    }));
    app.exit(ok ? 0 : 2);
  } catch (e) {
    console.error('SMOKE_FAIL', e && e.stack ? e.stack : String(e));
    app.exit(1);
  }
});

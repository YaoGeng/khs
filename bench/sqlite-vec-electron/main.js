'use strict';
/*
 * S11 spike main process (todo 5, maps T-M0-06):
 * 1. require better-sqlite3 (native module, must come from app.asar.unpacked)
 * 2. loadExtension(sqlite-vec)
 * 3. select vec_version()
 * 4. write a result JSON file next to the executable, then quit
 * Exit code: 0 = all steps OK, 1 = any step failed (details in the result file).
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function writeResult(payload) {
  const name = 'pack-result.json';
  const candidates = app.isPackaged
    ? [path.join(path.dirname(app.getPath('exe')), name), path.join(app.getPath('temp'), name)]
    : [path.join(__dirname, name), path.join(app.getPath('temp'), name)];
  const body = JSON.stringify(payload, null, 2);
  for (const file of candidates) {
    try {
      fs.writeFileSync(file, body);
      payload._writtenTo = file;
      return;
    } catch {
      /* try next candidate */
    }
  }
}

app.whenReady().then(() => {
  const result = {
    startedAt: new Date().toISOString(),
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    electron: process.versions.electron,
    nodeInElectron: process.versions.node,
    electronAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  };
  let db = null;
  try {
    const Database = require('better-sqlite3');
    const vec = require('sqlite-vec');
    result.betterSqlite3Resolved = require.resolve('better-sqlite3');
    result.sqliteVecLoadablePathRaw = vec.getLoadablePath();

    // KEY FINDING (S11): getLoadablePath() returns a virtual app.asar path.
    // Node's process.dlopen remaps app.asar -> app.asar.unpacked for .node files,
    // but SQLite's LoadLibrary does NOT go through dlopen — we must rewrite the
    // path to the unpacked location ourselves before loadExtension().
    result.sqliteVecLoadablePath = app.isPackaged
      ? result.sqliteVecLoadablePathRaw.replace('app.asar', 'app.asar.unpacked')
      : result.sqliteVecLoadablePathRaw;

    // Verify the unpacked layout really exists on disk (bypass asar with original-fs).
    const ofs = require('original-fs');
    const asarRoot = app.isPackaged ? path.join(path.dirname(app.getAppPath()), 'app.asar.unpacked') : null;
    if (asarRoot) {
      result.unpackedLayout = {
        betterSqlite3NativeExists: ofs.existsSync(
          path.join(asarRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
        ),
        sqliteVecDirExists: ofs.existsSync(path.join(asarRoot, 'node_modules', 'sqlite-vec')),
        sqliteVecWindowsDirExists: ofs.existsSync(path.join(asarRoot, 'node_modules', 'sqlite-vec-windows-x64')),
      };
      if (result.sqliteVecLoadablePath) {
        result.loadablePathInsideUnpacked = result.sqliteVecLoadablePath
          .replaceAll('\\', '/')
          .includes('app.asar.unpacked');
      }
    }

    db = new Database(':memory:');
    db.loadExtension(result.sqliteVecLoadablePath);
    result.vecVersion = db.prepare('select vec_version() as v').get().v;
    result.sqliteVersion = db.prepare('select sqlite_version() as v').get().v;

    // Minimal KNN smoke test to prove the extension is functional, not just loadable.
    // FINDING (S11): better-sqlite3 binds ALL JS numbers as REAL (typeof(1)='real',
    // verified in both Node 24 and Electron 33 runtimes); vec0 rejects REAL rowids
    // ("Only integers are allows for primary key values"). SQL literals keep INTEGER,
    // and BigInt params bind as INTEGER. Workaround for M1: pass BigInt for explicit
    // rowids (or omit rowid). Recorded in docs/adr/sqlite-vec-packaging-validation.md.
    db.exec('CREATE VIRTUAL TABLE demo_vec USING vec0(embedding float[4])');
    const a = new Float32Array([0.25, 0.25, 0.25, 0.25]);
    const b = new Float32Array([1, 0, 0, 0]);
    const insert = db.prepare('INSERT INTO demo_vec(rowid, embedding) VALUES (?, ?)');
    insert.run(BigInt(1), Buffer.from(a.buffer));
    insert.run(BigInt(2), Buffer.from(b.buffer));
    result.knnTopRow = db
      .prepare('SELECT rowid, distance FROM demo_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1')
      .get(Buffer.from(a.buffer));
    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = String((err && err.stack) || err);
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore close errors */
    }
  }
  writeResult(result);
  app.exit(result.ok ? 0 : 1);
});

'use strict';
/*
 * M1 plan todo 2 — sqlite-vec packaging validation under a PNPM layout.
 * Re-runs the ADR duty of docs/adr/sqlite-vec-packaging-validation.md §3-③
 * (M1 must re-verify the asar loading path with node_modules produced by
 * pnpm — symlink layout + node_modules/.pnpm virtual store — where M0 only
 * proved the npm layout in bench/sqlite-vec-electron).
 *
 * Flow (same shape as the M0 main.js unless noted):
 *  1. require better-sqlite3 (native module must come from app.asar.unpacked)
 *  2. sqlite-vec getLoadablePath() → asPath rewrite app.asar → app.asar.unpacked
 *     (ADR §3-②: SQLite's LoadLibrary does NOT go through Node's dlopen remap)
 *  3. loadExtension → vec_version() / sqlite_version()
 *  4. vec0 table `USING vec0(embedding float[1024])` — N=1024 is a placeholder;
 *     the production default dim is locked by T-M1-01 ADR-7, this validation
 *     only proves the load + KNN path (noted in ADR §7 appendix).
 *  5. insert 5 rows with EXPLICIT BigInt rowids (ADR §3-④: better-sqlite3
 *     binds plain JS numbers as REAL and vec0 rejects them), KNN MATCH query
 *     top-3, assert the id order [1,2,3] and finite distances, write the
 *     result JSON next to the executable, then quit.
 *
 * Exit code: 0 = all steps OK, 1 = any step failed (details in result file).
 *
 * FAILURE QA (plan todo 2 QA): run the packed exe with
 *   SQLITEVEC_BENCH_MODE=raw-path
 * to bypass the asPath rewrite on purpose (pass the raw getLoadablePath()
 * asar path straight into loadExtension — exactly the M0 failure). Expected:
 * SqliteError "找不到指定的模块" and exit code 1 — proving the rewrite in
 * step 2 is what makes packaged loading work.
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const RAW_PATH_MODE = process.env.SQLITEVEC_BENCH_MODE === 'raw-path';
const DIM = 1024;

function writeResult(name, payload) {
  const candidates = app.isPackaged
    ? [path.join(path.dirname(app.getPath('exe')), name), path.join(app.getPath('temp'), name)]
    : [path.join(__dirname, name), path.join(app.getPath('temp'), name)];
  const body = JSON.stringify(payload, null, 2);
  for (const file of candidates) {
    try {
      fs.writeFileSync(file, body);
      payload._writtenTo = file;
      return file;
    } catch {
      /* fall through to the next candidate */
    }
  }
  return null;
}

app.whenReady().then(() => {
  const result = {
    benchMode: RAW_PATH_MODE ? 'raw-path (asPath rewrite disabled)' : 'asPath-rewrite',
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
    result.sqliteVecResolved = require.resolve('sqlite-vec');
    result.sqliteVecLoadablePathRaw = vec.getLoadablePath();

    if (RAW_PATH_MODE) {
      // FAILURE QA mode: skip the ADR §3-② asPath rewrite on purpose.
      result.sqliteVecLoadablePath = result.sqliteVecLoadablePathRaw;
    } else {
      // KEY (ADR §3-②): only the packaged app needs the rewrite; an unpackaged
      // run already sees a real path on disk.
      result.sqliteVecLoadablePath = app.isPackaged
        ? result.sqliteVecLoadablePathRaw.replace('app.asar', 'app.asar.unpacked')
        : result.sqliteVecLoadablePathRaw;
    }

    // Verify the unpacked layout really exists on disk (bypass asar with original-fs).
    const ofs = require('original-fs');
    const asarRoot = app.isPackaged
      ? path.join(path.dirname(app.getAppPath()), 'app.asar.unpacked')
      : path.join(__dirname, 'node_modules');
    result.unpackedLayout = {
      rootQueried: asarRoot,
      betterSqlite3NativeExists: ofs.existsSync(
        path.join(asarRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
      ),
      sqliteVecDirExists: ofs.existsSync(path.join(asarRoot, 'node_modules', 'sqlite-vec')),
      sqliteVecWindowsX64DirExistsAtTopLevel: ofs.existsSync(
        path.join(asarRoot, 'node_modules', 'sqlite-vec-windows-x64'),
      ),
    };
    try {
      result.unpackedLayout.unpackedNodeModulesChildren = ofs
        .readdirSync(path.join(asarRoot, 'node_modules'))
        .filter((n) => !n.startsWith('.'));
    } catch (err) {
      result.unpackedLayout.unpackedNodeModulesChildren = 'unavailable: ' + err.code;
    }
    try {
      result.unpackedLayout.sqliteVecDirChildren = ofs
        .readdirSync(path.join(asarRoot, 'node_modules', 'sqlite-vec'))
        .filter((n) => !n.startsWith('.'));
    } catch (err) {
      result.unpackedLayout.sqliteVecDirChildren = 'unavailable: ' + err.code;
    }
    if (result.sqliteVecLoadablePath) {
      result.loadablePathInsideUnpacked = result.sqliteVecLoadablePath
        .replaceAll('\\', '/')
        .includes('app.asar.unpacked');
      result.loadablePathOnDiskExists = ofs.existsSync(result.sqliteVecLoadablePath);
    }

    db = new Database(':memory:');
    db.loadExtension(result.sqliteVecLoadablePath);
    result.vecVersion = db.prepare('select vec_version() as v').get().v;
    result.sqliteVersion = db.prepare('select sqlite_version() as v').get().v;

    // vec0 table with the M1 placeholder dim (see file header note).
    db.exec(`CREATE VIRTUAL TABLE demo_vec USING vec0(embedding float[${DIM}])`);

    // 5 rows; BigInt rowids per ADR §3-④ (fail the insert otherwise: REAL rowid denied).
    const make = (values) => {
      const v = new Float32Array(DIM);
      v.set(values);
      return v;
    };
    const far = make([0, 0]);
    far[DIM - 1] = 1;
    const rowsToInsert = [
      [1n, make([1, 0])],
      [2n, make([0.8, 0.6])],
      [3n, make([0.6, 0.8])],
      [4n, far],
      [5n, make([0, 1])],
    ];
    const insert = db.prepare('INSERT INTO demo_vec(rowid, embedding) VALUES (?, ?)');
    const insertAll = db.transaction(() => {
      for (const [rowid, v] of rowsToInsert) insert.run(rowid, Buffer.from(v.buffer));
    });
    insertAll();
    result.rowCount = db.prepare('select count(*) as c from demo_vec').get().c;
    result.rowidsInsertedAsBigInt = true;
    const queryVec = make([1, 0]);
    const top3 = db
      .prepare('SELECT rowid, distance FROM demo_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 3')
      .all(Buffer.from(queryVec.buffer));
    result.knnTop3 = top3;
    result.knnAssertions = {
      expectedOrder: [1, 2, 3],
      orderMatches: JSON.stringify(top3.map((r) => r.rowid)) === JSON.stringify([1, 2, 3]),
      allDistancesFinite: top3.every((r) => Number.isFinite(r.distance) && r.distance >= 0),
      distances: top3.map((r) => r.distance),
    };
    result.ok =
      top3.length === 3 &&
      result.knnAssertions.orderMatches &&
      result.knnAssertions.allDistancesFinite;
  } catch (err) {
    result.ok = false;
    result.error = String((err && err.stack) || err);
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* best effort */
    }
  }
  const written = writeResult(RAW_PATH_MODE ? 'pack-result-failure.json' : 'pack-result.json', result);
  if (written) console.log('[sqlite-vec-pnpm-bench] result file: ' + written);
  app.exit(result.ok ? 0 : 1);
});

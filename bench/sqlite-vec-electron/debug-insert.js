'use strict';
const { app } = require('electron');
app.whenReady().then(() => {
  const Database = require('better-sqlite3');
  const vec = require('sqlite-vec');
  const db = new Database(':memory:');
  db.loadExtension(vec.getLoadablePath());
  db.exec('CREATE VIRTUAL TABLE d1 USING vec0(embedding float[4])');
  const out = { electron: process.versions.electron, node: process.versions.node };
  out.typeofParam1 = db.prepare('select typeof(?) as t').get(1);
  out.typeofBigint = db.prepare('select typeof(?) as t').get(BigInt(7));
  const buf = (arr) => Buffer.from(new Float32Array(arr).buffer);
  try {
    db.prepare('INSERT INTO d1(embedding) VALUES (?)').run(buf([1, 0, 0, 0]));
    out.insertNoRowid = 'ok';
  } catch (e) {
    out.insertNoRowid = e.message;
  }
  try {
    db.prepare("INSERT INTO d1(rowid, embedding) VALUES (1, ?)").run(buf([0, 1, 0, 0]));
    out.insertLiteralRowid = 'ok';
  } catch (e) {
    out.insertLiteralRowid = e.message;
  }
  try {
    db.prepare('INSERT INTO d1(rowid, embedding) VALUES (?, ?)').run(1, buf([0, 0, 1, 0]));
    out.insertParamRowid = 'ok';
  } catch (e) {
    out.insertParamRowid = e.message;
  }
  try {
    db.prepare('INSERT INTO d1(rowid, embedding) VALUES (?, ?)').run(BigInt(2), buf([0, 0, 0, 1]));
    out.insertBigIntRowid = 'ok';
  } catch (e) {
    out.insertBigIntRowid = e.message;
  }
  try {
    out.allRows = db.prepare('SELECT rowid FROM d1').all();
  } catch (e) {
    out.allRows = e.message;
  }
  console.log(JSON.stringify(out, null, 2));
  app.exit(0);
});

'use strict';
// SQLite store via centralized database module (better-sqlite3).
// Provides the same API as before but uses the shared central-db.js.

const centralDb = require('./central-db');
const config = require('./config');
const { ensureDataDir } = require('./keystore');

// Use the centralized forgeprep database
const db = centralDb.forgeprepDB();

const uid = () => require('crypto').randomUUID();
const now = () => Date.now();

// Re-export the same API as before for backward compatibility
function get() { return db; }
function run(sql, ...params) { return db.prepare(sql).run(...params); }
function all(sql, ...params) { return db.prepare(sql).all(...params); }
function one(sql, ...params) { return db.prepare(sql).get(...params); }
function tx(fn) { return db.transaction(fn)(); }
function close() { db.close(); }
function integrityOk() {
  try { return db.prepare('PRAGMA quick_check').get().quick_check === 'ok'; } catch { return false; }
}

// Keep ensureColumn for backward compatibility
const columnCache = new Set();
function ensureColumn(table, col, ddl) {
  if (columnCache.has(`${table}.${col}`)) return;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((r) => r.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
  }
  columnCache.add(`${table}.${col}`);
}

module.exports = { 
  open: () => db, 
  get, run, all, one, tx, close, integrityOk, ensureColumn, db 
};
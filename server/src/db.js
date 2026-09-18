'use strict';
// SQLite store via Node's built-in `node:sqlite` (zero native deps; backed by
// SQLite with FTS5 enabled). Thin wrapper isolates the experimental API so it
// can be swapped for better-sqlite3 without touching callers.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { ensureDataDir } = require('./keystore');

let db = null;

function open() {
  ensureDataDir();
  fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
  db = new DatabaseSync(config.DB_PATH);
  // Durability + concurrency (Req 7). Synchronous NORMAL: crash-safe enough,
  // single-writer process in practice.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  migrate();
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      base_url    TEXT NOT NULL,
      key_sealed  TEXT NOT NULL DEFAULT '',
      key_env     TEXT NOT NULL DEFAULT '',
      tls_fingerprint TEXT NOT NULL DEFAULT '',
      type        TEXT NOT NULL DEFAULT 'openai',
      active      INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id          TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      model       TEXT NOT NULL,
      meta        TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL,
      UNIQUE(provider_id, model)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS chats (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT 'New chat',
      model      TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content    TEXT NOT NULL,
      model      TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      chat_id UNINDEXED,
      msg_id UNINDEXED
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(content, chat_id, msg_id)
      VALUES (new.content, new.chat_id, new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE msg_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      UPDATE messages_fts SET content = new.content WHERE msg_id = old.id;
    END;

    -- Licensing tables
    CREATE TABLE IF NOT EXISTS email_whitelist (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL UNIQUE,
      name        TEXT,
      added_by    TEXT,
      created_at  INTEGER NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS machines (
      id              TEXT PRIMARY KEY,
      machine_id      TEXT NOT NULL,      -- OS machine ID (e.g., wmic csproduct get UUID)
      mac_addresses   TEXT NOT NULL,      -- JSON array of MAC addresses
      hardware_hash   TEXT NOT NULL,      -- SHA256 of combined hardware identifiers
      platform        TEXT NOT NULL,      -- win32, darwin, linux
      arch            TEXT NOT NULL,
      first_seen      INTEGER NOT NULL,
      last_seen       INTEGER NOT NULL,
      UNIQUE(machine_id)
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id              TEXT PRIMARY KEY,
      email           TEXT NOT NULL,
      machine_id      TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      machine_hash    TEXT NOT NULL,      -- Hardware hash at time of binding
      status          TEXT NOT NULL DEFAULT 'active', -- active, revoked, expired
      bound_at        INTEGER NOT NULL,
      last_validated  INTEGER,
      expires_at      INTEGER,            -- Optional expiration
      UNIQUE(email, machine_id)
    );
  `);

  ensureColumn('providers', 'key_sealed', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('providers', 'key_env', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('providers', 'tls_fingerprint', "TEXT NOT NULL DEFAULT ''");
}

// node:sqlite won't migrate column adds; ALTER defensively.
const columnCache = new Set();
function ensureColumn(table, col, ddl) {
  if (columnCache.has(`${table}.${col}`)) return;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((r) => r.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
  }
  columnCache.add(`${table}.${col}`);
}

function get() {
  if (!db) open();
  return db;
}

// ----- tiny helpers over DatabaseSync -----
function run(sql, ...params) { return get().prepare(sql).run(...params); }
function all(sql, ...params) { return get().prepare(sql).all(...params); }
function one(sql, ...params) { return get().prepare(sql).get(...params); }
function tx(fn) {
  const d = get();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; }
  catch (e) { d.exec('ROLLBACK'); throw e; }
}
function close() { if (db) { db.close(); db = null; } }
function integrityOk() {
  try { return one('PRAGMA quick_check').quick_check === 'ok'; } catch { return false; }
}

module.exports = { open, get, run, all, one, tx, close, integrityOk };
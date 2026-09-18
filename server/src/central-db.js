'use strict';
// Centralized Database Module
// Shared across all Ankur's projects: Calendar, PrepOrbit, LearnWithStories, ForgePrep, etc.
// Uses better-sqlite3 for performance, reliability, and synchronous API.

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

// ──────────────────────────────────────
// Centralized Data Directory
// ──────────────────────────────────────

/**
 * Returns the centralized data directory for all Ankur's apps.
 * Default: %APPDATA%/AnkurApps (Windows) or ~/.local/share/ankur-apps (Linux/macOS)
 * Override with ANKUR_APPS_DATA_DIR environment variable.
 */
function getCentralDataDir() {
  if (process.env.ANKUR_APPS_DATA_DIR) {
    return process.env.ANKUR_APPS_DATA_DIR;
  }
  const platform = os.platform();
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AnkurApps');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AnkurApps');
  }
  // Linux/Unix
  return path.join(os.homedir(), '.local', 'share', 'ankur-apps');
}

/**
 * Resolves a relative path to the centralized data directory.
 */
function resolveCentral(relative) {
  return path.isAbsolute(relative) ? relative : path.join(getCentralDataDir(), relative);
}

// ──────────────────────────────────────
// Database Connection Pool (Singleton per DB file)
// ──────────────────────────────────────

const dbPool = new Map();

/**
 * Opens (or returns cached) a database connection.
 * @param {string} dbName - Database filename (e.g., 'calendar.db', 'preporbit.db', 'central.db')
 * @param {object} options - Database options
 * @returns {Database} better-sqlite3 Database instance
 */
function openDatabase(dbName, options = {}) {
  const key = path.resolve(resolveCentral(dbName));
  
  if (dbPool.has(key)) {
    return dbPool.get(key);
  }

  // Ensure directory exists
  fs.mkdirSync(path.dirname(key), { recursive: true });

  const db = new Database(key, {
    readonly: options.readonly || false,
    fileMustExist: options.fileMustExist || false,
    timeout: options.timeout || 30000,
    verbose: options.verbose ? console.log : null,
  });

  // Pragmas for performance and safety
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 30000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456'); // 256MB

  // Enable FTS5 if available
  try {
    db.pragma('enable_fts5 = ON');
  } catch {}

  dbPool.set(key, db);
  return db;
}

/**
 * Closes a specific database connection.
 */
function closeDatabase(dbName) {
  const key = path.resolve(resolveCentral(dbName));
  const db = dbPool.get(key);
  if (db) {
    db.close();
    dbPool.delete(key);
  }
}

/**
 * Closes all database connections.
 */
function closeAllDatabases() {
  for (const [key, db] of dbPool) {
    db.close();
  }
  dbPool.clear();
}

// ──────────────────────────────────────
// Migration Framework
// ──────────────────────────────────────

const migrations = new Map();

/**
 * Registers a migration for a specific database.
 * @param {string} dbName - Database name
 * @param {number} version - Migration version (incremental)
 * @param {Function} up - Migration function (receives db instance)
 */
function registerMigration(dbName, version, up) {
  if (!migrations.has(dbName)) {
    migrations.set(dbName, new Map());
  }
  migrations.get(dbName).set(version, up);
}

/**
 * Runs all pending migrations for a database.
 */
function migrateDatabase(dbName) {
  const db = openDatabase(dbName);
  const dbMigrations = migrations.get(dbName);
  
  if (!dbMigrations || dbMigrations.size === 0) {
    return;
  }

  // Create migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM _migrations').all().map(r => r.version)
  );

  const versions = Array.from(dbMigrations.keys()).sort((a, b) => a - b);
  
  for (const version of versions) {
    if (applied.has(version)) continue;
    
    const up = dbMigrations.get(version);
    const tx = db.transaction(() => {
      up(db);
      db.prepare('INSERT INTO _migrations (version, applied_at, description) VALUES (?, ?, ?)')
        .run(version, Date.now(), `Migration ${version}`);
    });
    
    try {
      tx();
      console.log(`[central-db] Applied migration ${version} to ${dbName}`);
    } catch (e) {
      console.error(`[central-db] Migration ${version} failed for ${dbName}:`, e.message);
      throw e;
    }
  }
}

// ──────────────────────────────────────
// Helper Methods (consistent API)
// ──────────────────────────────────────

function run(dbName, sql, ...params) {
  return openDatabase(dbName).prepare(sql).run(...params);
}

function all(dbName, sql, ...params) {
  return openDatabase(dbName).prepare(sql).all(...params);
}

function one(dbName, sql, ...params) {
  return openDatabase(dbName).prepare(sql).get(...params);
}

function tx(dbName, fn) {
  const db = openDatabase(dbName);
  const transaction = db.transaction(fn);
  return transaction();
}

function prepare(dbName, sql) {
  return openDatabase(dbName).prepare(sql);
}

function exec(dbName, sql) {
  return openDatabase(dbName).exec(sql);
}

function backup(dbName, destPath) {
  const db = openDatabase(dbName);
  db.backup(destPath);
}

// ──────────────────────────────────────
// Pre-defined Schemas for Projects
// ──────────────────────────────────────

const SCHEMAS = {
  // Core schema shared by all apps
  core: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS settings (
        app_name TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (app_name, key)
      );
    `);
  },

  // ForgePrep / OpenSourceAPIHelper schema
  forgeprep: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        key_sealed TEXT NOT NULL DEFAULT '',
        key_env TEXT NOT NULL DEFAULT '',
        tls_fingerprint TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'openai',
        active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        UNIQUE(provider_id, model)
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New chat',
        model TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, chat_id UNINDEXED, msg_id UNINDEXED
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
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        added_by TEXT,
        created_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL UNIQUE,
        mac_addresses TEXT NOT NULL,
        hardware_hash TEXT NOT NULL,
        platform TEXT NOT NULL,
        arch TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS licenses (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
        machine_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        bound_at INTEGER NOT NULL,
        last_validated INTEGER,
        expires_at INTEGER,
        UNIQUE(email, machine_id)
      );
    `);
  },

  // Calendar App schema
  calendar: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS calendars (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT,
        email TEXT NOT NULL,
        provider TEXT NOT NULL, -- 'google', 'outlook', 'ical'
        access_token TEXT,
        refresh_token TEXT,
        token_expiry INTEGER,
        sync_enabled INTEGER NOT NULL DEFAULT 1,
        last_synced INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
        external_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        location TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        recurrence_rule TEXT,
        status TEXT DEFAULT 'confirmed',
        visibility TEXT DEFAULT 'default',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_calendar_time ON events(calendar_id, start_time, end_time);
      CREATE INDEX IF NOT EXISTS idx_events_external ON events(external_id);
    `);
  },

  // PrepOrbit / LearnWithStories schema
  edtech: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        avatar_url TEXT,
        role TEXT NOT NULL DEFAULT 'student', -- 'student', 'teacher', 'admin'
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        thumbnail_url TEXT,
        creator_id TEXT REFERENCES users(id),
        is_published INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT, -- Markdown/HTML content
        story_content TEXT, -- For LearnWithStories format
        order_index INTEGER NOT NULL DEFAULT 0,
        duration_minutes INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS enrollments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        progress REAL NOT NULL DEFAULT 0, -- 0-100
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, course_id)
      );

      CREATE TABLE IF NOT EXISTS lesson_progress (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
        completed INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER,
        time_spent_seconds INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, lesson_id)
      );

      CREATE TABLE IF NOT EXISTS exams (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        duration_minutes INTEGER,
        passing_score INTEGER NOT NULL DEFAULT 70,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        type TEXT NOT NULL, -- 'multiple_choice', 'true_false', 'short_answer', 'essay'
        question TEXT NOT NULL,
        options TEXT, -- JSON array for MCQ
        correct_answer TEXT,
        explanation TEXT,
        points INTEGER NOT NULL DEFAULT 1,
        order_index INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS exam_attempts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        score REAL,
        passed INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        answers TEXT -- JSON
      );
    `);
  },
};

// ──────────────────────────────────────
// Initialize Project Databases
// ──────────────────────────────────────

/**
 * Initializes a project database with its schema and runs migrations.
 */
function initProjectDatabase(dbName, schemaKey) {
  const db = openDatabase(dbName);
  const schema = SCHEMAS[schemaKey];
  
  if (schema) {
    schema(db);
  }
  
  // Run any registered migrations
  migrateDatabase(dbName);
  
  return db;
}

// ──────────────────────────────────────
// Convenience: Pre-configured DB Instances
// ──────────────────────────────────────

// Central shared database (for cross-app data like users, licenses, settings)
const centralDB = () => initProjectDatabase('central.db', 'core');

// ForgePrep / OpenSourceAPIHelper database
const forgeprepDB = () => initProjectDatabase('forgeprep.db', 'forgeprep');

// Calendar App database
const calendarDB = () => initProjectDatabase('calendar.db', 'calendar');

// EdTech (PrepOrbit, LearnWithStories) database
const edtechDB = () => initProjectDatabase('edtech.db', 'edtech');

// ──────────────────────────────────────
// Utility: Column Management (like original db.js)
// ──────────────────────────────────────

function ensureColumn(dbName, table, col, ddl) {
  const db = openDatabase(dbName);
  const cacheKey = `${dbName}.${table}.${col}`;
  if (!global.__columnCache) global.__columnCache = new Set();
  if (global.__columnCache.has(cacheKey)) return;
  
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((r) => r.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
  }
  global.__columnCache.add(cacheKey);
}

// ──────────────────────────────────────
// Exports
// ──────────────────────────────────────

module.exports = {
  // Core functions
  openDatabase,
  closeDatabase,
  closeAllDatabases,
  registerMigration,
  migrateDatabase,
  
  // Query helpers
  run,
  all,
  one,
  tx,
  prepare,
  exec,
  backup,
  ensureColumn,
  
  // Schema & init
  SCHEMAS,
  initProjectDatabase,
  
  // Pre-configured DBs
  centralDB,
  forgeprepDB,
  calendarDB,
  edtechDB,
  
  // Path utilities
  getCentralDataDir,
  resolveCentral,
  
  // Raw access
  Database,
};
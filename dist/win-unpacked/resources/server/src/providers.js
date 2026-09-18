'use strict';
// Provider registry: CRUD, redacted views, test+discover->register, activation.
// Secrets live only as ciphertext (vault) in the DB; wire/API expose masks.

const crypto = require('crypto');
const db = require('./db');
const { normalizeBase, discoverModels } = require('./openai');
const { maskKey, audit } = require('./util');
const vault = require('./crypto');
const {
  providerNotFound,
  providerInvalidUrl,
  providerInvalidKey,
  providerTestFailed,
  modelNotFound,
  internalError,
  validationFailed,
  asyncHandler,
  validateApiKey,
} = require('./errors');

const uid = () => crypto.randomUUID();
const now = () => Date.now();

function publicView(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    key_masked: row.key_sealed ? maskKey(vault.decrypt(row.key_sealed)) : '',
    has_key: !!row.key_sealed || !!row.key_env,
    key_env: row.key_env,
    tls_fingerprint: row.tls_fingerprint || '',
    type: row.type,
    active: !!row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function create({ name, baseUrl, apiKey = '', keyEnv = '', tlsFingerprint = '' }) {
  validationFailed(name && String(name).trim(), 'Provider name is required', 'name');
  let base;
  try {
    base = normalizeBase(baseUrl);
  } catch (e) {
    throw providerInvalidUrl(baseUrl);
  }
  if (apiKey) {
    try {
      validateApiKey(apiKey);
    } catch (e) {
      throw providerInvalidKey('apiKey');
    }
  }
  const id = uid();
  const t = now();
  db.run(
    `INSERT INTO providers (id, name, base_url, key_sealed, key_env, tls_fingerprint, type, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'openai', 0, ?,?)`,
    id, name, base, vault.encrypt(apiKey), keyEnv, tlsFingerprint, t, t,
  );
  audit('provider_create', { id, name, base_url: base, has_key: !!apiKey, key_env: keyEnv || null, tls_fingerprint: tlsFingerprint || null });
  return getById(id);
}

function list() {
  return db.all('SELECT * FROM providers ORDER BY created_at ASC').map(publicView);
}

function getById(id) {
  return publicView(db.one('SELECT * FROM providers WHERE id = ?', id));
}

// Load a provider INCLUDING its decrypted key (server-internal only, never
// returned to the client/logs; used by chat/proxy/test).
function loadWithKey(id) {
  if (!id) return null;
  const row = db.one('SELECT * FROM providers WHERE id = ?', String(id));
  if (!row) return null;
  const p = {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    key: row.key_sealed ? vault.decrypt(row.key_sealed) : '',
    key_env: row.key_env,
    tls_fingerprint: row.tls_fingerprint || '',
    type: row.type,
  };
  if (!p.key && p.key_env && process.env[p.key_env]) p.key = process.env[p.key_env];
  return p;
}

// Merge-on-edit: only fields provided are updated; blanks without explicit
// intent to clear keep prior value. Fixes the stale-provider-clobber bug class.
function update(id, patch) {
  const row = db.one('SELECT * FROM providers WHERE id = ?', id);
  if (!row) throw providerNotFound(id);

  let base = row.base_url;
  let sealed = row.key_sealed;
  let env = row.key_env;
  let tlsFp = row.tls_fingerprint;

  if (patch.baseUrl !== undefined && patch.baseUrl !== '') {
    try {
      base = normalizeBase(patch.baseUrl);
    } catch (e) {
      throw providerInvalidUrl(patch.baseUrl);
    }
  }
  if (patch.name !== undefined && patch.name !== '') {
    validationFailed(patch.name, 'Provider name is required', 'name');
  }
  const keyChanged = patch.apiKey !== undefined && patch.apiKey !== '';
  const keyCleared = patch.apiKey === '';
  if (keyChanged) {
    try {
      validateApiKey(patch.apiKey);
    } catch (e) {
      throw providerInvalidKey('apiKey');
    }
    sealed = vault.encrypt(patch.apiKey);
  } else if (keyCleared) {
    sealed = ''; // explicit clear
  }
  if (patch.keyEnv !== undefined) env = patch.keyEnv;
  if (patch.tlsFingerprint !== undefined) tlsFp = patch.tlsFingerprint;
  const name = patch.name || row.name;

  db.run(
    'UPDATE providers SET name=?, base_url=?, key_sealed=?, key_env=?, tls_fingerprint=?, updated_at=? WHERE id=?',
    name, base, sealed, env, tlsFp, now(), id,
  );
  audit('provider_update', { id, name, base_url: base, key_changed: keyChanged, key_cleared: keyCleared, key_env: env, tls_fingerprint: tlsFp || null });
  return getById(id);
}

function remove(id) {
  db.run('DELETE FROM providers WHERE id = ?', id);
  audit('provider_delete', { id });
}

function setActive(id) {
  db.tx(() => {
    db.run('UPDATE providers SET active = 0');
    if (id) db.run('UPDATE providers SET active = 1 WHERE id = ?', id);
  });
  audit('provider_activate', { id });
}

function activeProvider() {
  return loadWithKey(db.one('SELECT id FROM providers WHERE active = 1')?.id);
}

const { createVerifyingFetch } = require('./openai');

// Test connection; on success discover + register models so they appear in the
// picker immediately (Req 6).
async function testAndRegister(id) {
  const p = loadWithKey(id);
  if (!p) throw providerNotFound(id);
  if (!p.key) throw providerTestFailed('No API key configured');
  const fetchFn = createVerifyingFetch(p.tls_fingerprint);
  try {
    const models = await discoverModels(p.base_url, p.key, { fetch: fetchFn });
    const created = [];
    db.tx(() => {
      for (const m of models) {
        db.run(
          `INSERT OR IGNORE INTO models (id, provider_id, model, meta, created_at)
           VALUES (?,?,?, '{}', ?)`,
          uid(), id, m, now(),
        );
        created.push(m);
      }
    });
    db.run('UPDATE providers SET updated_at=? WHERE id=?', now(), id);
    audit('provider_test', { id, models: created, model_count: created.length });
    return { ok: true, models: created };
  } catch (e) {
    audit('provider_test_failed', { id, error: e.message });
    throw providerTestFailed(e.message);
  }
}

function listModels(providerId = null) {
  const rows = providerId
    ? db.all('SELECT * FROM models WHERE provider_id = ? ORDER BY model', providerId)
    : db.all(
        `SELECT m.*, p.name provider_name, p.active provider_active
           FROM models m JOIN providers p ON p.id = m.provider_id
          ORDER BY p.active DESC, m.model`,
      );
  return rows.map((r) => ({
    id: r.id,
    model: r.model,
    provider_id: r.provider_id,
    provider_name: r.provider_name,
    provider_active: providerId ? undefined : !!r.provider_active,
  }));
}

// Key rotation: replaces the sealed key, increments a version counter in meta, and audits.
function rotateKey(id, newApiKey) {
  const row = db.one('SELECT * FROM providers WHERE id = ?', id);
  if (!row) throw providerNotFound(id);
  try {
    validateApiKey(newApiKey);
  } catch (e) {
    throw providerInvalidKey('apiKey');
  }
  const sealed = vault.encrypt(newApiKey);
  db.run('UPDATE providers SET key_sealed=?, updated_at=? WHERE id=?', sealed, now(), id);
  // Track rotation version in meta
  const versionKey = `provider:${id}:key_version`;
  const current = db.one("SELECT value FROM meta WHERE key=?", versionKey);
  const version = current ? parseInt(current.value, 10) + 1 : 1;
  db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", versionKey, String(version));
  audit('provider_key_rotate', { id, version });
  return getById(id);
}

module.exports = {
  create, list, getById, loadWithKey, update, remove,
  setActive, activeProvider, testAndRegister, listModels,
  rotateKey,
};
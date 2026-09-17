'use strict';
// Master key custody. Priority:
//   1. environent OSAH_MASTER_KEY  (production / service account)
//   2. file  .masterkey            (created 0600 / ACL-guarded on first run)
// Documented in ADR-010 as the passphrase/file fallback for the headless
// service. The Electron wrapper may substitute `safeStorage` encryption of
// this key before writing it at rest; the interface stays the same.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

function existingEnvKey() {
  return process.env.OSAH_MASTER_KEY || null;
}

// Create the data dir with restrictive permissions where the platform allows.
function ensureDataDir() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
}

function secureWrite(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

// Load or generate the master key. Never exposed; only a 256-bit Buffer.
function getMasterKey() {
  const env = existingEnvKey();
  if (env) {
    const buf = Buffer.from(env.slice(0, 64), 'hex');
    if (buf.length === 32) return buf;
  }
  ensureDataDir();
  const file = config.MASTER_KEY_FILE;
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const buf = Buffer.from(raw, 'hex');
    if (buf.length !== 32) {
      throw new Error('master key file corrupt (expected 32 bytes hex)');
    }
    return buf;
  }
  const key = crypto.randomBytes(32);
  try {
    secureWrite(file, key.toString('hex'));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Lost a race; the other writer's key is already in place — use it.
    const raw = fs.readFileSync(file, 'utf8').trim();
    return Buffer.from(raw, 'hex');
  }
  return key;
}

module.exports = { getMasterKey, ensureDataDir };
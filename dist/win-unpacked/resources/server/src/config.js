'use strict';
// Paths, ports, and app constants. Centralized so the whole app stays
// relocatable and the service/UI can agree on a loopback contract.

const path = require('path');
const os = require('os');

// Where runtime data (sqlite, master key, logs) lives.
// - Default app-data root for this product on this OS.
// - Overridable via OSAH_DATA_DIR (used by tests and the packaged service).
function defaultDataDir() {
  if (process.env.OSAH_DATA_DIR) return process.env.OSAH_DATA_DIR;
  const platform = os.platform();
  // Windows: %APPDATA%\OpenSourceAPIHelper ; else macOS/Linux convention.
  const root =
    process.env.APPDATA ||
    (os.homedir() + (platform === 'darwin'
      ? '/Library/Application Support'
      : '/.config'));
  return path.join(root, 'OpenSourceAPIHelper');
}

function resolve(relative) {
  return path.isAbsolute(relative)
    ? relative
    : path.join(defaultDataDir(), relative);
}

module.exports = {
  APP_NAME: 'OpenSourceAPIHelper',
  SERVICE_PORT: Number(process.env.OSAH_PORT || 8787),
  HOST: process.env.OSAH_HOST || '127.0.0.1',
  DATA_DIR: defaultDataDir(),
  DB_PATH: resolve(process.env.OSAH_DB || 'osah.sqlite'),
  MASTER_KEY_FILE: resolve(process.env.OSAH_KEY_FILE || '.masterkey'),
  AUDIT_LOG: resolve(process.env.OSAH_AUDIT || 'logs/audit.log'),
  MAX_BODY: '2mb',
  // If set by the environment, clients must send it as X-OSAH-Token.
  // Loopback binding is the primary protection; this is defense-in-depth.
  AUTH_TOKEN: process.env.OSAH_TOKEN || null,
};
'use strict';
// Boot entry. Initializes storage + vault, starts the loopback service.
// This file is what the Windows Service / macOS LaunchAgent launches.

const config = require('./config');
const db = require('./db');
const keystore = require('./keystore');
const { createApp } = require('./app');

async function main() {
  keystore.ensureDataDir();
  db.open();

  const app = createApp();
  const server = app.listen(config.SERVICE_PORT, config.HOST, () => {
    console.log(`[osah] service up on http://${config.HOST}:${config.SERVICE_PORT}`);
    console.log(`[osah] data dir: ${config.DATA_DIR}`);
    console.log(`[osah] db integrity: ${db.integrityOk() ? 'ok' : 'DAMAGED'}`);
  });

  const shutdown = (sig) => {
    console.log(`[osah] ${sig} — closing`);
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Defense-in-depth: never silently die on a stray async rejection.
  process.on('unhandledRejection', (reason) => console.error('[osah] unhandledRejection', reason && reason.message || reason));
  process.on('uncaughtException', (err) => { console.error('[osah] uncaughtException', err && err.message); });

  return server;
}

if (require.main === module) {
  main().catch((e) => { console.error('[osah] fatal', e); process.exit(1); });
}

module.exports = { main };
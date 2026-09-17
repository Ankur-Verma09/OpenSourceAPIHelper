'use strict';
// Dev boot: loads provider keys from an external env file by name (key_env
// indirection) without ever printing them, then starts the service on the
// configured data dir. For local Q&A of the full key pipeline only.
const fs = require('fs');
const path = require('path');

const envFile = process.env.OSAH_SRC_ENV_DIR
  ? path.join(process.env.OSAH_SRC_ENV_DIR, '.env')
  : null;
if (envFile && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
require('../server/src/index').main().catch((e) => { console.error('[osah] fatal', e); process.exit(1); });
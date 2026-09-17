'use strict';
// Diagnose: for-await over res.body (direct) vs Readable.fromWeb.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const envFile = process.env.OSAH_SRC_ENV_DIR ? path.join(process.env.OSAH_SRC_ENV_DIR, '.env') : null;
if (envFile && fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = l.trim().match(/^([\w]+)=([^\r]*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
require('../server/src/db').open();
const { loadWithKey } = require('../server/src/providers');

(async () => {
  const p = loadWithKey(process.argv[2]);
  const mt = Number(process.argv[4] || 16);
  const body = JSON.stringify({ model: process.argv[3], messages: [{ role: 'user', content: 'Say K only.' }], max_tokens: mt, stream: true });
  const doFetch = () => fetch(`${p.base_url}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` }, body,
  });

  // method A: direct for-await over res.body
  {
    const res = await doFetch(); console.error('A HTTP', res.status);
    let a = 0;
    try { for await (const b of res.body) a += b.length; } catch (e) { console.error('A err', e.message); }
    console.error('A) direct for-await bytes =', a);
  }

  // method B: Readable.fromWeb
  {
    const res = await doFetch(); console.error('B HTTP', res.status);
    await new Promise((r, j) => {
      let n = 0, s = '';
      const st = Readable.fromWeb(res.body);
      st.on('data', (c) => { n += c.length; s += c.toString('utf8'); });
      st.on('end', () => { console.error('B) Readable.fromWeb bytes =', n, ' contains K?', s.includes('K')); r(); });
      st.on('error', (e) => { console.error('B err', e.message); j(); });
    });
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
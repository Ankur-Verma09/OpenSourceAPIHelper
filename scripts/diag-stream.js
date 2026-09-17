'use strict';
// Diagnostic: stream raw upstream SSE from the provider to a file, so we can
// see the exact frame shape (models differ: reasoning_content, no content, etc).
const fs = require('fs');
const path = require('path');

const envFile = process.env.OSAH_SRC_ENV_DIR
  ? path.join(process.env.OSAH_SRC_ENV_DIR, '.env') : null;
if (envFile && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
require('../server/src/db').open();
const { loadWithKey } = require('../server/src/providers');

const PROVIDER = process.argv[2];
const MODEL = process.argv[3];
const OUT = process.argv[4] || '.runtime/raw-stream.txt';

(async () => {
  const p = loadWithKey(PROVIDER);
  if (!p) { console.error('no provider'); process.exit(1); }
  const res = await fetch(`${p.base_url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly: STREAM_OK' }],
      max_tokens: 64, stream: true,
    }),
  });
  console.error('HTTP', res.status, res.statusText);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf.toString('utf8'));
  // summary: count data frames + which keys each JSON carries
  const frames = buf.toString('utf8').split('\n\n').map((s) => s.trim()).filter((s) => s.startsWith('data:'));
  const shapes = new Set();
  for (const f of frames) {
    const j = JSON.parse(f.slice(5).trim());
    shapes.add(JSON.stringify({
      keys: Object.keys(j), choice_keys: Object.keys((j.choices && j.choices[0]) || {}),
      delta_keys: Object.keys((j.choices && j.choices[0] && j.choices[0].delta) || {}),
      has_reasoning: !!(j.choices && j.choices[0] && (j.choices[0].delta && j.choices[0].delta.reasoning_content)),
      has_content: !!(j.choices && j.choices[0] && (j.choices[0].delta && j.choices[0].delta.content)),
    }));
  }
  console.error('data frames:', frames.length);
  console.error('distinct shapes:');
  for (const s of shapes) console.error('  ', s);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
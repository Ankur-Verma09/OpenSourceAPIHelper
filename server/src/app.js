'use strict';
// Express app: JSON API + optional /v1 OpenAI-compatible proxy + static client.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const api = require('./api');
const { normalizeBase } = require('./openai');
const prov = require('./providers');
const { redactHeaders } = require('./util');

function timingSafeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: false })); // same-origin desktop; no CORS needed
  app.use(express.json({ limit: config.MAX_BODY }));

  // Defense-in-depth loopback token (Req/FR-13). Optional; loopback bind is primary.
  app.use((req, res, next) => {
    if (!config.AUTH_TOKEN) return next();
    const tok = req.get('X-OSAH-Token');
    if (tok && timingSafeEq(tok, config.AUTH_TOKEN)) return next();
    res.status(401).json({ error: 'unauthorized' });
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, up: Date.now() }));

  // /v1/* OpenAI-compatible proxy to the active provider (consumable by QA tools)
  app.use('/v1', async (req, res) => {
    try {
      const p = prov.activeProvider();
      if (!p || !p.key) return res.status(503).json({ error: 'no active provider configured' });
      res.removeHeader('X-Powered-By');
      const target = `${normalizeBase(p.base_url)}${req.originalUrl.replace(/^\/v1/, '')}`;
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${p.key}`,
        },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      });
      const ct = upstream.headers.get('content-type') || '';
      if (ct.includes('text/event-stream')) {
        res.writeHead(upstream.status, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        for await (const buf of upstream.body) res.write(Buffer.from(buf));
        return res.end();
      }
      const text = await upstream.text();
      res.status(upstream.status).type(ct).send(text);
    } catch (e) {
      res.status(502).json({ error: e && e.message });
    }
  });

  app.use('/api', api);

  // Static client (built React app) — optional if present.
  const dist = path.join(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(dist));
  app.get(/^\/(?!api|v1).*/, (req, res) => {
    res.sendFile(path.join(dist, 'index.html'), (err) => {
      if (err) res.status(404).json({ error: 'client not built — run: npm run build' });
    });
  });

  return app;
}

module.exports = { createApp };
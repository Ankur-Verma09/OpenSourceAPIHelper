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
const {
  errorHandler,
  asyncHandler,
  validateInput,
  authFailed,
  csrfFailed,
  rateLimited,
  internalError,
  upstreamUnavailable,
  upstreamError,
} = require('./errors');

function timingSafeEq(a, b) {
  if (!a || !b) return false;
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false); // Explicit: we bind to loopback, no reverse proxy
  app.use(cors({ origin: false })); // same-origin desktop; no CORS needed
  app.use(express.json({ limit: config.MAX_BODY }));

  // Defense-in-depth loopback token (Req/FR-13). Optional; loopback bind is primary.
  app.use((req, res, next) => {
    if (!config.AUTH_TOKEN) return next();
    const tok = req.get('X-OSAH-Token');
    if (tok && timingSafeEq(tok, config.AUTH_TOKEN)) return next();
    return next(authFailed());
  });

  // CSRF protection for mutating endpoints (double-submit header pattern)
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const csrf = req.get('X-OSAH-CSRF');
      if (!csrf) return next(csrfFailed());
    }
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, up: Date.now() }));

  // /v1/* OpenAI-compatible proxy to the active provider (consumable by QA tools)
  // Rate limiting: simple token bucket per provider key (in-memory, resets on restart)
  const v1RateLimit = new Map(); // key -> { tokens, lastRefill }
  const V1_RATE_LIMIT = 60; // requests per minute
  const V1_REFILL_RATE = V1_RATE_LIMIT / 60000; // tokens per ms

  function checkV1RateLimit(key) {
    const now = Date.now();
    const entry = v1RateLimit.get(key) || { tokens: V1_RATE_LIMIT, lastRefill: now };
    const elapsed = now - entry.lastRefill;
    entry.tokens = Math.min(V1_RATE_LIMIT, entry.tokens + elapsed * V1_REFILL_RATE);
    if (entry.tokens < 1) return false;
    entry.tokens -= 1;
    entry.lastRefill = now;
    v1RateLimit.set(key, entry);
    return true;
  }

  app.use('/v1', (req, res, next) => {
    const key = req.get('X-OSAH-Token') || req.ip || 'anonymous';
    if (!checkV1RateLimit(key)) {
      return next(rateLimited(60));
    }
    next();
  });

  app.use('/v1', asyncHandler(async (req, res) => {
    const p = prov.activeProvider();
    if (!p || !p.key) {
      return res.status(503).json({ error: 'No active provider configured — add a provider in Settings and activate it' });
    }
    res.removeHeader('X-Powered-By');
    const target = `${normalizeBase(p.base_url)}${req.originalUrl.replace(/^\/v1/, '')}`;
    try {
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
      // Map network errors to user-friendly messages
      if (e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND' || e?.code === 'ETIMEDOUT') {
        throw upstreamUnavailable();
      }
      if (e?.message?.includes('certificate') || e?.message?.includes('CERT') || e?.message?.includes('TLS')) {
        const { tlsVerificationFailed } = require('./errors');
        throw tlsVerificationFailed(e.message);
      }
      if (e?.message?.includes('private') || e?.message?.includes('loopback') || e?.message?.includes('blocked')) {
        const { ssrfBlocked } = require('./errors');
        throw ssrfBlocked(p.base_url);
      }
      throw internalError(e, { path: req.path, method: req.method });
    }
  }));

  app.use('/api', api);

  // Static client (built React app) — optional if present.
  const dist = path.join(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(dist));
  app.get(/^\/(?!api|v1).*/, (req, res) => {
    res.sendFile(path.join(dist, 'index.html'), (err) => {
      if (err) res.status(404).json({ error: 'client not built — run: npm run build' });
    });
  });

  // Global error handler — must be last
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
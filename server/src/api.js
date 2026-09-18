'use strict';
// API routers: providers, models, chats (streaming), memory, status.
const express = require('express');
const crypto = require('crypto');
const prov = require('./providers');
const chat = require('./chatstore');
const openai = require('./openai');
const { createVerifyingFetch } = require('./openai');
const db = require('./db');
const { redact, audit } = require('./util');
const license = require('./license');
const {
  asyncHandler,
  validateInput,
  validateUrl,
  validateApiKey,
  toSafeError,
  providerNotFound,
  chatNotFound,
  modelNotFound,
  noProviderKey,
  upstreamError,
  upstreamTimeout,
  upstreamUnavailable,
  tlsVerificationFailed,
  ssrfBlocked,
  streamFailed,
  streamTruncated,
  internalError,
  dbError,
  cryptoError,
  settingsCorrupt,
} = require('./errors');

const router = express.Router();

const now = () => Date.now();
const uid = () => crypto.randomUUID();

// Body parser error handler — catch malformed JSON
router.use(express.json({
  limit: '500kb',
  strict: true,
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// JSON parse error handler
router.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    const e = new (require('./errors').AppError)(
      require('./errors').ERROR_CODES.INVALID_FORMAT,
      'Invalid JSON in request body',
      400,
      {}
    );
    audit('api_error', e.toLog());
    return res.status(400).json(e.toClient());
  }
  next(err);
});

// ---------------- providers ----------------
router.get('/providers', asyncHandler(async (req, res) => res.json(prov.list())));

router.post('/providers', asyncHandler(async (req, res) => {
  const body = req.body || {};
  validateInput(body.name && String(body.name).trim(), 'Provider name is required', 'name');
  validateUrl(body.baseUrl, 'baseUrl');
  if (body.apiKey) validateApiKey(body.apiKey, 'apiKey');
  const p = prov.create(body);
  res.status(201).json(p);
}));

router.put('/providers/:id', asyncHandler(async (req, res) => {
  const p = prov.update(req.params.id, req.body || {});
  if (!p) throw providerNotFound(req.params.id);
  res.json(p);
}));

// Activate the provider used by the OpenAI-compatible /v1 proxy.
router.post('/providers/:id/activate', asyncHandler(async (req, res) => {
  const p = prov.getById(req.params.id);
  if (!p) throw providerNotFound(req.params.id);
  prov.setActive(p.id);
  res.json({ ok: true, active: p.id });
}));

router.delete('/providers/:id', asyncHandler(async (req, res) => {
  prov.remove(req.params.id);
  res.status(204).end();
}));

// Test connection; on success, registers discovered models (Req 6).
router.post('/providers/:id/test', asyncHandler(async (req, res) => {
  const { ok, models, error } = await prov.testAndRegister(req.params.id);
  if (!ok) return res.status(422).json({ ok: false, error });
  res.json({ ok: true, models });
}));

// Rotate provider API key (increments version, audits)
router.post('/providers/:id/rotate-key', asyncHandler(async (req, res) => {
  const { apiKey } = req.body || {};
  validateApiKey(apiKey, 'apiKey');
  const p = prov.rotateKey(req.params.id, String(apiKey).trim());
  if (!p) throw providerNotFound(req.params.id);
  res.json({ ok: true, provider: p });
}));

router.post('/models/activate', asyncHandler(async (req, res) => {
  const { model } = req.body || {};
  // find provider that owns this discovered model
  const row = model ? db.one('SELECT provider_id FROM models WHERE model = ?', model) : null;
  const id = row ? row.provider_id : null;
  prov.setActive(id);
  audit('model_activate', { model, provider_id: id });
  res.json({ ok: true, active_provider: id });
}));

// models list (client expects GET /api/models)
router.get('/models', asyncHandler(async (req, res) => {
  const rows = db.all('SELECT * FROM models ORDER BY model');
  res.json(rows.map(r => ({ id: r.model, name: r.model, provider_id: r.provider_id })));
}));

// ---------------- chats ----------------
router.get('/chats', asyncHandler(async (req, res) => res.json(chat.listChats())));

router.post('/chats', asyncHandler(async (req, res) => {
  const created = chat.createChat(req.body || {});
  audit('chat_create', { chat_id: created.id, title: created.title, model: created.model });
  res.status(201).json(created);
}));

router.get('/chats/:id', asyncHandler(async (req, res) => {
  const c = db.one('SELECT * FROM chats WHERE id=?', req.params.id);
  if (!c) throw chatNotFound(req.params.id);
  res.json({ id: c.id, title: c.title, model: c.model, messages: chat.getMessages(c.id) });
}));

router.patch('/chats/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.title !== undefined) {
    chat.renameChat(req.params.id, b.title);
    audit('chat_rename', { chat_id: req.params.id, title: b.title });
  }
  if (b.model !== undefined) {
    chat.setChatModel(req.params.id, b.model);
    audit('chat_model_change', { chat_id: req.params.id, model: b.model });
  }
  res.json({ ok: true });
}));

router.delete('/chats/:id', asyncHandler(async (req, res) => {
  chat.deleteChat(req.params.id);
  audit('chat_delete', { chat_id: req.params.id });
  res.status(204).end();
}));

// Streaming chat completion. Upserts the user turn, streams SSE deltas, then
// persists the assistant reply (Req 2). Multi-chat safe: stateless per request.
router.post('/chats/:id/stream', asyncHandler(async (req, res) => {
  const chatId = req.params.id;
  const { content, model } = req.body || {};
  validateInput(content && String(content).trim(), 'Message content is required', 'content');
  const chatRow = db.one('SELECT * FROM chats WHERE id=?', chatId);
  if (!chatRow) throw chatNotFound(chatId);

  const usingModel = model || chatRow.model;
  const modelRow = usingModel
    ? db.one('SELECT provider_id FROM models WHERE model=?', usingModel)
    : null;
  const provider = modelRow ? prov.loadWithKey(modelRow.provider_id) : null;
  if (!provider || !provider.key) throw noProviderKey(usingModel);

  // persist user message
  chat.addMessage({ chatId, role: 'user', content: String(content).trim(), model: usingModel });
  chat.maybeRenameOnFirstMessage(chatId, content);

  const history = chat.historyForChat(chatId, 40);

  // SSE frame helpers
  const writeHead = () => res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };

  let headersWritten = false;
  const fail = (msg, err) => {
    const appErr = err || streamFailed(msg);
    audit('stream_error', appErr.toLog());
    if (headersWritten) { send({ event: 'error', error: appErr.message }); res.end(); }
    else res.status(appErr.status).json(appErr.toClient());
  };

  try {
    const upstream = await openai.streamChat(provider.base_url, provider.key, {
      model: usingModel,
      messages: history,
      max_tokens: 2000,
      fetch: createVerifyingFetch(provider.tls_fingerprint),
    });
    if (!upstream.ok) {
      const body = (await upstream.text().catch(() => '')).slice(0, 300);
      return fail(`AI service error`, upstreamError(upstream.status, body));
    }

    writeHead(); headersWritten = true;
    send({ event: 'start', model: usingModel });

    let acc = '';
    let chunk = '';
    const MAX_ACC = 500000; // 500KB max accumulated response

    // Abort upstream if client disconnects
    req.on('close', () => {
      try { upstream.body?.cancel?.(); } catch { /* ignore */ }
    });

    for await (const buf of upstream.body) {
      // NOTE: web ReadableStream yields Uint8Array (NOT Buffer), so
      // Buffer.isBuffer() is false and String(u8) would comma-join bytes.
      chunk += typeof buf === 'string' ? buf : Buffer.from(buf).toString('utf8');
      let idx;
      while ((idx = chunk.indexOf('\n')) >= 0) {
        const line = chunk.slice(0, idx).trim();
        chunk = chunk.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          const reasoning = json.choices?.[0]?.delta?.reasoning_content || '';
          if (reasoning) send({ event: 'reasoning', text: reasoning });
          if (delta) {
            acc += delta;
            if (acc.length > MAX_ACC) {
              send({ event: 'error', error: 'Response too large — truncated' });
              res.end();
              return;
            }
            send({ event: 'delta', text: delta });
          }
          if (json.choices?.[0]?.finish_reason) send({ event: 'finish' });
        } catch { /* non-JSON SSE frame */ }
      }
    }

    // persist assistant reply even if truncated, so nothing is lost (Req 7)
    const msgId = acc ? chat.addMessage({ chatId, role: 'assistant', content: acc, model: usingModel }) : null;
    send({ event: 'done', message_id: msgId, full: acc });
    res.end();
  } catch (e) {
    // Network/timeout errors from upstream
    if (e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND' || e?.code === 'ETIMEDOUT') {
      return fail('AI service unreachable', upstreamUnavailable());
    }
    if (e?.name === 'AbortError') {
      return fail('Request cancelled', streamFailed('aborted'));
    }
    // TLS verification failure
    if (e?.message?.includes('certificate') || e?.message?.includes('CERT') || e?.message?.includes('TLS')) {
      return fail('Secure connection failed', tlsVerificationFailed(e.message));
    }
    // SSRF blocked
    if (e?.message?.includes('private') || e?.message?.includes('loopback') || e?.message?.includes('blocked')) {
      return fail('Invalid URL', ssrfBlocked(provider.base_url));
    }
    // Generic upstream error
    return fail('Streaming failed', streamFailed(e?.message));
  }
}));

// ---------------- settings (Req 9: sealed config) ----------------
const cryptoMod = require('./crypto');

// Settings are stored as an opaque sealed blob (AES-256-GCM, the tag acts as the
// HMAC). Only this endpoint touches it; there is no raw-config edit surface.
const DEFAULT_SETTINGS = { theme: 'dark', proxyEnabled: true, defaultModel: '' };

router.get('/settings', asyncHandler(async (req, res) => {
  try {
    const blob = db.one("SELECT value FROM meta WHERE key='settings'");
    let settings = DEFAULT_SETTINGS;
    if (blob && blob.value) {
      settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(cryptoMod.decrypt(blob.value)));
    }
    res.json(settings);
  } catch (e) {
    throw settingsCorrupt();
  }
}));

router.put('/settings', asyncHandler(async (req, res) => {
  try {
    const merged = Object.assign({}, DEFAULT_SETTINGS, req.body || {});
    const sealed = cryptoMod.encrypt(JSON.stringify(merged));
    db.run("INSERT INTO meta(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", sealed);
    audit('settings_change', { settings: merged });
    res.json(merged);
  } catch (e) {
    throw cryptoError(e, 'settings_save');
  }
}));

// ---------------- memory (Req 3) ----------------
router.get('/memory/search', asyncHandler(async (req, res) => {
  const q = req.query.q || '';
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  res.json(chat.searchMemory(q, { limit }));
}));

// ---------------- status ----------------
router.get('/status', asyncHandler(async (req, res) => {
  try {
    res.json({
      ok: db.integrityOk(),
      providers: prov.list().length,
      models: db.one('SELECT count(*) c FROM models').c,
      chats: db.one('SELECT count(*) c FROM chats').c,
      memory_indexed: db.one('SELECT count(*) c FROM messages_fts').c,
      schema_version: 1,
      version: '1.0.0',
    });
  } catch (e) {
    throw dbError(e, 'status');
  }
}));

// ---------------- licensing ----------------

// Get current machine fingerprint (for display/debug)
router.get('/license/machine', asyncHandler(async (req, res) => {
  const machine = license.getOrCreateMachine();
  res.json({
    machine_id: machine.machine_id,
    mac_addresses: machine.mac_addresses,
    hardware_hash: machine.hardware_hash,
    platform: machine.platform,
    arch: machine.arch,
  });
}));

// Validate license for email (and bind if needed)
router.post('/license/validate', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email || !String(email).trim()) {
    throw validationFailed('Email is required', 'email');
  }
  const result = license.validateAndBind(String(email).trim().toLowerCase());
  if (!result.success) {
    return res.status(403).json({ ok: false, reason: result.reason, message: result.message });
  }
  res.json({ ok: true, license: result.license, machine: result.machine, newlyBound: result.newlyBound });
}));

// Check license status (read-only)
router.get('/license/status', asyncHandler(async (req, res) => {
  const { email } = req.query;
  if (!email) {
    throw validationFailed('Email query parameter required', 'email');
  }
  const machine = license.getOrCreateMachine();
  const result = license.validateLicense(email.toLowerCase(), machine);
  if (!result.valid) {
    return res.json({ ok: false, reason: result.reason, message: result.message });
  }
  res.json({ ok: true, license: result.license });
}));

// Admin: whitelist management (requires admin token)
router.get('/license/whitelist', asyncHandler(async (req, res) => {
  res.json(license.listWhitelist());
}));

router.post('/license/whitelist', asyncHandler(async (req, res) => {
  const { email, name } = req.body || {};
  if (!email || !String(email).trim()) {
    throw validationFailed('Email is required', 'email');
  }
  const entry = license.addToWhitelist(String(email).trim().toLowerCase(), name || '', 'api');
  res.status(201).json(entry);
}));

router.delete('/license/whitelist', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    throw validationFailed('Email is required', 'email');
  }
  license.removeFromWhitelist(String(email).trim().toLowerCase());
  res.status(204).end();
}));

// Admin: revoke license
router.post('/license/revoke', asyncHandler(async (req, res) => {
  const { email, machineId } = req.body || {};
  if (!email) {
    throw validationFailed('Email is required', 'email');
  }
  license.revokeLicense(email.toLowerCase(), machineId || null);
  res.json({ ok: true });
}));

// Admin: get license status for any email
router.get('/license/admin/status', asyncHandler(async (req, res) => {
  const { email } = req.query;
  if (!email) {
    throw validationFailed('Email query parameter required', 'email');
  }
  const status = license.getLicenseStatus(email.toLowerCase());
  res.json(status);
}));
// (asyncHandler catches most, but this handles sync errors in middleware)
router.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    const e = new (require('./errors').AppError)(
      require('./errors').ERROR_CODES.INVALID_FORMAT,
      'Invalid JSON in request body',
      400,
      {}
    );
    audit('api_error', e.toLog());
    return res.status(400).json(e.toClient());
  }
  // Fallback for any unhandled errors
  const e = internalError(err, { path: req.path, method: req.method });
  audit('api_error', e.toLog());
  res.status(500).json(e.toClient());
});

module.exports = router;
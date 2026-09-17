'use strict';
// API routers: providers, models, chats (streaming), memory, status.
const express = require('express');
const crypto = require('crypto');
const prov = require('./providers');
const chat = require('./chatstore');
const openai = require('./openai');
const db = require('./db');
const { redact } = require('./util');

const router = express.Router();

const now = () => Date.now();
const uid = () => crypto.randomUUID();

// ---------------- providers ----------------
router.get('/providers', (req, res) => res.json(prov.list()));

router.post('/providers', (req, res) => {
  try {
    const p = prov.create(req.body || {});
    res.status(201).json(p);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/providers/:id', (req, res) => {
  const p = prov.update(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: 'provider not found' });
  res.json(p);
});

// Activate the provider used by the OpenAI-compatible /v1 proxy.
router.post('/providers/:id/activate', (req, res) => {
  const p = prov.getById(req.params.id);
  if (!p) return res.status(404).json({ error: 'provider not found' });
  prov.setActive(p.id);
  res.json({ ok: true, active: p.id });
});

router.delete('/providers/:id', (req, res) => {
  prov.remove(req.params.id);
  res.status(204).end();
});

// Test connection; on success, registers discovered models (Req 6).
router.post('/providers/:id/test', async (req, res) => {
  try {
    const { ok, models, error } = await prov.testAndRegister(req.params.id);
    if (!ok) return res.status(422).json({ ok: false, error });
    res.json({ ok: true, models });
  } catch (e) {
    res.status(422).json({ ok: false, error: e.message });
  }
});

// ---------------- models ----------------
router.get('/models', (req, res) => {
  res.json(prov.listModels(req.query.provider || null));
});

router.post('/models/activate', (req, res) => {
  const { model } = req.body || {};
  // find provider that owns this discovered model
  const row = model ? db.one('SELECT provider_id FROM models WHERE model = ?', model) : null;
  const id = row ? row.provider_id : null;
  prov.setActive(id);
  res.json({ ok: true, active_provider: id });
});

// ---------------- chats ----------------
router.get('/chats', (req, res) => res.json(chat.listChats()));

router.post('/chats', (req, res) => {
  res.status(201).json(chat.createChat(req.body || {}));
});

router.get('/chats/:id', (req, res) => {
  const c = db.one('SELECT * FROM chats WHERE id=?', req.params.id);
  if (!c) return res.status(404).json({ error: 'chat not found' });
  res.json({ id: c.id, title: c.title, model: c.model, messages: chat.getMessages(c.id) });
});

router.patch('/chats/:id', (req, res) => {
  const b = req.body || {};
  if (b.title !== undefined) chat.renameChat(req.params.id, b.title);
  if (b.model !== undefined) chat.setChatModel(req.params.id, b.model);
  res.json({ ok: true });
});

router.delete('/chats/:id', (req, res) => {
  chat.deleteChat(req.params.id);
  res.status(204).end();
});

// Streaming chat completion. Upserts the user turn, streams SSE deltas, then
// persists the assistant reply (Req 2). Multi-chat safe: stateless per request.
router.post('/chats/:id/stream', async (req, res) => {
  const chatId = req.params.id;
  const { content, model } = req.body || {};
  if (!content || !String(content).trim()) {
    return res.status(400).json({ error: 'content is required' });
  }
  const chatRow = db.one('SELECT * FROM chats WHERE id=?', chatId);
  if (!chatRow) return res.status(404).json({ error: 'chat not found' });

  const usingModel = model || chatRow.model;
  const modelRow = usingModel
    ? db.one('SELECT provider_id FROM models WHERE model=?', usingModel)
    : null;
  const provider = modelRow ? prov.loadWithKey(modelRow.provider_id) : null;
  if (!provider || !provider.key) {
    return res.status(400).json({
      error: 'no valid provider/key for this model — configure a key in Settings and Test it first (Req 1/6)',
    });
  }

  // persist user message
  chat.addMessage({ chatId, role: 'user', content: String(content).trim(), model: usingModel });

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
  const fail = (code, msg) => {
    if (headersWritten) { send({ event: 'error', error: msg }); res.end(); }
    else res.status(code).json({ error: msg });
  };

  try {
    const upstream = await openai.streamChat(provider.base_url, provider.key, {
      model: usingModel,
      messages: history,
      max_tokens: 2000,
    });
    if (!upstream.ok) {
      const body = (await upstream.text().catch(() => '')).slice(0, 300);
      return fail(502, `upstream ${upstream.status}: ${body}`);
    }

    writeHead(); headersWritten = true;
    send({ event: 'start', model: usingModel });

    let acc = '';
    let chunk = '';
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
          if (delta) { acc += delta; send({ event: 'delta', text: delta }); }
          if (json.choices?.[0]?.finish_reason) send({ event: 'finish' });
        } catch { /* non-JSON SSE frame */ }
      }
    }

    // persist assistant reply even if truncated, so nothing is lost (Req 7)
    const msgId = acc ? chat.addMessage({ chatId, role: 'assistant', content: acc, model: usingModel }) : null;
    send({ event: 'done', message_id: msgId, full: acc });
    res.end();
  } catch (e) {
    fail(502, (e && e.message) || 'stream failed');
  }
});

// ---------------- settings (Req 9: sealed config) ----------------
const cryptoMod = require('./crypto');

// Settings are stored as an opaque sealed blob (AES-256-GCM, the tag acts as the
// HMAC). Only this endpoint touches it; there is no raw-config edit surface.
const DEFAULT_SETTINGS = { theme: 'dark', proxyEnabled: true, defaultModel: '' };

router.get('/settings', (req, res) => {
  try {
    const blob = db.one("SELECT value FROM meta WHERE key='settings'");
    let settings = DEFAULT_SETTINGS;
    if (blob && blob.value) {
      settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(cryptoMod.decrypt(blob.value)));
    }
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: 'settings corrupt — reseal by saving' });
  }
});

router.put('/settings', (req, res) => {
  try {
    const merged = Object.assign({}, DEFAULT_SETTINGS, req.body || {});
    const sealed = cryptoMod.encrypt(JSON.stringify(merged));
    db.run("INSERT INTO meta(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", sealed);
    res.json(merged);
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'save failed' });
  }
});

// ---------------- memory (Req 3) ----------------
router.get('/memory/search', (req, res) => {
  const q = req.query.q || '';
  res.json(chat.searchMemory(q, { limit: req.query.limit || 10 }));
});

// ---------------- status ----------------
router.get('/status', (req, res) => {
  res.json({
    ok: db.integrityOk(),
    providers: prov.list().length,
    models: db.one('SELECT count(*) c FROM models').c,
    chats: db.one('SELECT count(*) c FROM chats').c,
    memory_indexed: db.one('SELECT count(*) c FROM messages_fts').c,
    schema_version: 1,
    version: '1.0.0',
  });
});

// Central error guard: never leak keys or internal detail to the client.
router.use((err, req, res, next) => {
  const clean = redact(err);
  const safe = (clean && clean.message) || 'internal error';
  res.status(500).json({ error: safe });
});

module.exports = router;
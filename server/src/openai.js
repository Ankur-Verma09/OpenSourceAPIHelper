'use strict';
// OpenAI-compatible HTTP client, built on native fetch (Node 22).
// Handles base-URL normalization, model discovery, and SSE chat streaming.

// Normalize a user-provided base URL to the OpenAI-compatible `.../v1` form.
// Fixes the classic mistakes: trailing "/chat/completions", missing "/v1".
function normalizeBase(raw) {
  if (!raw) throw new Error('base URL is required');
  let u = String(raw).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) throw new Error('base URL must start with http(s)://');
  // strip a trailing /chat/completions path segment
  u = u.replace(/\/chat\/completions$/i, '');
  // also trim /models if someone pasted the full endpoint
  u = u.replace(/\/models$/i, '');
  if (!/\/v1\/?$/i.test(u)) u += '/v1';
  return u;
}

function headers(provider) {
  const h = { 'Content-Type': 'application/json' };
  if (provider.key) h.Authorization = `Bearer ${provider.key}`;
  return h;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(t) };
}

// Verify + discover models. Returns the model id/name list.
async function discoverModels(baseUrl, apiKey, { timeout = 15000 } = {}) {
  const { signal, clear } = timeoutSignal(timeout);
  try {
    const res = await fetch(`${normalizeBase(baseUrl)}/models`, {
      method: 'GET',
      headers: headers({ key: apiKey }),
      signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`models endpoint ${res.status}: ${body}`);
    }
    const json = await res.json();
    const list = Array.isArray(json.data) ? json.data : [];
    return list.map((m) => m.id).filter(Boolean);
  } finally {
    clear();
  }
}

// Verify connectivity with a tiny non-streaming call (cheap, no key leak).
async function testConnection(baseUrl, apiKey, model, { timeout = 20000 } = {}) {
  const { signal, clear } = timeoutSignal(timeout);
  try {
    const res = await fetch(`${normalizeBase(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: headers({ key: apiKey }),
      body: JSON.stringify({
        model: model || 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 8,
        stream: false,
      }),
      signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`test ${res.status}: ${body}`);
    }
    const json = await res.json();
    return json;
  } finally {
    clear();
  }
}

// Stream a chat-completion SSE response. Caller governs timeout/cancellation
// (streaming responses can legitimately run for minutes). Returns `res`.
async function streamChat(baseUrl, apiKey, { model, messages, max_tokens }) {
  const res = await fetch(`${normalizeBase(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: headers({ key: apiKey }),
    body: JSON.stringify({ model, messages, max_tokens, stream: true }),
  });
  return res;
}

module.exports = { normalizeBase, discoverModels, testConnection, streamChat };
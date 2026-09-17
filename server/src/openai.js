'use strict';
// OpenAI-compatible HTTP client, built on native fetch (Node 22).
// Handles base-URL normalization, model discovery, and SSE chat streaming.

// Normalize a user-provided base URL to the OpenAI-compatible `.../v1` form.
// Fixes the classic mistakes: trailing "/chat/completions", missing "/v1".
// Blocks private/reserved IP ranges to prevent SSRF.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
]);

const BLOCKED_IP_PATTERNS = [
  /^127\./,           // loopback
  /^10\./,            // RFC1918 10/8
  /^192\.168\./,      // RFC1918 192.168/16
  /^172\.(1[6-9]|2\d|3[0-1])\./, // RFC1918 172.16/12
  /^169\.254\./,      // link-local
  /^::1$/,            // IPv6 loopback
  /^fe80::/,          // IPv6 link-local
  /^::ffff:127\./,    // IPv4-mapped loopback
  /^::ffff:10\./,     // IPv4-mapped RFC1918
  /^::ffff:192\.168\./,
  /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./,
  /^::ffff:169\.254\./,
];

function isAllowedHost(hostname) {
  if (!hostname) return false;
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) return false;
  // IP address check
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(lower) || /^\[?[\da-f:]+\]?$/i.test(lower)) {
    return !BLOCKED_IP_PATTERNS.some((re) => re.test(lower.replace(/^\[|\]$/g, '')));
  }
  return true; // allow hostnames (DNS) - user controls DNS resolution
}

function normalizeBase(raw) {
  if (!raw) throw new Error('base URL is required');
  let u = String(raw).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) throw new Error('base URL must start with http(s)://');
  // strip a trailing /chat/completions path segment
  u = u.replace(/\/chat\/completions$/i, '');
  // also trim /models if someone pasted the full endpoint
  u = u.replace(/\/models$/i, '');
  if (!/\/v1\/?$/i.test(u)) u += '/v1';
  // SSRF guard: validate hostname before returning
  const hostname = new URL(u).hostname;
  if (!isAllowedHost(hostname)) {
    throw new Error(`blocked host: ${hostname} (private/reserved addresses not allowed)`);
  }
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 min max stream duration
  try {
    const res = await fetch(`${normalizeBase(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: headers({ key: apiKey }),
      body: JSON.stringify({ model, messages, max_tokens, stream: true }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

module.exports = { normalizeBase, discoverModels, testConnection, streamChat };
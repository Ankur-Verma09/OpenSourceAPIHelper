'use strict';
// OpenAI-compatible HTTP client, built on native fetch (Node 22).
// Handles base-URL normalization, model discovery, and SSE chat streaming.

const { providerInvalidUrl, internalError, upstreamError, upstreamUnavailable, streamTimeout, tlsVerificationFailed, ssrfBlocked } = require('./errors');

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
  if (!raw) throw providerInvalidUrl('base URL is required');
  let u = String(raw).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) throw providerInvalidUrl('base URL must start with http(s)://');
  // strip a trailing /chat/completions path segment
  u = u.replace(/\/chat\/completions$/i, '');
  // also trim /models if someone pasted the full endpoint
  u = u.replace(/\/models$/i, '');
  if (!/\/v1\/?$/i.test(u)) u += '/v1';
  // SSRF guard: validate hostname before returning
  const hostname = new URL(u).hostname;
  if (!isAllowedHost(hostname)) {
    throw providerInvalidUrl(`blocked host: ${hostname} (private/reserved addresses not allowed)`);
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
async function discoverModels(baseUrl, apiKey, { timeout = 15000, fetch: fetchFn = fetch } = {}) {
  const { signal, clear } = timeoutSignal(timeout);
  try {
    const res = await fetchFn(`${normalizeBase(baseUrl)}/models`, {
      method: 'GET',
      headers: headers({ key: apiKey }),
      signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw upstreamError(res.status, body);
    }
    const json = await res.json();
    const list = Array.isArray(json.data) ? json.data : [];
    return list.map((m) => m.id).filter(Boolean);
  } catch (e) {
    if (e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND' || e?.code === 'ETIMEDOUT') {
      throw upstreamUnavailable();
    }
    if (e?.name === 'AbortError') {
      throw streamTimeout();
    }
    if (e?.message?.includes('certificate') || e?.message?.includes('CERT') || e?.message?.includes('TLS')) {
      throw tlsVerificationFailed(e.message);
    }
    if (e?.message?.includes('private') || e?.message?.includes('loopback') || e?.message?.includes('blocked')) {
      throw ssrfBlocked(baseUrl);
    }
    throw e;
  } finally {
    clear();
  }
}

// Verify connectivity with a tiny non-streaming call (cheap, no key leak).
async function testConnection(baseUrl, apiKey, model, { timeout = 20000, fetch: fetchFn = fetch } = {}) {
  const { signal, clear } = timeoutSignal(timeout);
  try {
    const res = await fetchFn(`${normalizeBase(baseUrl)}/chat/completions`, {
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
      throw upstreamError(res.status, body);
    }
    const json = await res.json();
    return json;
  } catch (e) {
    if (e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND' || e?.code === 'ETIMEDOUT') {
      throw upstreamUnavailable();
    }
    if (e?.name === 'AbortError') {
      throw streamTimeout();
    }
    if (e?.message?.includes('certificate') || e?.message?.includes('CERT') || e?.message?.includes('TLS')) {
      throw tlsVerificationFailed(e.message);
    }
    if (e?.message?.includes('private') || e?.message?.includes('loopback') || e?.message?.includes('blocked')) {
      throw ssrfBlocked(baseUrl);
    }
    throw e;
  } finally {
    clear();
  }
}

// Stream a chat-completion SSE response. Caller governs timeout/cancellation
// (streaming responses can legitimately run for minutes). Returns `res`.
async function streamChat(baseUrl, apiKey, { model, messages, max_tokens, tools, tool_choice, fetch: fetchFn = fetch } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 min max stream duration
  try {
    const payload = { model, messages, max_tokens, stream: true };
    if (tools && Array.isArray(tools) && tools.length > 0) payload.tools = tools;
    if (tool_choice) payload.tool_choice = tool_choice;
    const res = await fetchFn(`${normalizeBase(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: headers({ key: apiKey }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res;
  } catch (e) {
    clearTimeout(timeout);
    if (e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND' || e?.code === 'ETIMEDOUT') {
      throw upstreamUnavailable();
    }
    if (e?.name === 'AbortError') {
      throw streamTimeout();
    }
    if (e?.message?.includes('certificate') || e?.message?.includes('CERT') || e?.message?.includes('TLS')) {
      throw tlsVerificationFailed(e.message);
    }
    if (e?.message?.includes('private') || e?.message?.includes('loopback') || e?.message?.includes('blocked')) {
      throw ssrfBlocked(baseUrl);
    }
    throw e;
  }
}

module.exports = { normalizeBase, discoverModels, testConnection, streamChat, createVerifyingFetch };

// TLS certificate verification helper (optional, for cert pinning)
// Returns a custom fetch function that verifies the server cert against a SHA-256 fingerprint.
// fingerprint: hex string of the SHA-256 of the DER-encoded certificate (SPKI or full cert).
function createVerifyingFetch(fingerprint) {
  if (!fingerprint) return fetch;
  const https = require('https');
  const { URL } = require('url');
  const expected = fingerprint.toLowerCase().replace(/:/g, '');
  return async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return fetch(url, options);
    const agent = new https.Agent({
      checkServerIdentity: (host, cert) => {
        const der = cert.raw;
        const crypto = require('crypto');
        const fp = crypto.createHash('sha256').update(der).digest('hex');
        if (fp !== expected) {
          throw new Error(`Certificate fingerprint mismatch: expected ${expected}, got ${fp}`);
        }
        return undefined; // OK
      },
    });
    // Node 22 fetch supports agent via dispatcher option (undici)
    // Fallback: use https.request directly for full control
    return new Promise((resolve, reject) => {
      const req = https.request({
        ...options,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        agent,
        method: options.method || 'GET',
        headers: options.headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve(new Response(body, {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
          }));
        });
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  };
}
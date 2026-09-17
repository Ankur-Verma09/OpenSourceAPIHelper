'use strict';
// Redaction + masking helpers. Keys MUST never reach logs, errors, or the wire
// except ciphered. `redact()` is applied at the log/error boundary; `maskKey()`
// is the display view.

// Display view: preserve a short, recognizable prefix + last 4.
function maskKey(value) {
  if (!value) return '';
  const s = String(value).trim();
  if (s.length <= 8) return '••••••';
  // Consistent masking: first 4 + dots + last 4, regardless of key format
  const lead = s.slice(0, 4);
  const tail = s.slice(-4);
  return `${lead}••••••${tail}`;
}

// Deep-redact a parsed payload: replace any string that looks like a secret.
// Safe over objects/arrays; null-prototype guarded.
function looksLikeSecret(v) {
  return (
    /sk-[A-Za-z0-9_\-]{10,}/.test(v) ||
    /nvapi-[A-Za-z0-9_\-]{16,}/.test(v) ||
    /(?:\bbearer\s+)[A-Za-z0-9._\-]{8,}/i.test(v) && !/^bearer\s+[A-Za-z0-9._\-]*\*$/i.test(v)
  );
}

function redact(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === 'string') {
    if (looksLikeSecret(value)) return maskKey(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((x) => redact(x, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (/key|secret|token|password|apiKey|authorization/i.test(k)) {
        out[k] = value[k] ? '•••••' : value[k];
      } else {
        out[k] = redact(value[k], depth + 1);
      }
    }
    return out;
  }
  return value;
}

// One-line redacted bearer for request logs.
function redactHeaders(headers) {
  const h = { ...(headers || {}) };
  if (h.authorization) h.authorization = h.authorization.replace(/Bearer\s+.+/, 'Bearer •••');
  return h;
}

module.exports = { maskKey, redact, redactHeaders, looksLikeSecret };

// Audit logger — JSONL to config.AUDIT_LOG
const fs = require('fs');
const path = require('path');
const config = require('./config');

function ensureAuditDir() {
  const dir = path.dirname(config.AUDIT_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function audit(event, details = {}) {
  try {
    ensureAuditDir();
    const entry = {
      ts: Date.now(),
      event,
      ...details,
    };
    fs.appendFileSync(config.AUDIT_LOG, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch { /* best effort — never block on audit */ }
}

module.exports = { maskKey, redact, redactHeaders, looksLikeSecret, audit };
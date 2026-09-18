'use strict';
// Centralized error handling — safe messages for clients, detailed for logs.

const crypto = require('crypto');

// ──────────────────────────────────────
// Error Codes (client-facing, stable)
// ──────────────────────────────────────
const ERROR_CODES = {
  // Generic
  INTERNAL: 'INTERNAL_ERROR',
  INVALID_FORMAT: 'INVALID_FORMAT',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',

  // Providers
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PROVIDER_INVALID_URL: 'PROVIDER_INVALID_URL',
  PROVIDER_INVALID_KEY: 'PROVIDER_INVALID_KEY',
  PROVIDER_TEST_FAILED: 'PROVIDER_TEST_FAILED',
  PROVIDER_KEY_ROTATE_FAILED: 'PROVIDER_KEY_ROTATE_FAILED',

  // Models
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_NO_PROVIDER: 'MODEL_NO_PROVIDER',

  // Chats
  CHAT_NOT_FOUND: 'CHAT_NOT_FOUND',
  CHAT_EMPTY_MESSAGE: 'CHAT_EMPTY_MESSAGE',
  CHAT_NO_PROVIDER_KEY: 'CHAT_NO_PROVIDER_KEY',

  // Streaming
  STREAM_FAILED: 'STREAM_FAILED',
  STREAM_TRUNCATED: 'STREAM_TRUNCATED',
  STREAM_TIMEOUT: 'STREAM_TIMEOUT',
  STREAM_UPSTREAM_ERROR: 'STREAM_UPSTREAM_ERROR',
  STREAM_UPSTREAM_UNAVAILABLE: 'STREAM_UPSTREAM_UNAVAILABLE',
  STREAM_TLS_FAILED: 'STREAM_TLS_FAILED',
  STREAM_SSRF_BLOCKED: 'STREAM_SSRF_BLOCKED',
  STREAM_ABORTED: 'STREAM_ABORTED',

  // Settings
  SETTINGS_CORRUPT: 'SETTINGS_CORRUPT',
  SETTINGS_SAVE_FAILED: 'SETTINGS_SAVE_FAILED',
  CRYPTO_FAILED: 'CRYPTO_FAILED',

  // Database
  DB_ERROR: 'DB_ERROR',

  // Auth / CSRF / Rate limit
  AUTH_FAILED: 'AUTH_FAILED',
  CSRF_FAILED: 'CSRF_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
};

// ──────────────────────────────────────
// AppError — base class with safe client output
// ──────────────────────────────────────
class AppError extends Error {
  constructor(code, message, status = 500, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;           // ERROR_CODES value
    this.message = message;     // Safe for client
    this.status = status;       // HTTP status
    this.details = details;     // Additional safe context
    this.requestId = crypto.randomBytes(4).toString('hex'); // For log correlation
    this.timestamp = new Date().toISOString();
  }

  // What the client receives — NEVER includes stack or internal details
  toClient() {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId: this.requestId,
        ...(Object.keys(this.details).length ? { details: this.details } : {}),
      },
    };
  }

  // What gets logged — includes full context for debugging
  toLog() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      requestId: this.requestId,
      timestamp: this.timestamp,
      details: this.details,
      // stack only in logs, never to client
      stack: this.stack,
    };
  }
}

// ──────────────────────────────────────
// Factory functions — consistent error creation
// ──────────────────────────────────────

function invalidFormat(message = 'Invalid request format') {
  return new AppError(ERROR_CODES.INVALID_FORMAT, message, 400);
}

function validationFailed(message, field) {
  return new AppError(ERROR_CODES.VALIDATION_FAILED, message, 400, field ? { field } : {});
}

function notFound(resource, id) {
  return new AppError(ERROR_CODES.NOT_FOUND, `${resource} not found`, 404, { resource, id });
}

function internalError(err, context = {}) {
  const msg = err?.message || 'Internal server error';
  return new AppError(ERROR_CODES.INTERNAL, 'An unexpected error occurred', 500, {
    ...context,
    // Log-only: original error message (redacted by util.redact in audit)
    _internal: msg,
  });
}

// Provider errors
function providerNotFound(id) {
  return notFound('Provider', id);
}

function providerInvalidUrl(url) {
  return new AppError(ERROR_CODES.PROVIDER_INVALID_URL, 'Invalid provider URL', 400, { url });
}

function providerInvalidKey(field = 'apiKey') {
  return new AppError(ERROR_CODES.PROVIDER_INVALID_KEY, 'Invalid API key format', 400, { field });
}

function providerTestFailed(reason) {
  return new AppError(ERROR_CODES.PROVIDER_TEST_FAILED, `Provider test failed: ${reason}`, 422, { reason });
}

function providerKeyRotateFailed(id) {
  return new AppError(ERROR_CODES.PROVIDER_KEY_ROTATE_FAILED, 'Failed to rotate provider key', 500, { providerId: id });
}

// Model errors
function modelNotFound(model) {
  return new AppError(ERROR_CODES.MODEL_NOT_FOUND, 'Model not available', 404, { model });
}

function modelNoProvider(model) {
  return new AppError(ERROR_CODES.MODEL_NO_PROVIDER, 'No provider configured for this model', 400, { model });
}

// Chat errors
function chatNotFound(id) {
  return notFound('Chat', id);
}

function chatEmptyMessage() {
  return new AppError(ERROR_CODES.CHAT_EMPTY_MESSAGE, 'Message cannot be empty', 400, { field: 'content' });
}

function noProviderKey(model) {
  return new AppError(ERROR_CODES.CHAT_NO_PROVIDER_KEY, 'No API key configured for this model. Add a key in Settings and test the provider first.', 400, { model });
}

// Streaming errors
function streamFailed(reason) {
  return new AppError(ERROR_CODES.STREAM_FAILED, 'Streaming failed', 502, { reason });
}

function streamTruncated() {
  return new AppError(ERROR_CODES.STREAM_TRUNCATED, 'Response was truncated (size limit exceeded)', 200, { truncated: true });
}

function streamTimeout() {
  return new AppError(ERROR_CODES.STREAM_TIMEOUT, 'Request timed out', 504);
}

function upstreamError(status, body) {
  return new AppError(ERROR_CODES.STREAM_UPSTREAM_ERROR, `AI service error (${status})`, 502, { upstreamStatus: status, body });
}

function upstreamUnavailable() {
  return new AppError(ERROR_CODES.STREAM_UPSTREAM_UNAVAILABLE, 'AI service is currently unreachable. Check your internet connection and provider URL.', 503);
}

function tlsVerificationFailed(detail) {
  return new AppError(ERROR_CODES.STREAM_TLS_FAILED, 'Secure connection to AI service failed. Certificate verification failed.', 502, { detail: 'TLS verification error' });
}

function ssrfBlocked(url) {
  return new AppError(ERROR_CODES.STREAM_SSRF_BLOCKED, 'Blocked request to private/internal address', 400, { url: 'redacted' });
}

// Settings errors
function settingsCorrupt() {
  return new AppError(ERROR_CODES.SETTINGS_CORRUPT, 'Settings data is corrupted. Please re-save your settings.', 500);
}

function settingsSaveFailed(err) {
  return new AppError(ERROR_CODES.SETTINGS_SAVE_FAILED, 'Failed to save settings', 500, { _internal: err?.message });
}

function cryptoError(err, operation) {
  return new AppError(ERROR_CODES.CRYPTO_FAILED, 'Encryption error', 500, { operation, _internal: err?.message });
}

// Database errors
function dbError(err, operation) {
  return new AppError(ERROR_CODES.DB_ERROR, 'Database operation failed', 500, { operation, _internal: err?.message });
}

// Auth / CSRF / Rate limit
function authFailed(reason = 'Invalid or missing authentication token') {
  return new AppError(ERROR_CODES.AUTH_FAILED, reason, 401);
}

function csrfFailed() {
  return new AppError(ERROR_CODES.CSRF_FAILED, 'Invalid CSRF token. Please refresh and try again.', 403);
}

function rateLimited(retryAfter = 60) {
  return new AppError(ERROR_CODES.RATE_LIMITED, 'Too many requests. Please wait and try again.', 429, { retryAfter });
}

// ──────────────────────────────────────
// Async wrapper — catches async errors automatically
// ──────────────────────────────────────
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ──────────────────────────────────────
// Input validation helpers
// ──────────────────────────────────────
function validateInput(value, message, field) {
  if (!value || !String(value).trim()) {
    throw validationFailed(message, field);
  }
}

function validateUrl(url, field = 'url') {
  if (!url) return; // optional
  try {
    const u = new URL(String(url).trim());
    if (!['http:', 'https:'].includes(u.protocol)) {
      throw new Error('Invalid protocol');
    }
    // Additional SSRF protection: block private IPs
    const hostname = u.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
      /^169\.254\./.test(hostname) ||
      /^fc00:/i.test(hostname) ||
      /^fe80:/i.test(hostname)
    ) {
      // Allow if env opt-out is set (for on-prem deployments)
      if (process.env.ALLOW_PRIVATE_IPS !== 'true') {
        throw new Error('Private IP blocked');
      }
    }
  } catch (e) {
    throw providerInvalidUrl(url);
  }
}

function validateApiKey(key, field = 'apiKey') {
  if (!key) return; // optional
  const k = String(key).trim();
  // Basic format check — don't be too strict, providers vary
  if (k.length < 8) {
    throw providerInvalidKey(field);
  }
  // Reject obviously malformed keys (spaces, control chars)
  if (/[\s\x00-\x1F]/.test(k)) {
    throw providerInvalidKey(field);
  }
}

// Convert unknown errors to safe AppError
function toSafeError(err) {
  if (err instanceof AppError) return err;
  // Known error types
  if (err?.code) {
    switch (err.code) {
      case 'ECONNREFUSED':
      case 'ENOTFOUND':
      case 'ETIMEDOUT':
        return upstreamUnavailable();
      case 'CERT_HAS_EXPIRED':
      case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      case 'SELF_SIGNED_CERT_IN_CHAIN':
        return tlsVerificationFailed(err.code);
      default:
        return internalError(err);
    }
  }
  return internalError(err);
}

// Global Express error handler — never leaks internal details to client
function errorHandler(err, req, res, next) {
  // JSON parse error (express.json body parser)
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    const e = invalidFormat('Invalid JSON in request body');
    return res.status(400).json(e.toClient());
  }
  // AppError instances — safe by design
  if (err instanceof AppError) {
    return res.status(err.status).json(err.toClient());
  }
  // Unknown errors — sanitize and log
  const safe = toSafeError(err);
  return res.status(safe.status).json(safe.toClient());
}

module.exports = {
  ERROR_CODES,
  AppError,
  asyncHandler,
  validateInput,
  validateUrl,
  validateApiKey,
  toSafeError,
  errorHandler,
  // Factories
  invalidFormat,
  validationFailed,
  notFound,
  internalError,
  providerNotFound,
  providerInvalidUrl,
  providerInvalidKey,
  providerTestFailed,
  providerKeyRotateFailed,
  modelNotFound,
  modelNoProvider,
  chatNotFound,
  chatEmptyMessage,
  noProviderKey,
  streamFailed,
  streamTruncated,
  streamTimeout,
  upstreamError,
  upstreamUnavailable,
  tlsVerificationFailed,
  ssrfBlocked,
  settingsCorrupt,
  settingsSaveFailed,
  cryptoError,
  dbError,
  authFailed,
  csrfFailed,
  rateLimited,
};
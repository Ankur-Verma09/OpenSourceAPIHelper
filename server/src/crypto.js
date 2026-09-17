'use strict';
// AES-256-GCM vault. Values are opaque strings:  v1:<nonceB64>:<tagB64>:<ctB64>
// Tampering with ciphertext (or the tag) fails decryption loudly so the UI can
// offer restore-from-snapshot instead of ever leaking a key.

const crypto = require('crypto');
const { getMasterKey } = require('./keystore');

const AAD_APP = Buffer.from('OpenSourceAPIHelper/1');

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return '';
  const key = getMasterKey();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(AAD_APP);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    nonce.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64'),
  ].join(':');
}

function decrypt(payload) {
  if (!payload || payload === '') return '';
  const parts = String(payload).split(':');
  if (parts[0] !== 'v1' || parts.length !== 4) {
    throw new Error('corrupt sealed value (bad envelope)');
  }
  const key = getMasterKey();
  const nonce = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(AAD_APP);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return out.toString('utf8');
}

module.exports = { encrypt, decrypt };
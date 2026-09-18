'use strict';
// Licensing & Hardware Binding
// - Machine fingerprinting (persistent hardware identifiers)
// - Email whitelist (admin-managed)
// - License binding (email + machine)
// - Validation (non-bypassable, server-enforced)

const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');
const db = require('./db');
const { uid, now } = require('./chatstore');
const { audit } = require('./util');

// ──────────────────────────────────────
// Machine Fingerprinting
// ──────────────────────────────────────

function getMachineId() {
  // Windows: wmic csproduct get UUID (motherboard serial)
  // macOS: ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID
  // Linux: /etc/machine-id or /var/lib/dbus/machine-id
  try {
    if (process.platform === 'win32') {
      const out = execSync('wmic csproduct get UUID', { encoding: 'utf8', windowsHide: true });
      const lines = out.trim().split('\n');
      const uuid = lines[1]?.trim();
      if (uuid && uuid !== '00000000-0000-0000-0000-000000000000') return uuid;
    } else if (process.platform === 'darwin') {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID', { encoding: 'utf8', shell: true });
      const match = out.match(/\"([A-F0-9-]+)\"/);
      if (match) return match[1];
    } else {
      // Linux: try /etc/machine-id first
      const fs = require('fs');
      const paths = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
      for (const p of paths) {
        if (fs.existsSync(p)) {
          const id = fs.readFileSync(p, 'utf8').trim();
          if (id) return id;
        }
      }
    }
  } catch (e) {
    // ignore, fall through
  }
  // Fallback: hostname + user + platform
  return `${os.hostname()}-${os.userInfo().username}-${process.platform}`;
}

function getMacAddresses() {
  const nets = os.networkInterfaces();
  const macs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
        macs.push(net.mac);
      }
    }
  }
  // Sort for consistency
  return macs.sort();
}

function getHardwareHash() {
  // Create a stable hash from permanent hardware identifiers
  const parts = [
    getMachineId(),
    ...getMacAddresses(),
    os.platform(),
    os.arch(),
    // Add CPU info for additional stability
    os.cpus()[0]?.model || '',
  ];
  const combined = parts.filter(Boolean).join('|');
  return crypto.createHash('sha256').update(combined).digest('hex');
}

// Get or create machine record
function getOrCreateMachine() {
  const machineId = getMachineId();
  const macAddresses = getMacAddresses();
  const hardwareHash = getHardwareHash();
  const t = now();

  const existing = db.one('SELECT * FROM machines WHERE machine_id = ?', machineId);
  if (existing) {
    // Update last_seen and MACs (in case of network changes)
    db.run(
      'UPDATE machines SET mac_addresses=?, last_seen=?, hardware_hash=? WHERE machine_id=?',
      JSON.stringify(macAddresses), t, hardwareHash, machineId
    );
    return { ...existing, mac_addresses: JSON.parse(existing.mac_addresses) };
  }

  const id = uid();
  db.run(
    'INSERT INTO machines (id, machine_id, mac_addresses, hardware_hash, platform, arch, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?)',
    id, machineId, JSON.stringify(macAddresses), hardwareHash, process.platform, process.arch, t, t
  );
  return { id, machine_id: machineId, mac_addresses: macAddresses, hardware_hash: hardwareHash, platform: process.platform, arch: process.arch, first_seen: t, last_seen: t };
}

// ──────────────────────────────────────
// Email Whitelist (Admin only)
// ──────────────────────────────────────

function isEmailWhitelisted(email) {
  const row = db.one('SELECT * FROM email_whitelist WHERE email = ? AND active = 1', email.toLowerCase());
  return !!row;
}

function addToWhitelist(email, name = '', addedBy = 'admin') {
  const id = uid();
  const t = now();
  db.run(
    'INSERT INTO email_whitelist (id, email, name, added_by, created_at) VALUES (?,?,?,?,?)',
    id, email.toLowerCase(), name, addedBy, t
  );
  audit('whitelist_add', { email, name, added_by: addedBy });
  return { id, email: email.toLowerCase(), name, added_by: addedBy, created_at: t, active: 1 };
}

function removeFromWhitelist(email) {
  db.run('UPDATE email_whitelist SET active = 0 WHERE email = ?', email.toLowerCase());
  audit('whitelist_remove', { email });
}

function listWhitelist() {
  return db.all('SELECT * FROM email_whitelist WHERE active = 1 ORDER BY created_at DESC');
}

// ──────────────────────────────────────
// License Binding & Validation
// ──────────────────────────────────────

function bindLicense(email, machine) {
  const t = now();
  const hardwareHash = machine.hardware_hash || getHardwareHash();

  // Check whitelist first (hard requirement)
  if (!isEmailWhitelisted(email)) {
    throw new Error('EMAIL_NOT_WHITELISTED');
  }

  // Check if already bound to this machine
  const existing = db.one('SELECT * FROM licenses WHERE email = ? AND machine_id = ?', email.toLowerCase(), machine.id);
  if (existing) {
    // Update last_validated
    db.run('UPDATE licenses SET last_validated = ?, status = ? WHERE id = ?', t, 'active', existing.id);
    return { ...existing, last_validated: t, status: 'active' };
  }

  // Check if email is bound to a DIFFERENT machine
  const otherBinding = db.one('SELECT * FROM licenses WHERE email = ? AND machine_id != ?', email.toLowerCase(), machine.id);
  if (otherBinding) {
    throw new Error('EMAIL_BOUND_TO_OTHER_MACHINE');
  }

  // Check if this machine is bound to a DIFFERENT email
  const machineBinding = db.one('SELECT * FROM licenses WHERE machine_id = ? AND email != ?', machine.id, email.toLowerCase());
  if (machineBinding) {
    throw new Error('MACHINE_BOUND_TO_OTHER_EMAIL');
  }

  // Create new binding
  const id = uid();
  db.run(
    'INSERT INTO licenses (id, email, machine_id, machine_hash, status, bound_at, last_validated) VALUES (?,?,?,?,?,?,?)',
    id, email.toLowerCase(), machine.id, hardwareHash, 'active', t, t
  );
  audit('license_bind', { license_id: id, email: email.toLowerCase(), machine_id: machine.id, hardware_hash: hardwareHash });
  return { id, email: email.toLowerCase(), machine_id: machine.id, machine_hash: hardwareHash, status: 'active', bound_at: t, last_validated: t };
}

function validateLicense(email, machine) {
  const t = now();
  const hardwareHash = machine.hardware_hash || getHardwareHash();

  // Email must be whitelisted
  if (!isEmailWhitelisted(email)) {
    return { valid: false, reason: 'EMAIL_NOT_WHITELISTED', message: 'This email is not authorized. Contact administrator.' };
  }

  const license = db.one('SELECT * FROM licenses WHERE email = ? AND machine_id = ?', email.toLowerCase(), machine.id);
  if (!license) {
    return { valid: false, reason: 'NOT_BOUND', message: 'This machine is not registered for your email. Please bind it first.' };
  }

  // Check status
  if (license.status !== 'active') {
    return { valid: false, reason: 'LICENSE_REVOKED', message: 'License has been revoked or expired.' };
  }

  // Check expiration
  if (license.expires_at && license.expires_at < t) {
    db.run('UPDATE licenses SET status = ? WHERE id = ?', 'expired', license.id);
    return { valid: false, reason: 'EXPIRED', message: 'License has expired.' };
  }

  // Verify hardware hasn't changed (tamper detection)
  if (license.machine_hash !== hardwareHash) {
    audit('license_hardware_mismatch', { license_id: license.id, email: license.email, expected: license.machine_hash, actual: hardwareHash });
    return { valid: false, reason: 'HARDWARE_MISMATCH', message: 'Hardware configuration changed. License invalidated.' };
  }

  // Update last_validated
  db.run('UPDATE licenses SET last_validated = ? WHERE id = ?', t, license.id);

  return { valid: true, license: { ...license, last_validated: t } };
}

function revokeLicense(email, machineId = null) {
  if (machineId) {
    db.run('UPDATE licenses SET status = ? WHERE email = ? AND machine_id = ?', 'revoked', email.toLowerCase(), machineId);
  } else {
    db.run('UPDATE licenses SET status = ? WHERE email = ?', 'revoked', email.toLowerCase());
  }
  audit('license_revoke', { email: email.toLowerCase(), machine_id: machineId });
}

function getLicenseStatus(email, machineId = null) {
  if (machineId) {
    return db.one('SELECT * FROM licenses WHERE email = ? AND machine_id = ?', email.toLowerCase(), machineId);
  }
  return db.all('SELECT * FROM licenses WHERE email = ?', email.toLowerCase());
}

// ──────────────────────────────────────
// High-level: Full validation flow
// ──────────────────────────────────────

function validateAndBind(email) {
  const machine = getOrCreateMachine();
  const result = validateLicense(email, machine);

  if (result.valid) {
    return { success: true, license: result.license, machine };
  }

  // If not bound but email is whitelisted, try to bind
  if (result.reason === 'NOT_BOUND' && isEmailWhitelisted(email)) {
    try {
      const license = bindLicense(email, machine);
      return { success: true, license, machine, newlyBound: true };
    } catch (e) {
      return { success: false, reason: e.message, message: mapError(e.message) };
    }
  }

  return { success: false, reason: result.reason, message: result.message };
}

function mapError(code) {
  const map = {
    'EMAIL_NOT_WHITELISTED': 'This email is not authorized. Please contact your administrator to be added to the whitelist.',
    'EMAIL_BOUND_TO_OTHER_MACHINE': 'This email is already registered on another machine. Each email can only be used on one machine.',
    'MACHINE_BOUND_TO_OTHER_EMAIL': 'This machine is already registered to another email. Contact administrator to reset.',
    'HARDWARE_MISMATCH': 'Hardware configuration has changed. License invalidated for security.',
    'EXPIRED': 'License has expired. Contact administrator.',
    'LICENSE_REVOKED': 'License has been revoked. Contact administrator.',
  };
  return map[code] || 'License validation failed.';
}

module.exports = {
  // Machine
  getMachineId,
  getMacAddresses,
  getHardwareHash,
  getOrCreateMachine,

  // Whitelist
  isEmailWhitelisted,
  addToWhitelist,
  removeFromWhitelist,
  listWhitelist,

  // License
  bindLicense,
  validateLicense,
  revokeLicense,
  getLicenseStatus,
  validateAndBind,
  mapError,
};
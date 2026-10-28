'use strict';
const crypto = require('node:crypto');
const { AppError } = require('./errors');

// F3 (spec §9): ASYNCHRONOUS scrypt password hash (the synchronous form blocks the event loop, and
// it is called on login and in the mediamtx callback) with a VERSIONED format. The F1 format
// (`scrypt$N=16384$<salt>$<hex>`) keeps VERIFYING: the format migration is on READ, never a mass
// rewrite — nobody gets locked out because of this phase.
const MIN_LENGTH = 6;
const KEYLEN = 32;
// Configurable parameters (E3): hash callers have `state`, not `conf`, so the owning module reads its
// own environment at import — same shape as DEFAULT_PORT in config.js.
const PARAMS = {
  N: Number(process.env.OPENVMS_SCRYPT_N) || 16384,
  r: Number(process.env.OPENVMS_SCRYPT_R) || 8,
  p: Number(process.env.OPENVMS_SCRYPT_P) || 1,
};

function build(derived, salt, { N, r, p } = PARAMS) {
  return `scrypt$v=2$N=${N}$r=${r}$p=${p}$${salt}$${derived.toString('hex')}`;
}

function derive(password, salt, options, keylen = KEYLEN) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, options, (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}

async function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return build(await derive(password, s, PARAMS), s, PARAMS);
}

// ONLY the boot (`ensureAdmin`) and the local CLI: no request is in flight when they run.
// NEVER call it from a handler — for those, `hashPassword`.
function hashPasswordSync(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return build(crypto.scryptSync(String(password), s, KEYLEN, PARAMS), s, PARAMS);
}

// Reads the NEW format (`scrypt$v=2$N=..$r=..$p=..$salt$hex`, 7 fields) and the F1 one (4 fields,
// with r=8/p=1 fixed — the module's own values at the time). Returns null for anything else.
function parseHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts[1] === 'v=2') {
    if (parts.length !== 7) return null;
    const N = Number(String(parts[2]).slice(2));
    const r = Number(String(parts[3]).slice(2));
    const p = Number(String(parts[4]).slice(2));
    if (!N || !r || !p) return null;
    return { N, r, p, salt: parts[5], expected: Buffer.from(parts[6], 'hex') };
  }
  if (parts.length !== 4) return null;
  return { N: Number(String(parts[1]).slice(2)), r: 8, p: 1, salt: parts[2], expected: Buffer.from(parts[3], 'hex') };
}

async function verifyPassword(password, stored) {
  const a = parseHash(stored);
  if (!a || !a.expected.length) return false;
  try {
    const dk = await derive(password, a.salt, { N: a.N, r: a.r, p: a.p }, a.expected.length);
    // the length guard is mandatory: timingSafeEqual THROWS on buffers of different sizes
    return dk.length === a.expected.length && crypto.timingSafeEqual(a.expected, dk);
  } catch { return false; }
}

// §9: minimum 6 on CREATION, CHANGE and RESET (login is NOT policed — E4). No arbitrary
// composition rule: a long passphrase with spaces passes, 6 identical characters do too.
function validatePasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    throw new AppError('password_too_short', { min: MIN_LENGTH });
  }
}

// Temporary password (§7.1.5): STRONG randomness from the CSPRNG — base64url of 18 bytes (24 chars),
// the smallest size that passes the policy and has no character that breaks URL/JSON/log.
function generateTemporaryPassword(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = { hashPassword, hashPasswordSync, verifyPassword, validatePasswordPolicy,
  generateTemporaryPassword, parseHash, MIN_LENGTH, PARAMS };

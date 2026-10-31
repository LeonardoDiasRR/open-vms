'use strict';
const crypto = require('node:crypto');
const { SYSTEM_PROFILES } = require('../lib/access');
const { hashPasswordSync, verifyPassword } = require('../lib/password');
const { capabilitiesOf } = require('../lib/rbac');

// F3 (spec §9). The password hash lives in `lib/password.js` (async on the request path); the SESSION and
// the bootstrap live here. The session is stored by the token HASH key (sha256), never by the plain
// token: a leaked table hands over no live session, and no secret comparison is left to protect
// against timing (looking up a digest is not comparing the token — E6).
const SESSION_TTL_MS = Number(process.env.OPENVMS_SESSION_TTL_MS) || 6 * 3600e3;   // ABSOLUTE expiry
const SESSION_IDLE_MS = Number(process.env.OPENVMS_SESSION_IDLE_MS) || 30 * 60e3;  // by IDLENESS
const LAST_SEEN_MIN_MS = 60e3;   // ponytail: the touch is one UPDATE, throttled to once a minute

// 2026-10-26 (operator): a fresh install is born with the FIXED credential admin/admin and the change is
// MANDATORY at the first login. The random password printed ONCE on the console left him out of a fresh
// deployment. A password from config/env still wins while the change is pending.
const DEFAULT_ADMIN_PASSWORD = 'admin';

const sessionKey = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');

// Timestamps come from the database as Date, from a test fixture as number or ISO string. `new Date`
// reads all three; an unreadable value yields NaN and every comparison below fails closed.
const ms = (value) => new Date(value).getTime();

// A system profile holds by definition (spec §5); a custom one has to exist. Same rule as
// `isValidProfile`, over the row instead of the document.
const profileExists = async (store, id) =>
  SYSTEM_PROFILES.includes(id) || !!(await store.access.profileGet(id));

// users.profile_id is a FOREIGN KEY into access_profiles: the row has to exist before the user.
async function ensureProfile(store, id) {
  if (await store.access.profileGet(id)) return;
  await store.access.profileCreate({ id, name: id, kind: 'system' });
}

// The ONLY door that creates a session (login and password change both use it): the hash key and the
// session shape live in one place.
async function createSession(store, username, now = Date.now()) {
  const u = await store.access.userGet(username);
  const token = crypto.randomBytes(32).toString('hex');
  await store.sessions.create({
    token_hash: sessionKey(token),
    username,
    credential_version: Number((u && u.credential_version) || 0),
    expires_at: new Date(now + SESSION_TTL_MS),
  });
  return token;
}

async function ensureAdmin(store, username, password) {
  const u = await store.access.userGet(username);
  if (u) {
    // A5: an old install may have the admin without a PROFILE — repair by mapping to the `admin`
    // profile instead of locking it out of authorization. (The ordinal `role` this same repair used to
    // restore is gone since F4: the migration in `lib/access-migration.js` resolves legacy roles.)
    if (!(await profileExists(store, u.profile_id))) {
      await ensureProfile(store, 'admin');
      await store.access.userUpdate(username, { profile_id: 'admin', status: 'active' });
    }
    // §7.1.3 (D7): env/initial password only counts while the change flag is pending. After the first
    // login a forgotten `.env` rewrites nobody's password.
    if (u.must_change_password === true && password) {
      await store.access.userUpdate(username, { secret_hash: hashPasswordSync(password) });
    }
    return;
  }
  // 2026-10-26 (operator): a new install is born with the change PENDING and the FIXED default password.
  // The old anti-goal (admin/admin) was reversed by decision: the random password printed once left the
  // operator out of a fresh deployment. The mandatory change is what keeps the default from staying live.
  const initial = password || DEFAULT_ADMIN_PASSWORD;
  await ensureProfile(store, 'admin');
  await store.access.userCreate({
    username, secret_hash: hashPasswordSync(initial),
    profile_id: 'admin', status: 'active', must_change_password: true, credential_version: 1,
  });
  if (!password) {
    console.log('OpenVMS: the admin user was created with the DEFAULT password; the change is MANDATORY at the first login');
  }
}

async function login(store, username, password, now = Date.now()) {
  const u = await store.access.userGet(username);
  // §7.3: disabled does not log in (not even with the right password) and a user without a VALID
  // profile does not get in. §9: the verification is ASYNC (scrypt async) — login is a hot path.
  if (!u || u.status === 'disabled' || !(await profileExists(store, u.profile_id))
    || !(await verifyPassword(password, u.secret_hash))) return null;
  const token = await createSession(store, username, now);
  // spec §10: the response carries the PROFILE (never a secret field). The `expires_at` stays a NUMBER
  // of ms for the client; the row keeps it as timestamptz.
  // ponytail: the old `first_run` also required "settings never saved" — settings left the document for
  // `config.yaml` (spec §3), so the wizard now ends with the mandatory change itself.
  // spec 2026-10-27 (ui-oculta-acoes T2.1): the effective capabilities ride along so the client hides
  // actions from the FIRST answer (rbac.capabilitiesOf is the single source, never a second guess).
  return { token, expires_at: now + SESSION_TTL_MS, username, profile_id: u.profile_id,
    capabilities: capabilitiesOf(u.profile_id),
    must_change_password: u.must_change_password === true,
    first_run: u.profile_id === 'admin' && u.must_change_password === true };
}

async function checkSession(store, token, now = Date.now()) {
  const key = sessionKey(token);
  const s = await store.sessions.get(key);
  // §9: absolute expiry, fail-closed (a missing/unreadable timestamp is dead).
  if (!s || !(ms(s.expires_at) > now)) return null;
  // ...besides which the session dies of IDLENESS. Fail-closed: a session without `last_seen_at` does
  // not count (the column is NOT NULL, so this is the shape of an imported or hand-made row).
  if (!s.last_seen_at || !(now - ms(s.last_seen_at) <= SESSION_IDLE_MS)) return null;
  // the read RENEWS idleness, but without an UPDATE on every request
  if (now - ms(s.last_seen_at) >= LAST_SEEN_MIN_MS) await store.sessions.touch(key);
  return s;
}

module.exports = { ensureAdmin, login, checkSession, createSession, sessionKey, SESSION_TTL_MS, SESSION_IDLE_MS };

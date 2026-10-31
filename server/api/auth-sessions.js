'use strict';
const { hashPassword, verifyPassword, validatePasswordPolicy } = require('../lib/password');
const { createSession, sessionKey, SESSION_TTL_MS } = require('./auth');
const { AppError } = require('../lib/errors');
const { capabilitiesOf } = require('../lib/rbac');

// F3 (§7.1.5/6 + §10): the routes of the user THEMSELVES. They are `session` in the POLICY (rbac.js)
// because §7.1.4 exempts them from the mandatory-change barrier: they are the only way out of it. The
// token comes from the HEADER (no token in the URL — §9): the dispatcher `ctx` carries the session,
// not the token.
const bearerOf = (req) => {
  const a = String((req && req.headers && req.headers.authorization) || '');
  return a.startsWith('Bearer ') ? a.slice(7) : '';
};

function authSessionsRoutes(store) {
  return {
    // §7.1.5/6: the change requires the CURRENT password (including on the mandatory change — the
    // temporary one was shown once and the user knows it). Rotation: EVERY session of the user drops,
    // `credential_version` goes up (kills the media token in the browser, §6) and a NEW session comes
    // back in the body — the old token, which was in the client, stops being valid.
    'POST /api/v1/auth/change-password': async (body = {}, req, ctx) => {
      const username = ctx && ctx.session && ctx.session.username;
      const u = username ? await store.access.userGet(username) : null;
      if (!u) throw new AppError('not_authenticated');
      if (!(await verifyPassword(body.current, u.secret_hash))) throw new AppError('current_password_invalid');
      validatePasswordPolicy(body.password);
      const hash = await hashPassword(body.password);
      const version = Number(u.credential_version || 0) + 1;
      await store.access.userUpdate(username, {
        secret_hash: hash,
        must_change_password: false,
        credential_version: version,
      });
      // Not one statement, but the version bump above already invalidates the old sessions in rbac.js:
      // a failure between the two steps leaves tokens that no longer authorize anything.
      for (const s of await store.sessions.listByUser(username)) await store.sessions.remove(s.token_hash);
      // The numeric expiry stays in the response (the client type says number); the store keeps the row's
      // timestamptz and only the token hash — the plain token goes to the client once.
      const now = Date.now();
      const token = await createSession(store, username, now);
      return { token, expires_at: now + SESSION_TTL_MS, username, must_change_password: false };
    },

    // §9: logout invalidates the token — the (token hash) key leaves the table and the Bearer that was
    // in the client's hand stops being valid immediately.
    'POST /api/v1/auth/logout': async (_body, req, ctx) => {
      if (!ctx || !ctx.session) throw new AppError('not_authenticated');
      await store.sessions.remove(sessionKey(bearerOf(req)));
      return { ok: true };
    },

    // §10: read the own profile (F4 uses it to know whether a change is pending). Never a secret field.
    'GET /api/v1/auth/me': async (_args, _req, ctx) => {
      const u = ctx && ctx.user;
      if (!u) throw new AppError('not_authenticated');
      // spec 2026-10-19 (onboarding §5.1): first use = admin + pending change. The `settings` clause of
      // the formula left with the JSON document: the settings live in config.yaml, which always exists,
      // so "never saved" has no source here.
      // spec 2026-10-27 (ui-oculta-acoes T2.1): same `capabilities` the login answer carries, computed
      // by the single source rbac.capabilitiesOf (never re-derived here).
      return { username: u.username, profile_id: u.profile_id || null, status: u.status || null,
        capabilities: capabilitiesOf(u.profile_id),
        must_change_password: u.must_change_password === true,
        first_run: u.profile_id === 'admin' && u.must_change_password === true };
    },
  };
}

module.exports = { authSessionsRoutes, bearerOf };

'use strict';
const { verifyPassword } = require('../lib/password');
const { SYSTEM_PROFILES } = require('../lib/access');
const { AppError } = require('../lib/errors');

// RTSP re-streaming routes (spec 2026-10-14). mediamtx calls POST /api/v1/rtsp/auth on every
// DESCRIBE; the decision lives here, pure, and the origin gate is the TCP one (not the `ip` field of
// the body, which is mediamtx's view of the end client).
// Since spec 2026-10-16 the same callback authenticates the browser WebRTC read: the read token
// travels in `query` (`ovms_token`), because mediamtx relays the raw query in the body.
// Every user/camera/grant read goes to the store: this callback runs on every DESCRIBE, so it must
// see the CURRENT row (a revoked grant or a disabled account denies the next request, not the next boot).
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Hub path -> camera id: `<uuid>` and `<uuid>/sub` (hub spec 2026-10-14)
const SUB_SUFFIX = '/sub';

function cameraIdFromPath(path) {
  const p = String(path || '');
  return p.endsWith(SUB_SUFFIX) ? p.slice(0, -SUB_SUFFIX.length) : p;
}

// Passwords with @ # : / ? % do not travel raw inside the RTSP URL: the player parser cuts at the
// first '@', and a player that percent-encodes sends the still-encoded text to the callback.
// The decode is the second attempt — the raw password always comes first, otherwise a literal '%'
// breaks it. F3 (§9): the check is ASYNC (scrypt async) — the callback path runs on every DESCRIBE.
async function passwordMatches(password, secretHash) {
  if (await verifyPassword(password, secretHash)) return true;
  if (typeof password !== 'string' || !password.includes('%')) return false;
  try {
    return await verifyPassword(decodeURIComponent(password), secretHash);
  } catch { return false; } // ponytail: a stray '%' is not encoding; URIError is not a password
}

// §8: a system profile reaches every camera by definition (even before the `access_profiles` row
// exists); a custom one only its grants, `control` implying `view`. `camerasWithLevel` is the
// repository predicate rbac uses, so there is one grant rule in the codebase.
const canView = async (store, profileId, cameraId) => {
  if (SYSTEM_PROFILES.includes(profileId)) return true;
  return !!profileId && (await store.access.camerasWithLevel(profileId, 'view')).includes(cameraId);
};

async function decideAuth({ ip, action, path, user, password, query, store, cred, tokens }) {
  if (!LOOPBACK.has(String(ip || ''))) return { status: 403, reason: 'origin is not loopback' };
  if (action === 'publish') {
    if (cred && user === cred.username && password === cred.password) return { status: 200, reason: 'publish' };
    return { status: 401, reason: 'invalid publish credential' };
  }
  if (action === 'read') {
    // ingest and the internal consumers read with the service credential (bypass §8: it never leaks
    // to the end user — the browser gets only the read token, never this password)
    if (cred && user === cred.username && password === cred.password) return { status: 200, reason: 'service read' };
    const camId = cameraIdFromPath(path);
    const u = user ? await store.access.userGet(user) : null;
    if (u && await passwordMatches(password, u.secret_hash)) {
      const camRow = await store.catalog.cameras.get(camId);
      if (!camRow) return { status: 401, reason: 'unknown camera' };
      // camera-ativa (spec 2026-10-27): a deactivated camera refuses the user/password read at once.
      // E1: a token issued earlier stays valid until the hub reconcile drops the path.
      if (camRow.meta && camRow.meta.ativa === false) return { status: 403, reason: 'camera inactive' };
      // §8: a valid credential is NOT enough — it takes `camera.view` of the PROFILE on the CAMERA OF
      // THE PATH, and a disabled account does not read. 404 (not 403 nor 401): the camera existence
      // does not leak to whoever cannot reach it (§6/A7) and a permission refusal is not a credential
      // failure — the Hub watch must not mark the camera as `error` for it.
      // §7.1.4 (F4): the pending-change barrier applies HERE too — this callback runs in mediamtx,
      // outside the `main.js` dispatcher. Same 404 on purpose: it is a permission refusal, not a
      // credential one.
      if (u.status !== 'active' || u.must_change_password === true || !await canView(store, u.profile_id, camId)) {
        return { status: 404, reason: 'camera without permission' };
      }
      return { status: 200, reason: 'read' };
    }
    // WebRTC (spec 2026-10-16): the browser does not hold the operator password. It brings the read
    // token in the query — the same query mediamtx sends in the callback body.
    const tk = new URLSearchParams(String(query || '')).get('ovms_token');
    // §8: `isValid(store, token, path)` revalidates the OWNER against the CURRENT rows on every request.
    if (tk && tokens && await tokens.isValid(store, tk, path)) return { status: 200, reason: 'token read' };
    return { status: 401, reason: 'invalid credential' };
  }
  return { status: 401, reason: 'unknown action' };
}

// Decision status -> stable error code. 404 is `camera_not_found` on purpose: the message is the same
// one a missing camera gets, so the permission refusal reveals nothing.
const CODE_FOR_STATUS = { 403: 'origin_not_allowed', 401: 'invalid_credentials', 404: 'camera_not_found' };

function restreamRoutes(store, deps) {
  return {
    'POST /api/v1/rtsp/auth': async (body = {}, req) => {
      const r = await decideAuth({
        ip: req && req.socket && req.socket.remoteAddress,
        action: body.action,
        path: body.path,
        user: body.user,
        password: body.password,
        query: body.query,
        store,
        cred: deps.publishCredential(),
        tokens: deps.tokens,
      });
      // spec 2026-10-16: the state watch listens to the DECISION (already made), never decides.
      // A request without credential and without token is mediamtx's anonymous probe (the 401 that
      // triggers Digest): it is not a read failure and wakes no hook.
      if (body.action === 'read') {
        const hasCredential = !!(body.user || body.password
          || new URLSearchParams(String(body.query || '')).has('ovms_token'));
        if (r.status === 200) deps.hubState?.readAttempt?.(body.path);
        else if (r.reason === 'invalid credential' && hasCredential) deps.hubState?.readRefused?.(body.path, 'auth_failed');
      }
      // ponytail: any status != 200 is a refusal for mediamtx; the message serves the log
      if (r.status !== 200) throw new AppError(CODE_FOR_STATUS[r.status] || 'invalid_credentials');
      return { ok: true };
    },
    'GET /api/v1/rtsp': async () => deps.rtsp(),
  };
}

module.exports = { decideAuth, restreamRoutes };

'use strict';
const { randomBytes } = require('node:crypto');
const { isSessionLive } = require('./rbac');

// Live reading token for WebRTC (spec 2026-10-16; ACL in F2). The browser does NOT have the
// operator password (it is a scrypt hash on the server), so the API issues a short token tied to ONE
// Hub path, and the mediamtx auth callback validates it on `action=read`. The token holds the CAMERA,
// the OWNER and the LOGIN SESSION: `isValid` revalidates all three against the CURRENT rows, so a
// revoked session, a disabled user or a lost grant kills the token already in the browser's hands.
const TTL_MS = 60 * 1000;
const tokens = new Map(); // token -> { path, camera_id, username, session_id, credential_version, expira }

// ponytail: injectable clock — the expiry test stays deterministic without sleep
function create(path, data = {}, now = Date.now()) {
  prune(now);
  const token = randomBytes(24).toString('hex');
  tokens.set(token, { path: String(path), camera_id: data.cameraId || null,
    username: data.username || null, session_id: data.sessionId || null,
    credential_version: Number(data.credentialVersion || 0), expira: now + TTL_MS });
  return { token, expires_in: TTL_MS / 1000 };
}

// Async since the relational store: the session and the user are ROWS, read on every request. The
// token itself stays in memory — it lives 60 s and dies with the process, so a table would be a
// garbage collector for nothing.
async function isValid(store, token, path, now = Date.now()) {
  const key = String(token || '');
  const t = tokens.get(key);
  if (!t) return false;
  if (t.expira <= now) { tokens.delete(key); return false; }
  if (t.path !== String(path || '')) return false;
  // Fail-closed: no store, or a token without owner, session or camera, does not pass.
  if (!store || !t.username || !t.session_id || !t.camera_id) return false;
  const session = await store.sessions.get(t.session_id);
  // `repoint` keeps the owner in step with a rename, so a different name is a different session.
  if (!isSessionLive(session, now) || session.username !== t.username) return false;
  const user = await store.access.userGet(t.username);
  if (!user || user.status !== 'active') return false;
  // The token carries the credential version it was issued with: password, profile, grant or status
  // changes bump it, which is what revokes the tokens already handed to a browser.
  if (Number(user.credential_version || 0) !== Number(t.credential_version || 0)) return false;
  // Level `view` of the camera: a system profile reaches all of them, a custom one only its grants
  // (an unknown or deleted profile has none, so it denies here too).
  return (await store.access.camerasWithLevel(user.profile_id, 'view')).includes(t.camera_id);
}

function prune(now = Date.now()) {
  for (const [k, v] of tokens) if (v.expira <= now) tokens.delete(k);
}

// spec 2026-10-18 (4.6): renaming does NOT cut the media. The token holds the OWNER and `isValid`
// revalidates it against the CURRENT state, so the tokens in the browser's hands MUST be repointed
// together with the user map key — without this, a token issued before the rename dies for up to
// 60 s (only the next `POST /api/v1/live/token` recovers it). The credential version does NOT
// change: the target is the name.
function repoint(username, newName) {
  for (const t of tokens.values()) if (t.username === username) t.username = newName;
}

module.exports = { create, isValid, prune, repoint, TTL_MS };

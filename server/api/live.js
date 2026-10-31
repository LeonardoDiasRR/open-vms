'use strict';
const { profilePath } = require('../lib/roles');
const { AppError } = require('../lib/errors');

// Live WebRTC read token (spec 2026-10-16). The browser asks for the WHEP URL here, with the OpenVMS
// session, and gets a short token bound to that profile path; /api/v1/rtsp/auth validates it. No Hub
// credential reaches the browser: neither the operator password (scrypt hash, unrecoverable) nor the
// service credential.
function baseWebrtc(conf, req) {
  if (conf.webrtcUrl) return String(conf.webrtcUrl).replace(/\/+$/, '');
  const host = String((req && req.headers && req.headers.host) || '').split(':')[0] || '127.0.0.1';
  return `http://${host}:${conf.webrtcPort}`;
}

// roles.js reads a camera's `profile_ids` and a map of profiles: the catalog has no such array
// (profiles.camera_id owns the relation), so it is rebuilt from the rows, as publicacao.js does.
async function publishedPath(catalog, profile) {
  const cam = await catalog.cameras.get(profile.camera_id);
  const list = await catalog.profiles.listByCamera(profile.camera_id);
  const byId = {};
  for (const p of list) byId[p.id] = p;
  return profilePath({ id: cam && cam.id, profile_ids: list.map((p) => p.id) }, byId, profile.id);
}

function liveRoutes(store, deps, conf) {
  return {
    'POST /api/v1/live/token': async (body = {}, req, ctx) => {
      // A profile id that does not exist and one the camera does not publish share the same answer:
      // there is no path on the Hub to hand out.
      const profile = body.profile_id ? await store.catalog.profiles.get(body.profile_id) : null;
      // An inactive camera is refused even while its path still exists on the Hub (reconcile window):
      // `camera_inactive` beats `profile_role_unpublished` here, the same way `meta.ativa === false` is
      // the only way a camera is inactive.
      const camRow = profile ? await store.catalog.cameras.get(profile.camera_id) : null;
      if (camRow && camRow.meta && camRow.meta.ativa === false) throw new AppError('camera_inactive');
      const path = profile ? await publishedPath(store.catalog, profile) : null;
      if (!path) throw new AppError('profile_role_unpublished');
      // §8: the token is born bound to the CAMERA and to its OWNER. The `camera.view` authorization on
      // the profile camera already happens in the dispatcher (POLICY, F1) BEFORE the handler runs; here
      // we only record the identity so `isValid` can revalidate on every read.
      // `sessionId` is the session key the validator looks up (`ctx.session_id`): without it `isValid`
      // fails closed and every live token would be refused.
      const { token, expires_in } = deps.tokens.create(path, {
        cameraId: profile.camera_id,
        username: ctx && ctx.session && ctx.session.username,
        sessionId: ctx && ctx.session_id,
        credentialVersion: ctx && ctx.user && ctx.user.credential_version,
      });
      return { whep_url: `${baseWebrtc(conf, req)}/${path}/whep`, token, expires_in };
    },
  };
}

module.exports = { liveRoutes, baseWebrtc };

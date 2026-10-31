'use strict';
const { SYSTEM_PROFILES, LEVEL_ORDER } = require('./access');
const { AppError } = require('./errors');

// ---- CAPABILITY-based authorization engine (spec 2026-10-17 §6, decision A3). The ordinal RBAC
// (viewer < operator < installation < admin) and the "unknown route = admin" fallback died in Phase
// 7 (E-F1 commit); this is the only engine, and the main.js dispatcher is what decides. Every read
// goes through the store, so the engine always authorizes against the CURRENT row in the database.
const CAPABILITIES = ['camera.view', 'camera.control', 'camera.manage', 'camera.manage.global',
  'settings.manage', // global capability, no camera — same as camera.manage.global (spec 2026-10-19)
  'users.manage', 'profiles.manage', 'retention.manage'];

// D1: operator = admin minus user and profile management. D3: viewer only reads (live and playback of
// every camera, no PTZ and no export). D4: the installation role became operator, with the 16 routes
// it had.
const PROFILE_CAPABILITIES = {
  admin: CAPABILITIES.slice(),
  operator: ['camera.view', 'camera.control', 'camera.manage', 'camera.manage.global', 'retention.manage'],
  viewer: ['camera.view'],
};
// Capabilities that only exist for a SYSTEM profile: a custom profile never administers (D1/D2).
const SYSTEM_ONLY_CAPABILITIES = new Set(['camera.manage', 'camera.manage.global', 'users.manage',
  'profiles.manage', 'retention.manage', 'settings.manage']);

// The camera of the resource when the route is by video profile (spec §6: "a route without a camera
// id resolves the resource before authorizing").
async function cameraForProfile(store, profileId) {
  if (!profileId) return undefined;
  const p = await store.catalog.profiles.get(profileId);
  return (p && p.camera_id) || undefined;
}

// §8: the export file belongs to a camera (through the video profile that produced it). Fail-closed:
// an unknown export or camera THROWS 404 — returning `undefined` would make the engine read the route
// as a LIST and allow it.
async function cameraForExport(store, exportId) {
  const j = await store.ops.exports.get(exportId);
  if (!j) throw new AppError('export_not_found');
  const cam = await cameraForProfile(store, j.stream_profile_id);
  if (!cam) throw new AppError('export_without_camera');
  return cam;
}

// COMPLETE inventory of the API (D8): every route main.js registers has a policy here.
// `camera` = async resolver of the camera id from the arguments (the store comes as the 2nd argument).
// Special capabilities: `session` = only a valid session (media and the profile itself); `publica` = no
// session.
const POLICY = {
  // global read — the LISTING is filtered by the custom profile scope (the cut lives in main)
  'GET /api/v1/cameras': { cap: 'camera.view' },
  'GET /api/v1/devices': { cap: 'camera.view' },
  'GET /api/v1/profiles': { cap: 'camera.view' },
  'GET /api/v1/camera-brands': { cap: 'camera.view' },
  'GET /api/v1/groups': { cap: 'camera.view' },
  'GET /api/v1/layouts': { cap: 'camera.view' },
  'GET /api/v1/events': { cap: 'camera.view' },
  'GET /api/v1/rtsp': { cap: 'camera.view' },
  'GET /api/v1/discovery/results': { cap: 'camera.view' },
  'GET /api/v1/discovery/scans/:id': { cap: 'camera.view' },
  // per-camera read
  'GET /api/v1/cameras/:id/profiles': { cap: 'camera.view', camera: (a) => a.id },
  'GET /api/v1/cameras/:id/ptz': { cap: 'camera.view', camera: (a) => a.id },
  'GET /api/v1/cameras/:id/ptz/positions': { cap: 'camera.view', camera: (a) => a.id },
  'GET /api/v1/archive/timeline': { cap: 'camera.view', camera: (a, store) => cameraForProfile(store, a.stream_profile_id) },
  'POST /api/v1/live/token': { cap: 'camera.view', camera: (a, store) => cameraForProfile(store, a.profile_id) },
  // per-camera operation: PTZ and saved positions
  'POST /api/v1/cameras/:id/ptz/move': { cap: 'camera.control', camera: (a) => a.id },
  'POST /api/v1/cameras/:id/ptz/stop': { cap: 'camera.control', camera: (a) => a.id },
  'POST /api/v1/cameras/:id/ptz/positions': { cap: 'camera.control', camera: (a) => a.id },
  'POST /api/v1/cameras/:id/ptz/positions/goto': { cap: 'camera.control', camera: (a) => a.id },
  'PATCH /api/v1/cameras/:id/ptz/positions': { cap: 'camera.control', camera: (a) => a.id },
  'DELETE /api/v1/cameras/:id/ptz/positions': { cap: 'camera.control', camera: (a) => a.id },
  // Zoom on the marked area (spec 2026-10-18): it is LENS MOVEMENT, so camera.control — the same role as
  // `/ptz/move`. The way back (`ptzUnzoom`) also moves: it is not a read.
  'POST /api/v1/cameras/:id/ptz/viewport-zoom': { cap: 'camera.control', camera: (a) => a.id },
  'POST /api/v1/cameras/:id/ptz/viewport-unzoom': { cap: 'camera.control', camera: (a) => a.id },
  // PER-CAMERA management (export goes here, not into camera.control: D2 says a custom profile does not export)
  'PATCH /api/v1/cameras/:id': { cap: 'camera.manage', camera: (a) => a.id },
  'DELETE /api/v1/cameras/:id': { cap: 'camera.manage', camera: (a) => a.id },
  'GET /api/v1/cameras/:id/config': { cap: 'camera.manage', camera: (a) => a.id },
  'POST /api/v1/cameras/:id/profiles': { cap: 'camera.manage', camera: (a) => a.id },
  'DELETE /api/v1/cameras/:id/profiles': { cap: 'camera.manage', camera: (a) => a.id },
  'POST /api/v1/cameras/:id/onvif-refresh': { cap: 'camera.manage', camera: (a) => a.id },
  'POST /api/v1/cameras/:id/manufacturer': { cap: 'camera.manage', camera: (a) => a.id },
  // ATTENTION: on this route the `:id` is a CAMERA id (the DVR resync is `/devices/:id/sync`)
  'POST /api/v1/devices/:id/onvif': { cap: 'camera.manage', camera: (a) => a.id },
  'POST /api/v1/archive/export': { cap: 'camera.manage', camera: (a, store) => cameraForProfile(store, a.stream_profile_id) },
  // Global settings (spec 2026-10-19): readable by whoever sees cameras; writable only by admin.
  'GET /api/v1/settings': { tipo: 'global', cap: 'camera.view' },
  'PATCH /api/v1/settings': { tipo: 'global', cap: 'settings.manage' },
  // GLOBAL management: create camera, discovery, groups, layouts, DVR. A1: GET /exports leaves viewer.
  'POST /api/v1/devices': { cap: 'camera.manage.global' },
  'POST /api/v1/devices/channels': { cap: 'camera.manage.global' },
  'POST /api/v1/devices/:id/sync': { cap: 'camera.manage.global' },
  'PATCH /api/v1/devices/:id': { cap: 'camera.manage.global' },
  'DELETE /api/v1/devices/:id': { cap: 'camera.manage.global' },
  'POST /api/v1/groups': { cap: 'camera.manage.global' },
  'PATCH /api/v1/groups/:id': { cap: 'camera.manage.global' },
  'DELETE /api/v1/groups/:id': { cap: 'camera.manage.global' },
  'POST /api/v1/layouts': { cap: 'camera.manage.global' },
  'DELETE /api/v1/layouts': { cap: 'camera.manage.global' },
  'POST /api/v1/discovery/scan': { cap: 'camera.manage.global' },
  'GET /api/v1/exports': { cap: 'camera.manage.global' },
  // spec 2026-10-23 (batch deletion): same capability as the list. Whoever does not see the panel does not delete.
  'DELETE /api/v1/exports': { cap: 'camera.manage.global' },
  'GET /api/v1/exports/zip': { cap: 'camera.manage.global' },
  // administration (D1: custom profiles are access delegation, hence admin only)
  'GET /api/v1/users': { cap: 'users.manage' },
  'POST /api/v1/users': { cap: 'users.manage' },
  'PATCH /api/v1/users/:username': { cap: 'users.manage' },
  'DELETE /api/v1/users/:username': { cap: 'users.manage' },
  'POST /api/v1/retention/run': { cap: 'retention.manage' },
  'GET /api/v1/profiles/access': { cap: 'profiles.manage' },
  'POST /api/v1/profiles/access': { cap: 'profiles.manage' },
  'PATCH /api/v1/profiles/access/:id': { cap: 'profiles.manage' },
  'DELETE /api/v1/profiles/access/:id': { cap: 'profiles.manage' },
  // session only: the media sends no header (the browser `<video>`) and the profile reads itself
  'GET /api/v1/profiles/access/mine': { cap: 'session' },
  'GET /api/v1/profiles/access/:id/grants': { cap: 'profiles.manage' },
  // §8: media read from DISK goes through the SAME engine — playback = `camera.view` per profile;
  // export = `camera.manage` (D2: a custom profile does not export). `mine` stays session-only.
  'GET /api/v1/exports/:id/file': { cap: 'camera.manage', camera: (a, store) => cameraForExport(store, a.id) },
  // spec 2026-10-18 (5.3): delivery per session. Both routes work by VIDEO PROFILE (the same resolver
  // as the timeline) and are reads: `camera.view`. The `segments/<ts>/file` route is GONE — and since
  // a route without a policy brings the boot down, leaving the POLICY and leaving the route map are
  // the same act.
  'GET /api/v1/play/:profile_id/playlist.m3u8': { cap: 'camera.view', camera: (a, store) => cameraForProfile(store, a.profile_id) },
  'GET /api/v1/play/:profile_id/:arquivo/file': { cap: 'camera.view', camera: (a, store) => cameraForProfile(store, a.profile_id) },
  // spec 2026-10-19 (task 3.1): the transcode session chunk belongs to the SAME video profile as the
  // playlist — same policy as the media routes above (read through camera.view).
  'GET /api/v1/play/:profile_id/transcode/:ini': { cap: 'camera.view', camera: (a, store) => cameraForProfile(store, a.profile_id) },
  // §10 + §7.1.4 (F3): the routes of the SESSION ITSELF are `session` — they hold even while the
  // password change is pending (the F4 barrier cannot block the only way out of it). The password
  // reset of ANOTHER user is user administration (D1).
  'POST /api/v1/auth/change-password': { cap: 'session' },
  'POST /api/v1/auth/logout': { cap: 'session' },
  'GET /api/v1/auth/me': { cap: 'session' },
  'POST /api/v1/users/:username/reset-password': { cap: 'users.manage' },
  // spec 2026-10-18 (4.6): renaming a user is user administration (D1)
  'POST /api/v1/users/:username/rename': { cap: 'users.manage' },
  // public
  'GET /api/v1/health': { cap: 'publica' },
  'POST /api/v1/auth/login': { cap: 'publica' },
  'POST /api/v1/rtsp/auth': { cap: 'publica' },
};

// The public list comes FROM THE SAME table: a new route without a policy cannot "become public" by
// sitting in a second list (D8).
const PUBLIC_ROUTES = Object.entries(POLICY).filter(([, p]) => p.cap === 'publica').map(([r]) => r);

function routesWithoutPolicy(routes) {
  return routes.filter((r) => !POLICY[r]);
}

// D8: a registered route without a policy brings the boot down — never "admin by mistake".
function requirePolicy(routes) {
  const missing = routesWithoutPolicy(routes);
  if (missing.length) throw new AppError('boot_policy_missing', { routes: missing.join(', ') });
  return true;
}

// Same idle window as `api/auth.js` `checkSession`, which already refuses an expired or idle session;
// authorization repeats it because it must fail closed on its own (the session row is the only input).
const SESSION_IDLE_MS = Number(process.env.OPENVMS_SESSION_IDLE_MS) || 30 * 60e3;

// `expires_at`/`last_seen_at` arrive as `Date` from Postgres, as a number from the JSON document and
// as ISO text from a fixture: one coercion, invalid becomes NaN and dies in the checks below.
const ms = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));

// Pure: the session ROW and nothing else. No expiry (or an unreadable one) is NOT a live session.
function isSessionLive(session, now = Date.now()) {
  if (!session || !session.username) return false;
  const expires = ms(session.expires_at);
  if (!Number.isFinite(expires) || expires <= now) return false;
  const seen = ms(session.last_seen_at);
  if (!Number.isFinite(seen) || now - seen > SESSION_IDLE_MS) return false;
  return true;
}

// The USER side of liveness (the session carries the version it was issued with): a disabled or
// missing user and a stale `credential_version` (password/profile change, grant, deactivation) deny.
function userLive(session, user) {
  if (!user || user.status !== 'active') return false;
  return Number(user.credential_version || 0) === Number(session.credential_version || 0);
}

// Resolves the PROFILE of a live session, or null. A system profile holds by definition; a custom one
// has to still exist in `access_profiles` (a deleted profile does not get in).
async function sessionProfile(store, session, user, now = Date.now()) {
  if (!isSessionLive(session, now) || !userLive(session, user)) return null;
  const profile = user.profile_id;
  if (SYSTEM_PROFILES.includes(profile)) return profile;
  if (!profile) return null;
  const p = await store.access.profileGet(profile);
  return p && p.kind === 'custom' ? profile : null;
}

function hasCapability(profileId, cap) {
  if (SYSTEM_PROFILES.includes(profileId)) return PROFILE_CAPABILITIES[profileId].includes(cap);
  if (SYSTEM_ONLY_CAPABILITIES.has(cap)) return false;
  return cap === 'camera.view' || cap === 'camera.control';
}

// Grant level of ONE camera (`none` is the absence of a grant). Read from the store, not from a snapshot.
async function grantLevelOf(store, profileId, cameraId) {
  const grants = await store.access.grantsOf(profileId);
  const g = grants.find((x) => x.camera_id === cameraId);
  return (g && g.level) || 'none';
}

// Capability + camera scope for an already live profile (the caller resolved liveness).
async function authorizeCap(store, profile, cap, cameraId) {
  if (!hasCapability(profile, cap)) throw new AppError('profile_capability_denied', { profile, action: cap });
  // Without a camera id it is the LIST action: allowed, and the cut is the filter (§6).
  if (cameraId === undefined || SYSTEM_PROFILES.includes(profile)) return true;
  const level = await grantLevelOf(store, profile, cameraId);
  const needed = cap === 'camera.control' ? 'control' : 'view';
  // 404 and not 403: the camera's existence does not leak to a custom profile without a grant (§6).
  if ((LEVEL_ORDER[level] || 0) < LEVEL_ORDER[needed]) throw new AppError('camera_not_found');
  return true;
}

// API of §6 (store first, then the session row and the user row of that session).
async function authorize(store, session, user, { action, cameraId } = {}) {
  if (!CAPABILITIES.includes(action)) throw new AppError('unknown_capability', { action });
  const profile = await sessionProfile(store, session, user);
  if (!profile) throw new AppError('invalid_session');
  return authorizeCap(store, profile, action, cameraId);
}

// Dispatcher entry: resolves the capability AND the camera of the declared ROUTE in one call.
async function authorizeRoute(store, session, user, route, args = {}) {
  const p = POLICY[route];
  if (!p) throw new AppError('access_policy_missing', { route });
  if (p.cap === 'publica') return true;
  const profile = await sessionProfile(store, session, user);
  if (!profile) throw new AppError('invalid_session');
  if (p.cap === 'session') return true;
  const cameraId = p.camera ? await p.camera(args, store) : undefined;
  return authorizeCap(store, profile, p.cap, cameraId);
}

// LIST filter (§6): a system profile reaches all; a custom one only those with a grant at the level.
async function filterAuthorizedCameras(store, session, user, cameraIds, level = 'view') {
  const profile = await sessionProfile(store, session, user);
  if (!profile) return [];
  if (SYSTEM_PROFILES.includes(profile)) return cameraIds;
  const allowed = new Set(await store.access.camerasWithLevel(profile, level));
  return cameraIds.filter((id) => allowed.has(id));
}

// Boolean for the dispatcher to decide the camera payload (§6).
async function can(store, session, user, cap) {
  const profile = await sessionProfile(store, session, user);
  return !!profile && hasCapability(profile, cap);
}

// Effective capability LIST for the client (spec 2026-10-27): what the profile CAN have. Which
// camera unlocks camera.control is the grant, answered per camera by cameraControlFlags below.
function capabilitiesOf(profileId) {
  if (SYSTEM_PROFILES.includes(profileId)) return PROFILE_CAPABILITIES[profileId].slice();
  return CAPABILITIES.filter((c) => !SYSTEM_ONLY_CAPABILITIES.has(c));
}

// Per-camera `control` flags for the client (spec 2026-10-27): the SAME rule the dispatcher applies
// on a PTZ route — the camera.control capability AND, for a custom profile, a grant at level
// `control` (a system profile reaches every camera). Dead session or missing profile: empty Set.
async function cameraControlFlags(store, session, user, cameraIds) {
  const profile = await sessionProfile(store, session, user);
  if (!profile || !hasCapability(profile, 'camera.control')) return new Set();
  if (SYSTEM_PROFILES.includes(profile)) return new Set(cameraIds);
  const allowed = new Set(await store.access.camerasWithLevel(profile, 'control'));
  return new Set(cameraIds.filter((id) => allowed.has(id)));
}

module.exports = { CAPABILITIES, PROFILE_CAPABILITIES, SYSTEM_ONLY_CAPABILITIES, POLICY, PUBLIC_ROUTES, routesWithoutPolicy,
  requirePolicy, isSessionLive, authorize, authorizeRoute, filterAuthorizedCameras, can,
  capabilitiesOf, cameraControlFlags };

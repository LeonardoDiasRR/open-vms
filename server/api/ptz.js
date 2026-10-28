'use strict';
const { hostXaddrs } = require('../lib/camera-gate');
const { addressOf } = require('../lib/cameras');
const { readBox, computeMovement } = require('../lib/ptz-viewport');
// The pre-zoom TTL is derived from the session idleness (auth.js) so the environment override holds on
// both sides — the pre-zoom cannot outlive the session that created it. No cycle: `auth.js` only depends
// on `lib/access`/`lib/password` and nothing below this layer requires `api/ptz`.
const { SESSION_IDLE_MS, sessionKey } = require('./auth');
const { bearerOf } = require('./auth-sessions');
const { AppError } = require('../lib/errors');
const iso = () => new Date().toISOString();

// PTZ routes (spec 2026-10-16): the browser NEVER speaks ONVIF — it sends speed and the server
// translates into ContinuousMove/Stop with the sealed credential. Two dead-mans protect the camera:
// this one (3 s) covers the browser that dies mid-drag, because ContinuousMove does not expire by itself.
const DEADMAN_MS = 3000;
const FAILURE_CACHE_MS = 600e3; // a camera without PTZ is not re-probed on every cell load
// Shape of the capability object stored in meta.ptz (spec 2026-10-17, section 1). RAISE this number when
// `ptzCapability` gains or loses a field: otherwise the old cache keeps winning and the new field never
// reaches the client — that was the measured defect (`Aeroporto PTZ` with `absolute` missing in cache).
const PTZ_SHAPE = 2;
// Ceiling of positions saved by OpenVMS (spec 2026-10-17, decision 4.11). The client also disables the
// buttons at the 20th; here is the real limit, because the route is open to whoever holds the role.
const SAVED_LIMIT = 20;
const SAVED_NAME_RE = /^Position (\d+)$/; // with a group: `savedNumber` reads the N from here
// Amendment E14: the pre-zoom cannot grow forever. The entry is PRUNED by TTL at the first opportunity
// (zoom/unzoom) — ptz.js does not see the end of the session (auth.js/main.js deletes it, outside this
// amendment's scope) and scanning a small Map per command costs ~nothing. Derived from SESSION_IDLE_MS
// (auth.js): the environment `OPENVMS_SESSION_IDLE_MS` holds on both sides, and the memory never lives
// longer than the session that created it.
const PREZOOM_TTL_MS = SESSION_IDLE_MS;

// A network error justifies trying the next address; a device Fault does NOT: repeating ContinuousMove
// on another address would send the movement twice (the endpoint answered, it just disliked the request).
const isNetworkFailure = (e) => /fetch failed|ECONNREFUSED|ECONNRESET|aborted|timeout/i.test(String((e && e.message) || ''));

// camera_addresses rows travel as text: a URL is its own xaddr, a JSON object carries ip/port, anything
// else is host[:port] for the ladder. A row already parsed by the store is the same object case.
const addressHost = (row) => {
  if (!row) return {};
  if (typeof row === 'string' && !row.trim().startsWith('{')) {
    if (/^https?:\/\//i.test(row)) {
      const u = new URL(row);
      // the row is authoritative: `href` would drop a default `:80` and rewrite the stored URL
      return { xaddr: String(row), ip: u.hostname, openPorts: [Number(u.port) || (u.protocol === 'https:' ? 443 : 80)] };
    }
    const [ip, port] = row.split(':');
    return { ip, openPorts: port ? [Number(port)] : [] };
  }
  const addr = addressOf(row);
  return { ...(addr.xaddr ? { xaddr: addr.xaddr } : {}), ip: addr.ip,
    openPorts: addr.port ? [Number(addr.port)] : (addr.openPorts || []) };
};

// Real session identity: the token hash (the same key that indexes `sessions`), so two tabs of
// the SAME user are two different sessions. Falls back to the username when there is no Bearer.
const sessionIdOf = (req, ctx) => {
  const token = bearerOf(req);
  return (token && sessionKey(token)) || (ctx && ctx.session && ctx.session.username) || 'anonymous';
};

function ptzRoutes(store, deps) {
  const armed = new Map(); // cameraId -> dead-man timeout
  // Area-zoom origin per SESSION + camera (amendments E13/E14/E18; spec 5.4). WEAK memory — dies with the
  // process. Keyed by the REAL session (the token hash, the same key the dispatcher builds): two
  // tabs/browsers of the SAME user get DIFFERENT keys, so the zoom of one does not define (nor can be
  // consumed by) the other's return — the multi-operator defect is also the defect of the same user in
  // two tabs.
  const preZoom = new Map(); // `${owner}:${cameraId}` -> { origin, ts }
  const ownerOf = (req, ctx) => sessionIdOf(req, ctx);
  const prunePreZoom = (now) => {
    for (const [k, v] of preZoom) if (now - v.ts > PREZOOM_TTL_MS) preZoom.delete(k);
  };
  const disarm = (id) => {
    const t = armed.get(id);
    if (t) { clearTimeout(t); armed.delete(id); }
  };
  const arm = (id, target) => {
    disarm(id);
    const t = setTimeout(() => { armed.delete(id); deps.onvif.ptzStop(target).catch(() => {}); }, DEADMAN_MS);
    t.unref?.(); // the watch does not hold the process (tests and shutdown)
    armed.set(id, t);
  };
  const requireCamera = async (id) => {
    const cam = await store.catalog.cameras.get(id);
    if (!cam) throw new AppError('camera_not_found');
    // camera ativa (plan 2026-10-27, amendment E3): an inactive camera is refused HERE — the single point
    // every PTZ route passes through — BEFORE any ONVIF session opens. `meta.ativa === false` is the ONLY
    // way a camera is inactive (absent meta.ativa means active, same reading as the live token gate).
    if (cam.meta && cam.meta.ativa === false) throw new AppError('camera_inactive');
    return cam;
  };
  const positionsOf = (cam) => (cam.meta && cam.meta.positions) || [];
  // meta is ONE jsonb column: every write merges into the meta read at this moment, never into the copy
  // the handler loaded before calling the camera (a capability sync mid-handler would be lost).
  const patchMeta = async (id, patch) => {
    const cam = await requireCamera(id);
    return store.catalog.cameras.update(id, { meta: { ...(cam.meta || {}), ...patch } });
  };
  const savedNumber = (name) => {
    const m = SAVED_NAME_RE.exec(String(name || '').trim());
    return m ? Number(m[1]) : null;
  };
  // The position is found by its LOCAL `id`, which arrives in the body as `position` (amendment E6: the
  // path `:id` beats the body `id` key in the router).
  const findPosition = (cam, position) => {
    const target = positionsOf(cam).find((p) => p.id === Number(position));
    if (!target) throw new AppError('position_not_found');
    return target;
  };
  // ponytail: same ladder as discovery (hostXaddrs); the ONVIF refresh endpoint comes first.
  // The row is text (URL, JSON object or bare host): `addressHost` coerces both shapes.
  const attemptsFor = async (cam) => {
    const [first] = await store.catalog.cameras.addresses(cam.id);
    const host = addressHost(first);
    if (!host.ip) return [];
    const urls = [cam.meta && cam.meta.onvif && cam.meta.onvif.endpoint, ...hostXaddrs(host)];
    return [...new Set(urls.filter(Boolean))];
  };
  const credentialOf = async (cam) => {
    const cred = cam.credential_ref && deps.openCredential && await deps.openCredential(cam.credential_ref);
    if (!cred) throw new AppError('camera_credentials_required');
    return cred;
  };
  const callOnvif = async (cam, call) => {
    const cred = await credentialOf(cam);
    let last = 'no ONVIF endpoint';
    for (const xaddr of await attemptsFor(cam)) {
      const target = { xaddr, user: cred.username, pass: cred.password };
      try {
        return { target, r: await call(target) };
      } catch (e) {
        last = (e && e.message) || String(e);
        if (!isNetworkFailure(e)) throw e; // the device answered: do not repeat on another address
      }
    }
    throw new AppError('onvif_unreachable', { reason: last });
  };
  const clampSpeed = (n) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  };
  // on-demand capability: probes (3 SOAP calls) and stores in meta.ptz. A failure is cached too, for
  // FAILURE_CACHE_MS — success never expires.
  const capability = async (cam, force = false) => {
    const cache = cam.meta && cam.meta.ptz;
    const shapeOk = (c) => c && c.shape === PTZ_SHAPE;
    if (!force && shapeOk(cache) && cache.supported === false
        && Date.parse(cache.synced_at || 0) > Date.now() - FAILURE_CACHE_MS) return cache;
    if (!force && shapeOk(cache) && cache.supported === true) return cache;
    const { r } = await callOnvif(cam, (target) => deps.onvif.ptzCapability(target));
    await patchMeta(cam.id, { ptz: { ...r, shape: PTZ_SHAPE, synced_at: iso() } });
    return r;
  };
  return {
    // `refresh=1` (live asks for revalidation, spec 2026-10-17 section 2) arrives as a NUMBER: the router
    // coerces the query string (server/main.js:523-524) and `:id` routes go through DYN.
    'GET /api/v1/cameras/:id/ptz': async ({ id, refresh } = {}) => {
      const cam = await requireCamera(id);
      try {
        const cap = await capability(cam, refresh === 1 || refresh === true);
        return { ...cap, supported: cap.supported, error: null };
      } catch (e) {
        // a camera without ONVIF PTZ is not a server error: return the reason and the client hides the icon
        const error = String((e && e.message) || e).slice(0, 160);
        await patchMeta(id, { ptz: { supported: false, shape: PTZ_SHAPE, error, synced_at: iso() } });
        return { supported: false, error };
      }
    },

    'POST /api/v1/cameras/:id/ptz/move': async ({ id, pan, tilt, zoom } = {}) => {
      const cam = await requireCamera(id);
      const v = { pan: clampSpeed(pan), tilt: clampSpeed(tilt), zoom: clampSpeed(zoom) };
      if (!v.pan && !v.tilt && !v.zoom) throw new AppError('velocity_zero');
      const cap = await capability(cam);
      if (!cap.token) throw new AppError('ptz_profile_missing');
      try {
        const { target } = await callOnvif(cam, (a) => deps.onvif.ptzMove({ ...a, token: cap.token, ...v }));
        arm(id, { ...target, token: cap.token });
        return { ok: true };
      } catch (e) {
        // the cell shows the reason to the operator; the log keeps the case for whoever runs the server.
        // ponytail: ONLY the failure is logged — success already shows in the access log, and one line per
        // command would flood the log at ~12 commands per second during a drag.
        console.error('[ptz] move failed camera=' + id + ': ' + ((e && e.message) || e));
        throw e;
      }
    },

    'POST /api/v1/cameras/:id/ptz/stop': async ({ id } = {}) => {
      const cam = await requireCamera(id);
      disarm(id);
      const token = cam.meta && cam.meta.ptz && cam.meta.ptz.token;
      if (!token) return { ok: true }; // never commanded: nothing to stop
      await callOnvif(cam, (a) => deps.onvif.ptzStop({ ...a, token }))
        .catch((e) => { console.error('[ptz] stop failed camera=' + id + ': ' + ((e && e.message) || e)); });
      return { ok: true };
    },

    // ---- local positions (spec 2026-10-17) ----
    // The list belongs to OpenVMS, not the device: `meta.positions` is its own key because `meta.ptz` is
    // REWRITTEN whole on every capability sync (spec 4.2) and the list would be wiped. No device preset is
    // read, created, renamed or deleted by these routes.
    'GET /api/v1/cameras/:id/ptz/positions': async ({ id } = {}) => {
      const cam = await requireCamera(id);
      // only `id` and `name` leave: `pan`/`tilt`/`zoom` do not cross the boundary, so the panel cannot
      // corrupt a position (spec 4.6)
      return { positions: positionsOf(cam).map((p) => ({ id: p.id, name: p.name })), error: null };
    },

    'POST /api/v1/cameras/:id/ptz/positions': async ({ id } = {}) => {
      const cam = await requireCamera(id);
      const positions = positionsOf(cam);
      if (positions.length >= SAVED_LIMIT) throw new AppError('ptz_positions_limit_reached');
      const cap = await capability(cam);
      if (!cap.token) throw new AppError('ptz_profile_missing');
      // PER AXIS (spec 2026-10-17, section 3): a camera with continuous-only zoom still saves pan/tilt
      if (!cap.absolutePanTilt && !cap.absoluteZoom) throw new AppError('camera_no_absolute_position');
      // the position comes from the DEVICE, as text (spec 4.4)
      const { r } = await callOnvif(cam, (a) => deps.onvif.ptzPosition({ ...a, token: cap.token }));
      // only the EMPTY position is an error: the axes come from the attribute (string) or null, one by one
      if (!r || (r.pan === null && r.tilt === null && r.zoom === null)) throw new AppError('ptz_position_missing');
      const used = new Set(positions.map((p) => savedNumber(p.name)).filter((n) => n !== null));
      let n = null;
      for (let i = 1; i <= SAVED_LIMIT; i += 1) if (!used.has(i)) { n = i; break; }
      const created = {
        id: positions.reduce((max, p) => Math.max(max, p.id || 0), 0) + 1,
        name: `Position ${n}`, pan: r.pan, tilt: r.tilt, zoom: r.zoom,
        spacePanTilt: r.spacePanTilt, spaceZoom: r.spaceZoom, created_ts: iso(),
      };
      await patchMeta(id, { positions: [...positions, created] });
      return { id: created.id, name: created.name };
    },

    'POST /api/v1/cameras/:id/ptz/positions/goto': async ({ id, position } = {}) => {
      const cam = await requireCamera(id);
      const p = findPosition(cam, position);
      const cap = await capability(cam);
      if (!cap.token) throw new AppError('ptz_profile_missing');
      // An axis without an absolute value does not enter the command (spec 2026-10-17, section 3), and each
      // axis carries the `space` that was stored with it: the null does not leak into AbsoluteMove.
      const target = {
        ...(p.pan != null && p.tilt != null ? { pan: p.pan, tilt: p.tilt, spacePanTilt: p.spacePanTilt } : {}),
        ...(p.zoom != null ? { zoom: p.zoom, spaceZoom: p.spaceZoom } : {}),
      };
      if (!Object.keys(target).length) throw new AppError('position_without_absolute_axis');
      await callOnvif(cam, (a) => deps.onvif.ptzGotoAbsolute({ ...a, token: cap.token, ...target }));
      return { ok: true };
    },

    'PATCH /api/v1/cameras/:id/ptz/positions': async ({ id, position, name } = {}) => {
      const cam = await requireCamera(id);
      const target = findPosition(cam, position);
      const nextName = String(name || '').trim().slice(0, 60);
      if (!nextName) throw new AppError('name_required');
      // renaming is LOCAL: does not talk to the camera and does NOT MOVE it (spec 2)
      await patchMeta(id, {
        positions: positionsOf(cam).map((p) => (p.id === target.id ? { ...p, name: nextName } : p)),
      });
      return { id: target.id, name: nextName };
    },

    'DELETE /api/v1/cameras/:id/ptz/positions': async ({ id, position } = {}) => {
      const cam = await requireCamera(id);
      const target = findPosition(cam, position);
      // deleting is LOCAL: no RemovePreset on the device
      await patchMeta(id, { positions: positionsOf(cam).filter((p) => p.id !== target.id) });
      return { ok: true };
    },

    // ---- zoom into the marked area (spec 2026-10-18) ----
    // The client sends the box normalized against the video shown; the math (FOV, pan, tilt, zoom) belongs
    // to the SERVER, as in Nx (spec 2). One single-shot command per gesture: no dead-man, nothing to stop.
    'POST /api/v1/cameras/:id/ptz/viewport-zoom': async ({ id, left, top, right, bottom, aspect } = {}, req, ctx) => {
      const cam = await requireCamera(id);
      const box = readBox({ left, top, right, bottom });
      const cap = await capability(cam);
      if (!cap.token) throw new AppError('ptz_profile_missing');
      // the whole gesture depends on an absolute position (spec 5.3): without it there is no from and no to
      // the message does NOT repeat "PTZ" because the cell chip already prefixes it (amendment E7)
      if (!cap.absolute) throw new AppError('ptz_absolute_unavailable');
      const { r } = await callOnvif(cam, (a) => deps.onvif.ptzPosition({ ...a, token: cap.token }));
      if (!r || r.pan === null || r.tilt === null || r.zoom === null) throw new AppError('ptz_position_missing');
      const meta = cam.meta || {};
      const mv = computeMovement({ caixa: box, state: r, fovGrau: meta.fov_grau, aspecto: aspect,
        fovMinGrau: meta.fov_min_grau, fovMaxGrau: meta.fov_max_grau });
      await callOnvif(cam, (a) => deps.onvif.ptzGotoAbsolute({ ...a, token: cap.token,
        pan: mv.pan, tilt: mv.tilt, zoom: mv.zoom, spacePanTilt: r.spacePanTilt, spaceZoom: r.spaceZoom }));
      // amendment E13: the origin enters AFTER the GOOD movement. If AbsoluteMove fails (502), no zoom
      // happened — marking "there was a zoom" would make the next unzoom send the camera to an origin it
      // never left. The FIRST box of the SESSION (the token key) defines the return; the following ones
      // only renew the TTL (active session) and do not overwrite it.
      const now = Date.now();
      prunePreZoom(now);
      const key = `${ownerOf(req, ctx)}:${id}`;
      const entry = preZoom.get(key);
      if (entry) entry.ts = now;
      else preZoom.set(key, { origin: r, ts: now });
      return { ok: true };
    },

    // Nx's `ptzUnzoom` (spec 5.4): a double click on the cell in PTZ mode returns to where the camera was
    // before the first area zoom of that operator's SESSION — the token key, not the account (amendment
    // E13/E18): two tabs of the same user are two sessions and do not share the origin.
    'POST /api/v1/cameras/:id/ptz/viewport-unzoom': async ({ id } = {}, req, ctx) => {
      const cam = await requireCamera(id);
      // the origin 409 comes BEFORE the capability: with no zoom in this session there is nothing to undo
      // and no reason to probe the device.
      const now = Date.now();
      prunePreZoom(now);
      const key = `${ownerOf(req, ctx)}:${id}`;
      const entry = preZoom.get(key);
      if (!entry) throw new AppError('area_zoom_missing');
      const cap = await capability(cam);
      if (!cap.token) throw new AppError('ptz_profile_missing');
      // amendment E15: same gate as zoom — a capability that turned continuous-only answers 409 instead of
      // sending an AbsoluteMove the device would refuse (fault).
      if (!cap.absolute) throw new AppError('ptz_absolute_unavailable');
      await callOnvif(cam, (a) => deps.onvif.ptzGotoAbsolute({ ...a, token: cap.token,
        pan: entry.origin.pan, tilt: entry.origin.tilt, zoom: entry.origin.zoom,
        spacePanTilt: entry.origin.spacePanTilt, spaceZoom: entry.origin.spaceZoom }));
      preZoom.delete(key);
      return { ok: true };
    },
  };
}

module.exports = { ptzRoutes, DEADMAN_MS, SAVED_LIMIT, PTZ_SHAPE, PREZOOM_TTL_MS };

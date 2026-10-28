'use strict';
const { cameraRoles } = require('./roles');
const { publishPath, removePath, listPaths, reconcile: reconcileHub } = require('./hub-config');

// Publishing the Hub paths (spec 2026-10-16): the Hub is what pulls the camera, on demand. This
// module only says WHICH path exists and with WHICH source; the source (with the credential) arrives
// ready from deps.cameraSource, assembled in main.js — no camera URL is born here.
// The store is the only source (postgres plan 1.6): cameras and profiles are rows, never a document.
async function desiredPaths(store, deps, conf) {
  const [cameras, profiles] = await Promise.all([
    store.catalog.cameras.listCatalog(),
    store.catalog.profiles.listAll(),
  ]);
  // roles.js takes the camera's profile_ids and a map of profiles: both come from the profiles table.
  const byId = {};
  const idsPerCamera = new Map();
  for (const p of profiles) {
    byId[p.id] = p;
    if (!idsPerCamera.has(p.camera_id)) idsPerCamera.set(p.camera_id, []);
    idsPerCamera.get(p.camera_id).push(p.id);
  }
  const out = {};
  for (const cam of cameras) {
    // An inactive camera (meta.ativa false, absent = active) is out of the Hub: reconcile drops its paths.
    if (cam.meta && cam.meta.ativa === false) continue;
    const roles = { id: cam.id, profile_ids: idsPerCamera.get(cam.id) || [] };
    const { primary, secondary } = cameraRoles(roles, byId);
    if (!primary) continue;
    out[cam.id] = { source: deps.cameraSource(primary),
      startTimeout: conf.hubStartTimeout, closeAfter: conf.hubCloseAfter };
    if (secondary) out[`${cam.id}/sub`] = { source: deps.cameraSource(secondary),
      startTimeout: conf.hubStartTimeout, closeAfter: conf.hubCloseAfter };
  }
  return out;
}

async function publishCamera(base, { store, deps, conf, cam }) {
  const all = await desiredPaths(store, deps, conf);
  const paths = Object.entries(all).filter(([name]) => name === cam.id || name === `${cam.id}/sub`);
  for (const [name, cfg] of paths) await publishPath(base, name, cfg);
  return paths.map(([name]) => name);
}

async function removeCamera(base, camId) {
  await removePath(base, camId);
  await removePath(base, `${camId}/sub`);
}

// Reapplies every desired path at once: the caller (main.js) only has to name the store.
// Prune too: the hub-config primitive only adds or updates, so a path whose camera stopped wanting
// it (inactive, or lost the profile) would keep pulling the camera on demand. Only paths owned by a
// KNOWN camera id drop — the `all_others` default and anything foreign stay untouched.
async function reconcile(base, { store, deps, conf }) {
  const desired = await desiredPaths(store, deps, conf);
  const out = await reconcileHub(base, desired);
  const cameras = await store.catalog.cameras.listCatalog();
  const known = new Set(cameras.map((c) => c.id));
  const dropped = [];
  for (const p of await listPaths(base)) {
    if (desired[p.name] || !known.has(p.name.split('/')[0])) continue;
    await removePath(base, p.name);
    dropped.push(p.name);
  }
  out.dropped = dropped;
  return out;
}

module.exports = { desiredPaths, publishCamera, removeCamera, reconcile };

'use strict';
const crypto = require('node:crypto');
const { AppError } = require('./errors');

// Access model from spec 2026-10-17 (§5). SYSTEM profiles are fixed (admin/operator/viewer) and
// hold by definition, even without `access_profiles` in the document (minimal fixture and a
// freshly created document before the migration). CUSTOM profiles live in `access_profiles` and
// answer for the grants. The keys do NOT collide with `profiles`, which is the VIDEO profile (§5).
const SYSTEM_PROFILES = ['admin', 'operator', 'viewer'];
const RESERVED_NAMES = [...SYSTEM_PROFILES, 'installer'];
const LEVELS = ['view', 'control'];
const LEVEL_ORDER = { none: 0, view: 1, control: 2 };
// D4: installer migrates to operator (§11.3). This is the MIGRATOR map — its consumer is
// `lib/access-migration.js`, reading the `role` of the OLD document. No live route resolves a role
// through it since F4 (the login reads `profile_id`; the signup requires `profile_id`).
const ROLE_MAP = { admin: 'admin', operator: 'operator', viewer: 'viewer', installer: 'operator' };

function isValidProfile(m, id) {
  if (typeof id !== 'string' || !id) return false;
  if (SYSTEM_PROFILES.includes(id)) return true;
  const p = (m.access_profiles || {})[id];
  return !!(p && p.kind === 'custom');
}

function newRecord(id, name, kind, now) {
  return { id, name, kind, created_at: now, updated_at: now };
}

// Creates the system profiles of a fresh installation; idempotent (the migration may run again).
function createSystemProfiles(m, now = new Date().toISOString()) {
  m.access_profiles ||= {};
  m.camera_grants ||= {};
  let created = 0;
  for (const id of SYSTEM_PROFILES) {
    if (m.access_profiles[id]) continue;
    m.access_profiles[id] = newRecord(id, id, 'system', now);
    created++;
  }
  return created;
}

function normalizeName(name) { return String(name == null ? '' : name).trim(); }

function nameInUse(m, name, exceptId) {
  return Object.values(m.access_profiles || {})
    .some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
}

function validateName(m, name, exceptId) {
  const n = normalizeName(name);
  if (!n) throw new AppError('access_profile_name_required');
  if (RESERVED_NAMES.includes(n.toLowerCase())) throw new AppError('access_profile_name_reserved', { name: n });
  if (nameInUse(m, n, exceptId)) throw new AppError('access_profile_exists', { name: n });
  return n;
}

// Custom profile OR throw: a system profile is never editable, not even through the API (§7.2).
function requireCustom(m, id) {
  const p = (m.access_profiles || {})[id];
  if (!p) throw new AppError('access_profile_not_found', { id });
  if (p.kind !== 'custom') throw new AppError('access_profile_system_immutable', { id });
  return p;
}

function createProfile(m, { name } = {}) {
  const n = validateName(m, name, null);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  m.access_profiles ||= {};
  m.camera_grants ||= {};
  m.access_profiles[id] = newRecord(id, n, 'custom', now);
  m.camera_grants[id] = {};
  return m.access_profiles[id];
}

function renameProfile(m, id, name) {
  const p = requireCustom(m, id);
  p.name = validateName(m, name, id);   // renaming does NOT change the id (invariant §5)
  p.updated_at = new Date().toISOString();
  return p;
}

function profileUsers(m, id) {
  return Object.values(m.users || {}).filter((u) => u.profile_id === id).map((u) => u.username);
}

// D6: a profile in use is refused (409) until the users are reassigned by hand.
function deleteProfile(m, id) {
  requireCustom(m, id);
  const inUse = profileUsers(m, id);
  if (inUse.length) throw new AppError('access_profile_in_use', { profiles: inUse.join(', ') });
  delete m.access_profiles[id];
  delete (m.camera_grants || {})[id];
  return { deleted: id };
}

function setGrant(m, profileId, cameraId, level) {
  requireCustom(m, profileId);
  if (typeof cameraId !== 'string' || !cameraId) throw new AppError('camera_required');
  if (!LEVELS.includes(level)) throw new AppError('level_invalid', { levels: LEVELS.join(', ') });
  m.camera_grants ||= {};
  m.camera_grants[profileId] ||= {};
  m.camera_grants[profileId][cameraId] = level;
  return { profile_id: profileId, camera_id: cameraId, level };
}

function removeGrant(m, profileId, cameraId) {
  requireCustom(m, profileId);
  const g = (m.camera_grants || {})[profileId];
  if (g) delete g[cameraId];
  return { deleted: cameraId };
}

// `none` is the ABSENCE of a grant: a freshly created camera is denied on every custom profile (§5).
function grantLevel(m, profileId, cameraId) {
  return (((m.camera_grants || {})[profileId] || {})[cameraId]) || 'none';
}

function camerasWithLevel(m, profileId, level = 'view') {
  const min = LEVEL_ORDER[level] || LEVEL_ORDER.view;
  return Object.entries(((m.camera_grants || {})[profileId] || {}))
    .filter(([, l]) => (LEVEL_ORDER[l] || 0) >= min)
    .map(([cameraId]) => cameraId);
}

// §8: the same engine predicate over the SNAPSHOT — whoever reads media (Hub callback, read token)
// only has the snapshot in hand, not the store. A system profile reaches every camera; a custom one
// depends on the grant; `none` (missing grant) is denied. `control` implies `view` (LEVEL_ORDER).
function canAccessCamera(m, profileId, cameraId, level = 'view') {
  if (SYSTEM_PROFILES.includes(profileId)) return true;
  const min = LEVEL_ORDER[level] || LEVEL_ORDER.view;
  return (LEVEL_ORDER[grantLevel(m, profileId, cameraId)] || 0) >= min;
}

function profileGrants(m, profileId) {
  return Object.entries(((m.camera_grants || {})[profileId] || {}))
    .map(([camera_id, level]) => ({ camera_id, level }))
    .sort((a, b) => a.camera_id.localeCompare(b.camera_id));
}

function publicProfile(m, id) {
  const p = (m.access_profiles || {})[id];
  if (!p) return null;
  // a system profile has GLOBAL scope: do not duplicate grants (invariant §5)
  return p.kind === 'system' ? { ...p, grants: [] } : { ...p, grants: profileGrants(m, id) };
}

function publicProfiles(m) {
  return Object.keys(m.access_profiles || {})
    .map((id) => publicProfile(m, id))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'system' ? -1 : 1));
}

module.exports = {
  SYSTEM_PROFILES, RESERVED_NAMES, LEVELS, LEVEL_ORDER, ROLE_MAP,
  isValidProfile, createSystemProfiles, createProfile, renameProfile, requireCustom,
  profileUsers, deleteProfile, setGrant, removeGrant, grantLevel, canAccessCamera,
  camerasWithLevel, profileGrants, publicProfile, publicProfiles,
};

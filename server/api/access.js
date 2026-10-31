'use strict';
const { SYSTEM_PROFILES, RESERVED_NAMES, LEVELS } = require('../lib/access');
const { AppError } = require('../lib/errors');

// ACCESS PROFILE routes (spec 2026-10-17 §7.2/§10) over the relational store. The path name is
// `/profiles/access` because `/api/v1/profiles` is ALREADY the VIDEO profile — the name collision is
// real (spec §2) and neither route is reused. Every route here carries `profiles.manage` (D1); `mine`
// is `session` scoped and therefore receives the dispatcher `ctx` instead of looking at the token.
//
// The document model is out of this file: rules that read the whole document (duplicate name, users
// of a profile) are store reads now. lib/access.js still owns the system ids, reserved names, levels
// and the snapshot predicates (canAccessCamera) the media path uses.

// The repository rejects a bad limit/offset/sort/dir with a coded Error; the HTTP contract is 400.
const PAGING = new Set(['limit_invalid', 'offset_invalid', 'sort_invalid', 'dir_invalid']);

async function profilesPage(access, p = {}) {
  try {
    return await access.profilesListPaged(p);
  } catch (e) {
    if (PAGING.has(e.code)) throw new AppError('bad_request', { message: e.code });
    throw e;
  }
}

// Custom profile OR throw: a system profile is never editable, not even through the API (§7.2).
async function requireCustom(access, id) {
  const p = await access.profileGet(id);
  if (!p) throw new AppError('access_profile_not_found', { id });
  if (p.kind !== 'custom') throw new AppError('access_profile_system_immutable', { id });
  return p;
}

// The name is unique per lower(name) in the schema; the pre-check keeps the contract in the code (and
// in the in-memory store) instead of turning a constraint violation into a 500.
async function assertNameFree(access, name, exceptId) {
  const { items } = await profilesPage(access, { q: name, limit: 100 });
  const key = name.toLowerCase();
  if (items.some((p) => p.id !== exceptId && p.name.toLowerCase() === key)) {
    throw new AppError('access_profile_exists', { name });
  }
}

async function validateName(access, name, exceptId) {
  const n = String(name == null ? '' : name).trim();
  if (!n) throw new AppError('access_profile_name_required');
  if (RESERVED_NAMES.includes(n.toLowerCase())) throw new AppError('access_profile_name_reserved', { name: n });
  await assertNameFree(access, n, exceptId);
  return n;
}

// The grants arrive from JSON: camera id and level are checked at the boundary, before the write.
function cleanGrants(grants = []) {
  for (const g of grants) {
    if (typeof g.camera_id !== 'string' || !g.camera_id) throw new AppError('camera_required');
    if (!LEVELS.includes(g.level)) throw new AppError('level_invalid', { levels: LEVELS.join(', ') });
  }
  return grants.map((g) => ({ camera_id: g.camera_id, level: g.level }));
}

// The repository pages users by q/status; the profile filter is the joined profile_name, so the page
// is filtered by profile_id here. 100 is the hard page size, so this walks while there is more.
async function profileUsers(access, profile) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const { items, total } = await access.usersListPaged({ q: profile.name, limit: 100, offset });
    out.push(...items.filter((u) => u.profile_id === profile.id).map((u) => u.username));
    if (offset + 100 >= total) return out;
  }
}

// §7.2: changing the ACL revokes the authorization IN FLIGHT — the sessions of the profile users drop
// and `credential_version` goes up, which also invalidates the media token already in the browser's
// hand (spec §8). Per user, because the repository writes one user at a time.
async function revoke(store, profile) {
  for (const username of await profileUsers(store.access, profile)) {
    const u = await store.access.userGet(username);
    if (!u) continue;
    for (const s of await store.sessions.listByUser(username)) await store.sessions.remove(s.token_hash);
    await store.access.userUpdate(username, { credential_version: Number(u.credential_version || 0) + 1 });
  }
}

// A system profile has GLOBAL scope: do not duplicate grants (invariant §5).
async function publicProfile(access, id) {
  const p = await access.profileGet(id);
  if (!p) return null;
  return { ...p, grants: p.kind === 'system' ? [] : await access.grantsOf(id) };
}

function accessRoutes(store) {
  const access = store.access;
  // The 3 system profiles are VALID by definition (spec §5) and `users.profile_id` points at them, yet
  // the migration does not create the rows. The first call creates the missing ones; idempotent and
  // memoized, so the steady state costs nothing.
  let ensured;
  const ensureSystem = () => {
    ensured ||= (async () => {
      for (const id of SYSTEM_PROFILES) {
        if (!(await access.profileGet(id))) await access.profileCreate({ id, name: id, kind: 'system' });
      }
    })().catch((e) => { ensured = null; throw e; });
    return ensured;
  };

  return {
    'GET /api/v1/profiles/access': async (args = {}) => {
      await ensureSystem();
      return profilesPage(access, args);
    },

    'POST /api/v1/profiles/access': async (body = {}) => {
      await ensureSystem();
      // the body is validated before anything is written: a bad grant must not leave a half profile
      const grants = Array.isArray(body.grants) ? cleanGrants(body.grants) : null;
      const name = await validateName(access, body.name, null);
      const created = await access.profileCreate({ name });
      // the UI creates the profile and marks the cameras right away: one POST, not two
      if (grants) await access.setGrants(created.id, grants);
      return publicProfile(access, created.id);
    },

    'PATCH /api/v1/profiles/access/:id': async ({ id, name, grants } = {}) => {
      await ensureSystem();
      const current = await requireCustom(access, id);        // 404/409 even when only the grants change
      const next = Array.isArray(grants) ? cleanGrants(grants) : null;
      if (name !== undefined) await access.profileUpdate(id, { name: await validateName(access, name, id) });
      if (next) {
        await access.setGrants(id, next);                     // replace, one transaction in the repository
        await revoke(store, current);
      }
      return publicProfile(access, id);
    },

    'DELETE /api/v1/profiles/access/:id': async ({ id } = {}) => {
      await ensureSystem();
      const profile = await requireCustom(access, id);
      // D6: a profile in use is refused (409) until the users are reassigned by hand.
      const inUse = await profileUsers(access, profile);
      if (inUse.length) throw new AppError('access_profile_in_use', { profiles: inUse.join(', ') });
      await access.profileRemove(id);
      return { deleted: id };
    },

    // §10: read the OWN profile (the UI hides what it may not do). The dispatcher passes the `ctx`
    // with the session user — this route neither receives nor reads a token.
    'GET /api/v1/profiles/access/mine': async (_args, _req, ctx) => {
      const profileId = ctx && ctx.user && ctx.user.profile_id;
      const p = profileId && await publicProfile(access, profileId);
      if (!p) throw new AppError('access_profile_not_found');
      return p;
    },

    // The editor opens the camera matrix from here; grants are small (bounded by the camera count).
    'GET /api/v1/profiles/access/:id/grants': async ({ id } = {}) => access.grantsOf(id),
  };
}

module.exports = { accessRoutes };

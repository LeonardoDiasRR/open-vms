'use strict';
const { hashPassword, validatePasswordPolicy, generateTemporaryPassword } = require('../lib/password');
const { SYSTEM_PROFILES } = require('../lib/access');
const { AppError } = require('../lib/errors');
const tokens = require('../lib/read-token');

// ponytail: one sanitizing helper — the secret_hash never crosses the HTTP boundary. `profile_name`
// only comes from the paged list (the JOIN, spec §5) and `created_at` only from a record read by
// username, so a field the row does not carry is not invented here.
function publicUser(u) {
  const out = { username: u.username, profile_id: u.profile_id, status: u.status,
    must_change_password: u.must_change_password === true };
  if (u.profile_name !== undefined) out.profile_name = u.profile_name;
  if (u.created_at !== undefined) out.created_at = u.created_at;
  return out;
}

// The list reads are capped at 100 rows per page: walk the pages until the predicate hits or the set
// ends. It keeps the existence checks honest on an old installation with many users or profiles.
async function findAcrossPages(read, hit) {
  for (let offset = 0; ; offset += 100) {
    const { items, total } = await read({ limit: 100, offset });
    const found = items.find(hit);
    if (found) return found;
    if (offset + 100 >= total) return null;
  }
}

// §5: the 3 system profiles are valid by definition; a custom one has to exist in access_profiles.
async function requireProfile(store, id) {
  if (typeof id === 'string' && id) {
    if (SYSTEM_PROFILES.includes(id)) return;
    if (await findAcrossPages((p) => store.access.profilesListPaged(p), (r) => r.id === id)) return;
  }
  throw new AppError('access_profile_invalid', { id: id || '(empty)' });
}

// The last ACTIVE admin does not fall (§12 F1): without it nobody manages users or profiles anymore.
// Asked as "is there ANOTHER active admin?" — the user list has no profile filter to lean on, so the
// admin rows are found across the pages.
async function hasAnotherActiveAdmin(store, username) {
  const found = await findAcrossPages(
    (p) => store.access.usersListPaged({ ...p, status: 'active' }),
    (u) => u.profile_id === 'admin' && u.username !== username,
  );
  return found !== null;
}

// Immediate revocation (§7.3): the user sessions drop. The `credential_version` bump that also kills
// the media token already in the browser's hand (spec §6) rides on the SAME update as the change.
async function dropSessions(store, username) {
  for (const s of await store.sessions.listByUser(username)) await store.sessions.remove(s.token_hash);
}

// admin is the root account created at boot: immutable (spec 2026-10-18 admin-immutable). The
// comparison is against the literal name. The only accepted action is the password reset, which has
// its own route and does not pass through here.
const ROOT_ADMIN = 'admin';

// The pagination contract lives in the repository: it rejects a bad query with its own code and no
// HTTP status. A bad table query is the CALLER's mistake, so it leaves as 400 with the published code.
const QUERY_CODES = new Set(['limit_invalid', 'offset_invalid', 'sort_invalid', 'dir_invalid']);

function userRoutes(store) {
  const access = store.access;

  return {
    // spec §5: server-side DataTable — filter, order and page in the database, `total` over the
    // filtered set (never the page).
    'GET /api/v1/users': async (query = {}) => {
      let page;
      try {
        page = await access.usersListPaged(query);
      } catch (e) {
        if (!QUERY_CODES.has(e.code)) throw e;
        throw Object.assign(new AppError(e.code), { status: 400 });
      }
      return { ...page, items: page.items.map(publicUser) };
    },

    'POST /api/v1/users': async (body = {}) => {
      // trust-boundary defence: the body comes from JSON, the type is not trusted
      const { username, password } = body;
      if (typeof username !== 'string' || !username.trim()) throw new AppError('username_required');
      // §9: minimum 12 on CREATION (login is not policed — an old user with a short password keeps
      // getting in and is refused on the next change).
      validatePasswordPolicy(password);
      // spec §10: the legacy body with `role` left in F4 — only `profile_id` gets in
      const profileId = typeof body.profile_id === 'string' && body.profile_id ? body.profile_id : null;
      if (!profileId) throw new AppError('access_profile_required');
      await requireProfile(store, profileId);
      if (await access.userGet(username)) throw new AppError('user_exists', { username });
      const secret_hash = await hashPassword(password);
      let created;
      try {
        created = await access.userCreate({ username, profile_id: profileId, status: 'active',
          secret_hash, must_change_password: true, credential_version: 1 });
      } catch (e) {
        // two creates for the same name at once: the primary key decides, and the answer is the same
        if (e.code === '23505') throw new AppError('user_exists', { username });
        throw e;
      }
      return publicUser(created);
    },

    'PATCH /api/v1/users/:username': async ({ username, profile_id, status } = {}) => {
      const u = await access.userGet(username);
      if (!u) throw new AppError('user_not_found');
      if (username === ROOT_ADMIN) throw new AppError('admin_immutable');
      if (profile_id !== undefined) await requireProfile(store, profile_id);
      if (status !== undefined && status !== 'active' && status !== 'disabled') {
        throw new AppError('user_status_invalid');
      }
      const demoting = profile_id !== undefined && profile_id !== 'admin' && u.profile_id === 'admin';
      const disabling = status === 'disabled' && u.status !== 'disabled';
      const lastActiveAdmin = u.profile_id === 'admin' && u.status !== 'disabled';
      if ((demoting || disabling) && lastActiveAdmin && !(await hasAnotherActiveAdmin(store, username))) {
        throw new AppError('last_admin_required');
      }
      const next = await access.userUpdate(username, {
        ...(profile_id !== undefined ? { profile_id } : {}),
        ...(status !== undefined ? { status } : {}),
        credential_version: Number(u.credential_version || 0) + 1,
      });
      await dropSessions(store, username);
      if (!next) throw new AppError('user_not_found');   // removed between the read and the update
      return publicUser(next);
    },

    'DELETE /api/v1/users/:username': async ({ username } = {}) => {
      const u = await access.userGet(username);
      if (!u) throw new AppError('user_not_found');
      if (username === ROOT_ADMIN) throw new AppError('admin_immutable');
      const lastActiveAdmin = u.profile_id === 'admin' && u.status !== 'disabled';
      if (lastActiveAdmin && !(await hasAnotherActiveAdmin(store, username))) {
        throw new AppError('last_admin_required');
      }
      // the sessions go with the row (ON DELETE CASCADE)
      await access.userRemove(username);
      return { deleted: username };
    },

    // §7.1.5 + §10: the admin does NOT know the previous password. They get a TEMPORARY password once
    // (outside logs, audit and the database), the user sessions drop and `credential_version` goes up —
    // the media token in the browser dies too (§6). The mandatory change applies again, and that is
    // what the reset has over an "admin password change".
    'POST /api/v1/users/:username/reset-password': async ({ username } = {}) => {
      const u = await access.userGet(username);
      if (!u) throw new AppError('user_not_found');
      const temporary = generateTemporaryPassword();
      const hash = await hashPassword(temporary);
      await access.userUpdate(username, { secret_hash: hash, must_change_password: true,
        credential_version: Number(u.credential_version || 0) + 1 });
      await dropSessions(store, username);
      return { username, temporary_password: temporary, must_change_password: true };
    },

    // spec 2026-10-18 (4.6): renaming is its own route, shaped like reset-password. The NAME is the
    // primary key, so the repository moves the record (`access.userRename`: one transaction with
    // INSERT ... SELECT, the session repoint and the DELETE of the old row) — password, profile,
    // status and credential version travel with it, and whoever is logged in stays logged in, just
    // under the new name. MEDIA is not cut either: the read token keeps its owner, so their tokens
    // are repointed (otherwise `isValid` would revalidate the old name and the browser would lose
    // live until the next `POST /api/v1/live/token`).
    // The last admin rule does not apply (the profile does not change) and a duplicate name is decided
    // HERE, never in the client (E5).
    'POST /api/v1/users/:username/rename': async ({ username, new_username } = {}) => {
      const u = await access.userGet(username);
      if (!u) throw new AppError('user_not_found');
      if (username === ROOT_ADMIN) throw new AppError('admin_immutable');
      const next = typeof new_username === 'string' ? new_username.trim() : '';
      if (!next) throw new AppError('new_username_required');
      if (next === username) throw new AppError('username_unchanged');
      if (await access.userGet(next)) throw new AppError('user_exists', { username: next });
      const created = await access.userRename(username, next);
      if (!created) throw new AppError('user_not_found');  // removed between the read and the rename
      // outside the store: the token store is not a table — it is the same module the mediamtx
      // callback consults, so the repoint takes effect on the next request
      tokens.repoint(username, next);
      return publicUser(created);
    },
  };
}

module.exports = { userRoutes };

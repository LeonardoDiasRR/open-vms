'use strict';
// In-memory store with the same public interface as server/repo/catalog.js and
// server/repo/store-ops.js, for the route tests that used to build a fake `state` with
// get()/mutate(). The SQL repositories keep their own integration tests against Postgres;
// this file has no database, no I/O and no dependency.
//
// `mem` is the document itself (one array per table, same key names as the schema): tests
// assert on it directly, so writes stay visible there instead of being hidden behind clones.

const crypto = require('node:crypto');

const uuid = () => crypto.randomUUID();
const iso = () => new Date().toISOString();
const copy = (row) => (row ? { ...row } : null);
const copies = (rows) => rows.map(copy);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (v) => String(v == null ? '' : v).toLowerCase();
const fail = (code) => Object.assign(new Error(code), { code });

// Query strings arrive as text: coerce, then require a real integer in range. Absent means default.
function intParam(value, fallback, min, max, code) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(code);
  return n;
}

// Same contract as store-ops.js: 1..100 rows (default 10), offset >= 0, closed sort list,
// tiebreaker always ascending so two pages never repeat or skip a row.
function paging(p = {}, sorts, defaultSort, tie) {
  const limit = intParam(p.limit, 10, 1, 100, 'limit_invalid');
  const offset = intParam(p.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset_invalid');
  const requested = p.sort === undefined || p.sort === null || p.sort === '' ? defaultSort : p.sort;
  const key = sorts[requested];
  if (!key) throw fail('sort_invalid');
  const dir = p.dir === undefined || p.dir === null || p.dir === '' ? 'asc' : String(p.dir).toLowerCase();
  if (dir !== 'asc' && dir !== 'desc') throw fail('dir_invalid');
  return { limit, offset, key, dir, tie };
}

// total is the size of the filtered set, not of the page: a page past the end still owes it.
function page(rows, { limit, offset, key, dir, tie }) {
  const sign = dir === 'desc' ? -1 : 1;
  const items = rows
    .slice()
    .sort((a, b) => sign * cmp(key(a), key(b)) || cmp(tie(a), tie(b)))
    .slice(offset, offset + limit);
  return { items, total: rows.length, limit, offset };
}

// ILIKE with an escaped pattern matches a literal substring: % and _ typed in the box are data.
const matches = (q, ...fields) => (row) =>
  q === undefined || q === null || q === '' || fields.some((f) => text(f(row)).includes(text(q)));

const CAMERA_COLS = ['name', 'state', 'added_via', 'recording', 'error_code', 'credential_ref',
  'device_id', 'group_id', 'meta'];
const PROFILE_COLS = ['name', 'source_url', 'recording_mode', 'width', 'height', 'onvif_token'];
const GROUP_COLS = ['name', 'parent_id'];
const USER_COLS = ['profile_id', 'status', 'secret_hash', 'must_change_password', 'credential_version'];
const ACCESS_PROFILE_COLS = ['name', 'kind'];

// Column whitelist per ops table; also carries the defaults the schema would apply on insert.
const OPS_TABLES = {
  layouts: { cols: ['name', 'cells', 'created_ts', 'updated_ts'], defaults: () => ({ cells: [], created_ts: iso(), updated_ts: iso() }) },
  exports: { cols: ['stream_profile_id', 'camera_name', 'name', 'description', 'from_ts', 'to_ts', 'state', 'progresso', 'path', 'bytes', 'error', 'created_at', 'updated_at'], defaults: () => ({ progresso: 0, created_at: iso(), updated_at: iso() }) },
  scans: { cols: ['kind', 'state', 'scope', 'found', 'error', 'started_ts', 'finished_ts'], defaults: () => ({ found: 0, started_ts: iso() }) },
  candidates: { cols: ['scan_id', 'ip', 'xaddr', 'name', 'manufacturer', 'model', 'status', 'outcome', 'seen_count', 'video_sources', 'open_ports', 'first_seen_at', 'last_seen_at'], defaults: () => ({ seen_count: 1, video_sources: [], open_ports: [], first_seen_at: iso(), last_seen_at: iso() }) },
};

// `meta` mirrors CAMERA_TREE_FIELDS: the list route flattens `ativa` from it and strips the column.
const CAMERA_TREE = (c) => ({
  id: c.id, name: c.name, state: c.state, added_via: c.added_via, recording: c.recording,
  error_code: c.error_code, credential_ref: c.credential_ref, group_id: c.group_id, device_id: c.device_id,
  created_at: c.created_at, updated_at: c.updated_at, meta: c.meta,
});
const PROFILE_FIELDS = (p) => ({
  id: p.id, camera_id: p.camera_id, name: p.name, source_url: p.source_url,
  recording_mode: p.recording_mode, width: p.width, height: p.height,
  onvif_token: p.onvif_token, created_at: p.created_at,
});
const GROUP_FIELDS = (g) => ({ id: g.id, name: g.name, parent_id: g.parent_id, created_at: g.created_at });
const DEVICE_FIELDS = (d) => ({ id: d.id, name: d.name, created_at: d.created_at, meta: d.meta });

function memStore(initial = {}) {
  // The caller's object is the document: seeding { cameras: [...] } and asserting on it later
  // must see the same object the store writes to.
  const mem = initial;
  const tables = {
    cameras: [], camera_addresses: [], profiles: [], groups: [], credentials: [], devices: [],
    users: [], sessions: [], access_profiles: [], camera_grants: [],
    layouts: [], scans: [], candidates: [], exports: [], gaps: [], events: [],
  };
  for (const [table, rows] of Object.entries(tables)) {
    if (mem[table] === undefined) mem[table] = rows;
  }

  // ponytail: a plain counter, not a sequence with its own state; tests only compare revisions.
  let rev = 0;
  const bump = () => { rev += 1; };

  const row = (table, key, value) => mem[table].find((r) => r[key] === value) || null;
  const drop = (table, key, value) => {
    const i = mem[table].findIndex((r) => r[key] === value);
    if (i < 0) return false;
    mem[table].splice(i, 1);
    return true;
  };

  // ---------------------------------------------------------------- catalog: cameras

  const camera = {
    async listCatalog() {
      return mem.cameras.slice().sort((a, b) => cmp(text(a.name), text(b.name)) || cmp(a.id, b.id))
        .map(CAMERA_TREE);
    },

    async get(id) {
      return copy(row('cameras', 'id', id));
    },

    async addresses(cameraId) {
      return mem.camera_addresses
        .filter((a) => a.camera_id === cameraId)
        .sort((a, b) => a.ord - b.ord)
        .map((a) => a.address);
    },

    // Replaces the whole address list at once, like the SQL repository: a repair writes the list
    // it believes in. ord follows the array order, 1-based as in create.
    async replaceAddresses(cameraId, list) {
      mem.camera_addresses = mem.camera_addresses.filter((a) => a.camera_id !== cameraId);
      list.forEach((address, i) => {
        mem.camera_addresses.push({ camera_id: cameraId, ord: i + 1, address });
      });
      bump();
      return list;
    },

    // Every camera address in one read (one query beats one per camera in the discovery results).
    async allAddresses() {
      return mem.camera_addresses.map((a) => ({ camera_id: a.camera_id, address: a.address }));
    },

    async create(cam) {
      const id = cam.id || uuid();
      const created = {
        id,
        name: cam.name,
        state: cam.state ?? 'provisioning',
        added_via: cam.added_via ?? null,
        recording: cam.recording ?? false,
        error_code: cam.error_code ?? null,
        credential_ref: cam.credential_ref ?? null,
        device_id: cam.device_id ?? null,
        group_id: cam.group_id ?? null,
        created_at: iso(),
        updated_at: iso(),
        meta: cam.meta ?? {},
      };
      mem.cameras.push(created);
      (cam.addresses || []).forEach((address, i) => {
        mem.camera_addresses.push({ camera_id: id, ord: i + 1, address });
      });
      bump();
      return copy(created);
    },

    async update(id, patch) {
      const keys = CAMERA_COLS.filter((k) => patch[k] !== undefined);
      if (!keys.length) return camera.get(id); // nothing to write: do not bump the ETag
      const found = row('cameras', 'id', id);
      if (!found) return null;
      for (const k of keys) found[k] = patch[k];
      found.updated_at = iso();
      bump();
      return copy(found);
    },

    // Addresses, profiles and grants go with the camera (ON DELETE CASCADE).
    async remove(id) {
      if (!drop('cameras', 'id', id)) return false;
      mem.camera_addresses = mem.camera_addresses.filter((a) => a.camera_id !== id);
      mem.profiles = mem.profiles.filter((p) => p.camera_id !== id);
      mem.camera_grants = mem.camera_grants.filter((g) => g.camera_id !== id);
      bump();
      return true;
    },

    async setStates(list) {
      if (!list.length) return [];
      const out = [];
      for (const s of list) {
        const found = row('cameras', 'id', s.id);
        if (!found) continue;
        found.state = s.state;
        found.error_code = s.error_code ?? null;
        found.updated_at = iso();
        out.push({ id: found.id, state: found.state, error_code: found.error_code });
      }
      if (out.length) bump();
      return out;
    },

    // Cameras that should be recording. The profile is chosen by the caller (`cameraRoles`), not here.
    async listRecording() {
      return mem.cameras
        .slice()
        .sort((a, b) => cmp(text(a.name), text(b.name)) || cmp(a.id, b.id))
        .filter((c) => c.recording)
        .map((c) => ({ ...c }));
    },
  };

  // --------------------------------------------------------------- catalog: profiles

  const profile = {
    async listByCamera(cameraId) {
      return mem.profiles.filter((p) => p.camera_id === cameraId)
        .sort((a, b) => cmp(a.name, b.name)).map(PROFILE_FIELDS);
    },

    async listAll() {
      return mem.profiles.slice()
        .sort((a, b) => cmp(a.camera_id, b.camera_id) || cmp(a.name, b.name)).map(PROFILE_FIELDS);
    },

    async get(id) {
      const found = row('profiles', 'id', id);
      return found ? PROFILE_FIELDS(found) : null;
    },

    async create(p) {
      const created = {
        id: p.id || uuid(),
        camera_id: p.camera_id,
        name: p.name,
        source_url: p.source_url ?? null,
        recording_mode: p.recording_mode ?? null,
        width: p.width ?? null,
        height: p.height ?? null,
        onvif_token: p.onvif_token ?? null,
        created_at: iso(),
      };
      mem.profiles.push(created);
      bump();
      return PROFILE_FIELDS(created);
    },

    async update(id, patch) {
      const keys = PROFILE_COLS.filter((k) => patch[k] !== undefined);
      if (!keys.length) return profile.get(id);
      const found = row('profiles', 'id', id);
      if (!found) return null;
      for (const k of keys) found[k] = patch[k];
      bump();
      return PROFILE_FIELDS(found);
    },

    // ponytail: only the cascades the routes rely on are simulated (camera removal); FKs from
    // gaps and exports to a profile are not, so a test that needs those seeds them directly.
    async remove(id) {
      if (!drop('profiles', 'id', id)) return false;
      bump();
      return true;
    },
  };

  // ----------------------------------------------------------------- catalog: groups

  const group = {
    async list() {
      return mem.groups.slice().sort((a, b) => cmp(text(a.name), text(b.name)) || cmp(a.id, b.id))
        .map(GROUP_FIELDS);
    },

    async get(id) {
      const found = row('groups', 'id', id);
      return found ? GROUP_FIELDS(found) : null;
    },

    async create(g) {
      const created = {
        id: g.id || uuid(), name: g.name, parent_id: g.parent_id ?? null, created_at: iso(),
      };
      mem.groups.push(created);
      bump();
      return GROUP_FIELDS(created);
    },

    async update(id, patch) {
      const keys = GROUP_COLS.filter((k) => patch[k] !== undefined);
      if (!keys.length) return group.get(id);
      const found = row('groups', 'id', id);
      if (!found) return null;
      for (const k of keys) found[k] = patch[k];
      bump();
      return GROUP_FIELDS(found);
    },

    // Children survive the parent removal with parent_id null (ON DELETE SET NULL), and so do the
    // cameras of the deleted group (their group_id FK has the same rule).
    async remove(id) {
      if (!drop('groups', 'id', id)) return false;
      for (const g of mem.groups) if (g.parent_id === id) g.parent_id = null;
      for (const c of mem.cameras) if (c.group_id === id) c.group_id = null;
      bump();
      return true;
    },

    // Deleting a group promotes its children to the deleted group's parent (the API promotes the
    // cameras the same way); the FK alone would send them to the root.
    async promoteChildren(oldId, parentId) {
      let n = 0;
      for (const g of mem.groups) if (g.parent_id === oldId) { g.parent_id = parentId ?? null; n += 1; }
      if (n) bump();
      return n;
    },

    // Subtree below id, the group itself excluded; the result set makes a parent_id cycle terminate.
    async descendants(id) {
      const seen = new Set();
      const queue = mem.groups.filter((g) => g.parent_id === id).map((g) => g.id);
      while (queue.length) {
        const next = queue.shift();
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(...mem.groups.filter((g) => g.parent_id === next).map((g) => g.id));
      }
      return [...seen];
    },
  };

  // ------------------------------------------------------------ catalog: credentials

  const credential = {
    async get(ref) {
      return copy(row('credentials', 'ref', ref));
    },

    // Upsert: created_at belongs to the first write and is kept, as ON CONFLICT DO UPDATE does.
    async put(ref, cred = {}) {
      const found = row('credentials', 'ref', ref);
      const values = { username: cred.username ?? null, secret: cred.secret ?? null };
      if (found) return copy(Object.assign(found, values));
      const created = { ref, ...values, created_at: iso() };
      mem.credentials.push(created);
      return copy(created);
    },

    async remove(ref) {
      return drop('credentials', 'ref', ref);
    },

    // A credential is SHARED by a DVR and its children: the last one to leave removes it.
    async inUse(ref) {
      return mem.cameras.some((c) => c.credential_ref === ref) ||
        mem.devices.some((d) => (d.meta || {}).credential_ref === ref);
    },
  };

  // ---------------------------------------------------------------- catalog: devices

  const device = {
    async list() {
      return mem.devices.slice().sort((a, b) => cmp(text(a.name), text(b.name)) || cmp(a.id, b.id))
        .map(DEVICE_FIELDS);
    },

    async get(id) {
      const found = row('devices', 'id', id);
      return found ? DEVICE_FIELDS(found) : null;
    },

    async put(d) {
      const id = d.id || uuid();
      const found = row('devices', 'id', id);
      if (found) {
        found.name = d.name;
        found.meta = d.meta ?? {};
        return DEVICE_FIELDS(found);
      }
      const created = { id, name: d.name, created_at: iso(), meta: d.meta ?? {} };
      mem.devices.push(created);
      return DEVICE_FIELDS(created);
    },

    async remove(id) {
      return drop('devices', 'id', id);
    },
  };

  const catalog = {
    cameras: camera,
    profiles: profile,
    groups: group,
    credentials: credential,
    devices: device,
    async catalogRev() { return rev; },
  };

  // ------------------------------------------------------------------------ access

  // The join drops a user whose profile is gone, like the INNER JOIN in usersListPaged.
  const userRows = () => mem.users.flatMap((u) => {
    const p = row('access_profiles', 'id', u.profile_id);
    if (!p) return [];
    return [{
      username: u.username,
      profile_id: u.profile_id,
      profile_name: p.name,
      status: u.status,
      must_change_password: u.must_change_password,
    }];
  });

  const access = {
    async usersListPaged(p = {}) {
      const order = paging(
        p,
        { username: (u) => u.username, profile: (u) => u.profile_name, status: (u) => u.status },
        'username',
        (u) => u.username,
      );
      const hit = matches(p.q, (u) => u.username, (u) => u.status, (u) => u.profile_name);
      const rows = userRows().filter(hit).filter((u) => !p.status || u.status === p.status);
      return page(rows, order);
    },

    async userGet(username) {
      return copy(row('users', 'username', username));
    },

    async userCreate(u) {
      const created = {
        username: u.username,
        profile_id: u.profile_id,
        status: u.status || 'active',
        secret_hash: u.secret_hash,
        must_change_password: u.must_change_password === true,
        credential_version: u.credential_version == null ? 1 : u.credential_version,
        created_at: iso(),
        updated_at: iso(),
      };
      mem.users.push(created);
      return copy(created);
    },

    async userUpdate(username, patch = {}) {
      const keys = USER_COLS.filter((k) => patch[k] !== undefined);
      if (!keys.length) return access.userGet(username);
      const found = row('users', 'username', username);
      if (!found) return null;
      for (const k of keys) found[k] = patch[k];
      found.updated_at = iso();
      return copy(found);
    },

    async userRemove(username) {
      if (!drop('users', 'username', username)) return false;
      mem.sessions = mem.sessions.filter((s) => s.username !== username); // ON DELETE CASCADE
      return true;
    },

    // Same contract as the pg repository: the row moves to the new key holding a fresh `created_at`,
    // and the sessions point at it instead of being dropped (the cascade would take them otherwise).
    async userRename(oldName, newName) {
      const found = row('users', 'username', oldName);
      if (!found) return null;
      const renamed = { ...found, username: newName, created_at: iso(), updated_at: iso() };
      mem.users = mem.users.filter((u) => u.username !== oldName).concat(renamed);
      for (const s of mem.sessions) if (s.username === oldName) s.username = newName;
      return copy(renamed);
    },

    async profilesListPaged(p = {}) {
      const grants = (id) => mem.camera_grants.filter((g) => g.profile_id === id).length;
      const rows = mem.access_profiles.map((ap) => ({
        id: ap.id, name: ap.name, kind: ap.kind, grants_count: grants(ap.id),
      }));
      const order = paging(
        p,
        { name: (ap) => ap.name, kind: (ap) => ap.kind, cameras: (ap) => ap.grants_count },
        'name',
        (ap) => ap.id,
      );
      const hit = matches(p.q, (ap) => ap.name);
      return page(rows.filter(hit).filter((ap) => !p.kind || ap.kind === p.kind), order);
    },

    async profileGet(id) {
      return copy(row('access_profiles', 'id', id));
    },

    async profileCreate(p) {
      const created = {
        id: p.id || uuid(), name: p.name, kind: p.kind || 'custom', created_at: iso(), updated_at: iso(),
      };
      mem.access_profiles.push(created);
      bump();
      return copy(created);
    },

    async profileUpdate(id, patch = {}) {
      const keys = ACCESS_PROFILE_COLS.filter((k) => patch[k] !== undefined);
      if (!keys.length) return access.profileGet(id);
      const found = row('access_profiles', 'id', id);
      if (!found) return null;
      for (const k of keys) found[k] = patch[k];
      found.updated_at = iso();
      bump();
      return copy(found);
    },

    async profileRemove(id) {
      if (!drop('access_profiles', 'id', id)) return false;
      mem.camera_grants = mem.camera_grants.filter((g) => g.profile_id !== id);
      bump();
      return true;
    },

    async grantsOf(profileId) {
      return mem.camera_grants.filter((g) => g.profile_id === profileId)
        .sort((a, b) => cmp(a.camera_id, b.camera_id))
        .map((g) => ({ camera_id: g.camera_id, level: g.level }));
    },

    // Replace, not merge: the editor submits the complete grant set.
    async setGrants(profileId, grants = []) {
      mem.camera_grants = mem.camera_grants.filter((g) => g.profile_id !== profileId);
      const rows = grants.map((g) => ({ profile_id: profileId, camera_id: g.camera_id, level: g.level }));
      mem.camera_grants.push(...rows);
      bump();
      return rows.map((g) => ({ camera_id: g.camera_id, level: g.level }));
    },

    // control implies view. A system profile is global scope; a custom one sees its grants only.
    async camerasWithLevel(profileId, level = 'view') {
      if (!profileId) return [];
      const p = row('access_profiles', 'id', profileId);
      if (p && p.kind === 'system') return mem.cameras.map((c) => c.id).sort();
      const min = level === 'control' ? 'control' : 'view';
      return mem.camera_grants
        .filter((g) => g.profile_id === profileId && (min === 'view' || g.level === 'control'))
        .map((g) => g.camera_id)
        .sort();
    },
  };

  // ---------------------------------------------------------------------- sessions

  const sessions = {
    async get(hash) {
      return copy(row('sessions', 'token_hash', hash));
    },

    async create({ token_hash, username, credential_version, expires_at }) {
      const created = {
        token_hash,
        username,
        credential_version: credential_version == null ? 1 : credential_version,
        created_at: iso(),
        last_seen_at: iso(),
        expires_at,
      };
      mem.sessions.push(created);
      return copy(created);
    },

    async touch(hash) {
      const found = row('sessions', 'token_hash', hash);
      if (!found) return false;
      found.last_seen_at = iso();
      return true;
    },

    async remove(hash) {
      return drop('sessions', 'token_hash', hash);
    },

    async prune(now = new Date()) {
      const before = mem.sessions.length;
      mem.sessions = mem.sessions.filter((s) => !(new Date(s.expires_at) < now));
      return before - mem.sessions.length;
    },

    async listByUser(username) {
      return copies(mem.sessions.filter((s) => s.username === username)
        .sort((a, b) => cmp(b.created_at, a.created_at)));
    },
  };

  // --------------------------------------------------------------------------- ops

  // Fields given replace the stored ones; a missing field keeps its default on insert or its
  // old value on update, like ON CONFLICT DO UPDATE with the given columns only.
  function put(table, id, fields) {
    const { cols, defaults } = OPS_TABLES[table];
    const keys = cols.filter((k) => fields[k] !== undefined);
    const found = row(table, 'id', id);
    if (found) {
      for (const k of keys) found[k] = fields[k];
      return copy(found);
    }
    const created = { id, ...defaults() };
    for (const k of keys) created[k] = fields[k];
    mem[table].push(created);
    return copy(created);
  }

  const ops = {
    layouts: {
      async list() {
        return copies(mem.layouts.slice().sort((a, b) => cmp(a.created_ts, b.created_ts)));
      },
      async get(id) {
        return copy(row('layouts', 'id', id));
      },
      async put(l) {
        return put('layouts', l.id, l);
      },
      async remove(id) {
        return drop('layouts', 'id', id);
      },
    },

    exports: {
      async list() {
        return copies(mem.exports.slice().sort((a, b) => cmp(b.created_at, a.created_at)));
      },
      async get(id) {
        return copy(row('exports', 'id', id));
      },
      // Partial update: only the fields that changed, plus updated_at.
      async put(id, fields) {
        const all = { updated_at: iso(), ...fields };
        const found = row('exports', 'id', id);
        if (!found) return put('exports', id, all);
        for (const k of OPS_TABLES.exports.cols) if (all[k] !== undefined) found[k] = all[k];
        return copy(found);
      },
      async sweepPending() {
        const hit = mem.exports.filter((e) => e.state === 'queued' || e.state === 'exporting');
        for (const e of hit) {
          e.state = 'error';
          e.error = 'process restarted';
          e.updated_at = iso();
        }
        return hit.map((e) => e.id);
      },
    },

    scans: {
      async list() {
        return copies(mem.scans.slice().sort((a, b) => cmp(b.started_ts, a.started_ts)));
      },
      async get(id) {
        return copy(row('scans', 'id', id));
      },
      async put(s) {
        return put('scans', s.id, s);
      },
    },

    candidates: {
      async list() {
        return copies(mem.candidates.slice().sort((a, b) => cmp(b.last_seen_at, a.last_seen_at)));
      },
      async put(c) {
        return put('candidates', c.id, c);
      },
      async removeByScan(scanId) {
        const before = mem.candidates.length;
        mem.candidates = mem.candidates.filter((c) => c.scan_id !== scanId);
        return before - mem.candidates.length;
      },
    },

    gaps: {
      // Overlap, not containment: a gap that starts before the window and ends inside it counts.
      async listByProfile(profileId, from, to) {
        return copies(mem.gaps
          .filter((g) => g.stream_profile_id === profileId)
          .filter((g) => from === undefined || from === null || Number(g.to_ts) > Number(from))
          .filter((g) => to === undefined || to === null || Number(g.from_ts) < Number(to))
          .sort((a, b) => Number(a.from_ts) - Number(b.from_ts)));
      },
    },

    events: {
      async append(e) {
        const created = {
          id: e.id || uuid(),
          ts: e.ts == null ? Math.floor(Date.now() / 1000) : e.ts,
          kind: e.kind,
          severity: e.severity || 'info',
          message: e.message,
          camera_id: e.camera_id || null,
          profile_id: e.profile_id || null,
        };
        mem.events.push(created);
        return copy(created);
      },
      async list({ since = 0, limit } = {}) {
        // The events cursor allows a deeper page than the tables: 1..1000, default 100.
        const n = intParam(limit, 100, 1, 1000, 'limit_invalid');
        const from = Number(since) || 0;
        return copies(mem.events
          .filter((e) => Number(e.ts) >= from)
          .sort((a, b) => cmp(b.ts, a.ts) || cmp(b.id, a.id))
          .slice(0, n));
      },
      async prune(days) {
        const cutoff = Math.floor(Date.now() / 1000) - Number(days) * 86400;
        const before = mem.events.length;
        mem.events = mem.events.filter((e) => Number(e.ts) >= cutoff);
        return before - mem.events.length;
      },
    },
  };

  const store = { mem, catalog, access, sessions, ops };
  // ponytail: no rollback in memory; route tests assert results, not crash recovery.
  store.tx = async (fn) => fn(store);
  return store;
}

// Camera fields that live in the `meta` column (spec §3), plus the FOV the modal reads.
const CAMERA_META_KEYS = ['onvif', 'manual', 'ptz', 'positions', 'physical_id', 'channel',
  'channel_missing', 'canal_ausente', 'fov_min_grau', 'fov_max_grau'];

// Test fixture: a legacy-shaped camera object (onvif/manual/fov at the top level, `addresses` as an array)
// becomes the row plus its camera_addresses, which is what the importer/store produces.
function seedCamera(store, cam = {}) {
  const { addresses = [], ...rest } = cam;
  const row = { created_at: iso(), updated_at: iso(), ...rest };
  // `profile_ids` is DERIVED now (profiles.camera_id owns the relation): a seeded fixture does not keep it
  delete row.profile_ids;
  const meta = {};
  for (const k of CAMERA_META_KEYS) {
    if (k in row) { meta[k] = row[k]; delete row[k]; }
  }
  row.meta = { ...meta, ...(cam.meta || {}) };
  store.mem.cameras.push(row);
  addresses.forEach((address, i) => {
    store.mem.camera_addresses.push({ camera_id: row.id, ord: i + 1, address });
  });
  return row;
}

module.exports = { memStore, seedCamera, CAMERA_META_KEYS };


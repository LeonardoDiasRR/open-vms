'use strict';
const crypto = require('node:crypto');
const { withTx } = require('../lib/pgpool');

// Access and operation repositories (spec 2026-10-20 §5 and §6). Every read goes to the database,
// every write that needs more than one statement runs in a transaction.

const fail = (code) => Object.assign(new Error(code), { code });

// Query strings arrive as text: coerce, then require a real integer in range. Absent means default.
function intParam(value, fallback, min, max, code) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(code);
  return n;
}

// Shared pagination contract: 1..100 rows (default 10), offset >= 0, closed sort list, stable
// tiebreaker appended to every ORDER BY so two pages never repeat or skip a row.
function paging(p = {}, sorts, defaultSort, tiebreaker) {
  const limit = intParam(p.limit, 10, 1, 100, 'limit_invalid');
  const offset = intParam(p.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset_invalid');
  const requested = p.sort === undefined || p.sort === null || p.sort === '' ? defaultSort : p.sort;
  const expr = sorts[requested];
  if (!expr) throw fail('sort_invalid');
  const dir = p.dir === undefined || p.dir === null || p.dir === '' ? 'asc' : String(p.dir).toLowerCase();
  if (dir !== 'asc' && dir !== 'desc') throw fail('dir_invalid');
  return { limit, offset, order: `${expr} ${dir.toUpperCase()}, ${tiebreaker}` };
}

// Literal substring, same as the old includes(): `%` and `_` typed by the operator are data.
const like = (q) => `%${String(q).replace(/[\\%_]/g, (m) => '\\' + m)}%`;

// `total` rides on count(*) OVER () in the same query. A page past the end returns no row to carry
// it, so that case pays one count query instead of reporting total 0.
async function page(pool, { select, from, where, params, order, limit, offset }) {
  const { rows } = await pool.query(
    `SELECT ${select} ${from} ${where} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const total = rows.length
    ? Number(rows[0].total)
    : Number((await pool.query(`SELECT count(*) AS n ${from} ${where}`, params)).rows[0].n);
  return { items: rows.map(({ total: _omit, ...item }) => item), total, limit, offset };
}

// ---------------------------------------------------------------- access
function access(pool) {
  const usersFrom = 'FROM users u JOIN access_profiles p ON p.id = u.profile_id';
  // The profile name enters by subquery, not by an extra OR over the JOIN: that keeps the trigram
  // index on access_profiles.name eligible (spec §5).
  const usersWhere = `WHERE ($1::text IS NULL OR u.username ILIKE $1 OR u.status ILIKE $1
      OR u.profile_id IN (SELECT id FROM access_profiles WHERE name ILIKE $1))
    AND ($2::text IS NULL OR u.status = $2)`;
  const profilesFrom = 'FROM access_profiles ap';
  const profilesWhere = 'WHERE ($1::text IS NULL OR ap.name ILIKE $1) AND ($2::text IS NULL OR ap.kind = $2)';

  const userPatch = ['profile_id', 'status', 'secret_hash', 'must_change_password', 'credential_version'];
  const profilePatch = ['name', 'kind'];

  async function userGet(username) {
    return (await pool.query('SELECT * FROM users WHERE username = $1', [username])).rows[0] || null;
  }

  return {
    async usersListPaged(p = {}) {
      const { limit, offset, order } = paging(
        p,
        { username: 'u.username', profile: 'p.name', status: 'u.status' },
        'username',
        'u.username',
      );
      const params = [p.q ? like(p.q) : null, p.status || null];
      return page(pool, {
        select: `u.username, u.profile_id, p.name AS profile_name, u.status, u.must_change_password,
          count(*) OVER () AS total`,
        from: usersFrom,
        where: usersWhere,
        params,
        order,
        limit,
        offset,
      });
    },

    userGet,

    async userCreate(u) {
      const { rows } = await pool.query(
        `INSERT INTO users (username, profile_id, status, secret_hash, must_change_password, credential_version)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [u.username, u.profile_id, u.status || 'active', u.secret_hash,
          u.must_change_password === true, u.credential_version == null ? 1 : u.credential_version],
      );
      return rows[0];
    },

    async userUpdate(username, patch = {}) {
      const keys = userPatch.filter((k) => patch[k] !== undefined);
      if (!keys.length) return userGet(username);
      const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const { rows } = await pool.query(
        `UPDATE users SET ${set}, updated_at = now() WHERE username = $1 RETURNING *`,
        [username, ...keys.map((k) => patch[k])],
      );
      return rows[0] || null;
    },

    async userRemove(username) {
      return (await pool.query('DELETE FROM users WHERE username = $1', [username])).rowCount > 0;
    },

    // Rename = new key, same record: INSERT ... SELECT under the new name, repoint the sessions and
    // DELETE the old row in ONE transaction, so a crash cannot leave both names (or none) behind.
    // `created_at` restarts on the insert; password, profile, status and credential version travel.
    // The sessions are moved, not recreated: their token hash and expiry survive (media is not cut).
    async userRename(oldName, newName) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO users (username, profile_id, status, secret_hash, must_change_password, credential_version)
           SELECT $2, profile_id, status, secret_hash, must_change_password, credential_version
             FROM users WHERE username = $1 RETURNING *`,
          [oldName, newName],
        );
        if (!rows[0]) {
          await client.query('ROLLBACK');
          return null;
        }
        await client.query('UPDATE sessions SET username = $2 WHERE username = $1', [oldName, newName]);
        await client.query('DELETE FROM users WHERE username = $1', [oldName]);
        await client.query('COMMIT');
        return rows[0];
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async profilesListPaged(p = {}) {
      const { limit, offset, order } = paging(
        p,
        { name: 'ap.name', kind: 'ap.kind', cameras: 'grants_count' },
        'name',
        'ap.id',
      );
      const params = [p.q ? like(p.q) : null, p.kind || null];
      return page(pool, {
        // Index-only count per row: the list never carries the grants themselves.
        select: `ap.id, ap.name, ap.kind,
          (SELECT count(*) FROM camera_grants cg WHERE cg.profile_id = ap.id)::int AS grants_count,
          count(*) OVER () AS total`,
        from: profilesFrom,
        where: profilesWhere,
        params,
        order,
        limit,
        offset,
      });
    },

    async profileGet(id) {
      const { rows } = await pool.query('SELECT * FROM access_profiles WHERE id = $1', [id]);
      return rows[0] || null;
    },

    async profileCreate(p) {
      const { rows } = await pool.query(
        'INSERT INTO access_profiles (id, name, kind) VALUES ($1, $2, $3) RETURNING *',
        [p.id || crypto.randomUUID(), p.name, p.kind || 'custom'],
      );
      return rows[0];
    },

    async profileUpdate(id, patch = {}) {
      const keys = profilePatch.filter((k) => patch[k] !== undefined);
      if (!keys.length) {
        return (await pool.query('SELECT * FROM access_profiles WHERE id = $1', [id])).rows[0] || null;
      }
      const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const { rows } = await pool.query(
        `UPDATE access_profiles SET ${set}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...keys.map((k) => patch[k])],
      );
      return rows[0] || null;
    },

    async profileRemove(id) {
      return (await pool.query('DELETE FROM access_profiles WHERE id = $1', [id])).rowCount > 0;
    },

    async grantsOf(profileId) {
      const { rows } = await pool.query(
        'SELECT camera_id, level FROM camera_grants WHERE profile_id = $1 ORDER BY camera_id',
        [profileId],
      );
      return rows;
    },

    // Replace, not merge: the editor submits the complete grant set. One transaction, two statements.
    async setGrants(profileId, grants = []) {
      return withTx(pool, async (client) => {
        await client.query('DELETE FROM camera_grants WHERE profile_id = $1', [profileId]);
        if (!grants.length) return [];
        const { rows } = await client.query(
          `INSERT INTO camera_grants (profile_id, camera_id, level)
           SELECT $1, g.camera_id, g.level FROM UNNEST($2::uuid[], $3::text[]) AS g(camera_id, level)
           RETURNING camera_id, level`,
          [profileId, grants.map((g) => g.camera_id), grants.map((g) => g.level)],
        );
        return rows;
      });
    },

    // `control` implies `view`. A system profile is global scope, so it sees every camera; a custom
    // one sees exactly what it was granted. Unknown profile = no grant = nothing.
    async camerasWithLevel(profileId, level = 'view') {
      if (!profileId) return [];
      const kind = (await pool.query('SELECT kind FROM access_profiles WHERE id = $1', [profileId])).rows[0];
      if (kind && kind.kind === 'system') {
        return (await pool.query('SELECT id FROM cameras ORDER BY id')).rows.map((r) => r.id);
      }
      const min = level === 'control' ? 'control' : 'view';
      const { rows } = await pool.query(
        `SELECT camera_id FROM camera_grants
         WHERE profile_id = $1 AND ($2 = 'view' OR level = 'control') ORDER BY camera_id`,
        [profileId, min],
      );
      return rows.map((r) => r.camera_id);
    },
  };
}

// ---------------------------------------------------------------- sessions
function sessions(pool) {
  return {
    async get(hash) {
      return (await pool.query('SELECT * FROM sessions WHERE token_hash = $1', [hash])).rows[0] || null;
    },

    async create({ token_hash, username, credential_version, expires_at }) {
      const { rows } = await pool.query(
        `INSERT INTO sessions (token_hash, username, credential_version, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [token_hash, username, credential_version == null ? 1 : credential_version, expires_at],
      );
      return rows[0];
    },

    async touch(hash) {
      return (await pool.query(
        'UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1 RETURNING token_hash',
        [hash],
      )).rowCount > 0;
    },

    async remove(hash) {
      return (await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash])).rowCount > 0;
    },

    async prune(now = new Date()) {
      return (await pool.query('DELETE FROM sessions WHERE expires_at < $1', [now])).rowCount;
    },

    async listByUser(username) {
      const { rows } = await pool.query(
        'SELECT * FROM sessions WHERE username = $1 ORDER BY created_at DESC',
        [username],
      );
      return rows;
    },
  };
}

// ---------------------------------------------------------------- ops
// Column whitelist per table: keys not listed here are ignored, which also keeps table names and
// column names out of the string-interpolation path.
const COLUMNS = {
  layouts: ['name', 'cells', 'created_ts', 'updated_ts'],
  exports: ['stream_profile_id', 'camera_name', 'name', 'description', 'from_ts', 'to_ts', 'state', 'progresso',
    'path', 'bytes', 'error', 'created_at', 'updated_at'],
  scans: ['kind', 'state', 'scope', 'found', 'error', 'started_ts', 'finished_ts'],
  candidates: ['scan_id', 'ip', 'xaddr', 'name', 'manufacturer', 'model', 'status', 'outcome',
    'seen_count', 'video_sources', 'open_ports', 'first_seen_at', 'last_seen_at'],
};
const JSON_COLUMNS = new Set(['cells', 'scope', 'video_sources']);

// Fields given replace the stored ones (the callers submit whole rows); a missing field keeps its
// database default on insert or its old value on update.
async function put(pool, table, id, fields) {
  const keys = COLUMNS[table].filter((k) => fields[k] !== undefined);
  const columns = ['id', ...keys];
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map((k) => (JSON_COLUMNS.has(k) && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]));
  const update = keys.map((k) => `${k} = EXCLUDED.${k}`).join(', ') || 'id = EXCLUDED.id';
  const { rows } = await pool.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${update} RETURNING *`,
    [id, ...values],
  );
  return rows[0];
}

function ops(pool) {
  // `exports.put` is a PARTIAL update: the job row comes from the POST, and the queue only sends the
  // fields that changed. The insert path is just for a row that is not there yet, and then the
  // caller has to send the mandatory ones — a bare patch cannot satisfy NOT NULL.
  async function patchExport(id, fields) {
    const all = { updated_at: new Date(), ...fields };
    const keys = COLUMNS.exports.filter((k) => all[k] !== undefined);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await pool.query(`UPDATE exports SET ${set} WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => all[k])]);
    return rows[0] || put(pool, 'exports', id, all);
  }

  return {
    layouts: {
      async list() {
        return (await pool.query('SELECT * FROM layouts ORDER BY created_ts')).rows;
      },
      async get(id) {
        return (await pool.query('SELECT * FROM layouts WHERE id = $1', [id])).rows[0] || null;
      },
      put: (l) => put(pool, 'layouts', l.id, l),
      async remove(id) {
        return (await pool.query('DELETE FROM layouts WHERE id = $1', [id])).rowCount > 0;
      },
    },

    exports: {
      async list() {
        return (await pool.query('SELECT * FROM exports ORDER BY created_at DESC')).rows;
      },
      async get(id) {
        return (await pool.query('SELECT * FROM exports WHERE id = $1', [id])).rows[0] || null;
      },
      put: patchExport,
      // Workers die with the process: a persisted job still marked active would lie forever.
      async sweepPending() {
        const { rows } = await pool.query(
          `UPDATE exports SET state = 'error', error = 'process restarted', updated_at = now()
           WHERE state IN ('queued', 'exporting') RETURNING id`,
        );
        return rows.map((r) => r.id);
      },
    },

    scans: {
      async list() {
        return (await pool.query('SELECT * FROM scans ORDER BY started_ts DESC')).rows;
      },
      async get(id) {
        return (await pool.query('SELECT * FROM scans WHERE id = $1', [id])).rows[0] || null;
      },
      put: (s) => put(pool, 'scans', s.id, s),
    },

    candidates: {
      async list() {
        return (await pool.query('SELECT * FROM candidates ORDER BY last_seen_at DESC')).rows;
      },
      put: (c) => put(pool, 'candidates', c.id, c),
      async removeByScan(scanId) {
        return (await pool.query('DELETE FROM candidates WHERE scan_id = $1', [scanId])).rowCount;
      },
    },

    gaps: {
      // Overlap, not containment: a gap that starts before the window and ends inside it counts.
      async listByProfile(profileId, from, to) {
        const { rows } = await pool.query(
          `SELECT * FROM gaps WHERE stream_profile_id = $1
             AND ($2::bigint IS NULL OR to_ts > $2) AND ($3::bigint IS NULL OR from_ts < $3)
           ORDER BY from_ts`,
          [profileId, from ?? null, to ?? null],
        );
        return rows;
      },
    },

    events: {
      async append(e) {
        const { rows } = await pool.query(
          `INSERT INTO events (id, ts, kind, severity, message, camera_id, profile_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [e.id || crypto.randomUUID(), e.ts == null ? Math.floor(Date.now() / 1000) : e.ts,
            e.kind, e.severity || 'info', e.message, e.camera_id || null, e.profile_id || null],
        );
        return rows[0];
      },
      async list({ since = 0, limit } = {}) {
        const n = intParam(limit, 100, 1, 1000, 'limit_invalid');
        const { rows } = await pool.query(
          'SELECT * FROM events WHERE ts >= $1 ORDER BY ts DESC, id DESC LIMIT $2',
          [Number(since) || 0, n],
        );
        return rows;
      },
      async prune(days) {
        const cutoff = Math.floor(Date.now() / 1000) - Number(days) * 86400;
        return (await pool.query('DELETE FROM events WHERE ts < $1', [cutoff])).rowCount;
      },
    },
  };
}

module.exports = { access, sessions, ops };

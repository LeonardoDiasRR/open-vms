'use strict';
// Catalog repository: cameras, profiles, groups, credentials, devices (spec §3, §6).
// Every read goes to the database, no cache. Writes that touch more than one table use withTx.
// Column names interpolated into SQL come from the frozen lists below, never from the caller;
// every value is a parameter.
const crypto = require('node:crypto');
const { withTx } = require('../lib/pgpool');

const CAMERA_COLS = ['name', 'state', 'added_via', 'recording', 'error_code', 'credential_ref',
  'device_id', 'group_id', 'meta'];
const PROFILE_COLS = ['name', 'source_url', 'recording_mode', 'width', 'height', 'onvif_token'];
const GROUP_COLS = ['name', 'parent_id'];

const CAMERA_FIELDS = 'id, name, state, added_via, recording, error_code, credential_ref, device_id, ' +
  'group_id, created_at, updated_at, meta';
// Tree payload from spec §6: only the fields the tree uses. `credential_ref` travels because only the
// profiles that MANAGE cameras see it — main.js strips it (payload-camera.js) for everyone else.
// spec 2026-10-27: `meta` joins the projection so the list route can flatten `ativa`; the route strips
// the column itself before the payload leaves (GET /api/v1/cameras in api/devices.js).
const CAMERA_TREE_FIELDS = 'id, name, state, added_via, recording, error_code, credential_ref, group_id, ' +
  'device_id, created_at, updated_at, meta';
const PROFILE_FIELDS = 'id, camera_id, name, source_url, recording_mode, width, height, onvif_token, created_at';
const GROUP_FIELDS = 'id, name, parent_id, created_at';
const DEVICE_FIELDS = 'id, name, created_at, meta';

// Keys the table actually has, in the table's order: unknown patch keys are dropped here.
const pick = (patch, cols) => cols.filter((c) => patch[c] !== undefined);
// Partial UPDATE: $1 is the id, the whitelisted keys follow in order.
const assignments = (keys, from = 2) => keys.map((k, i) => `${k} = $${from + i}`).join(', ');
const values = (id, patch, keys) => [id, ...keys.map((k) => patch[k])];

function catalog(pool) {
  // ---------------------------------------------------------------- cameras

  async function listCatalog() {
    const { rows } = await pool.query(
      `SELECT ${CAMERA_TREE_FIELDS} FROM cameras ORDER BY lower(name), id`,
    );
    return rows;
  }

  async function getCamera(id) {
    const { rows } = await pool.query(`SELECT ${CAMERA_FIELDS} FROM cameras WHERE id = $1`, [id]);
    return rows[0] || null;
  }

  async function addresses(cameraId) {
    const { rows } = await pool.query(
      'SELECT address FROM camera_addresses WHERE camera_id = $1 ORDER BY ord', [cameraId]);
    return rows.map((r) => r.address);
  }

  // Replaces the whole address list of one camera in a transaction: a repair writes the list it
  // believes in, and a half-written list would be worse than the wrong port. ord follows the array
  // order, 1-based like createCamera; no caller reads it, it only keeps addresses() order stable.
  async function replaceAddresses(cameraId, list) {
    return withTx(pool, async (tx) => {
      await tx.query('DELETE FROM camera_addresses WHERE camera_id = $1', [cameraId]);
      if (list.length) {
        await tx.query(
          `INSERT INTO camera_addresses (camera_id, ord, address)
           SELECT $1, a.ord, a.address FROM UNNEST($2::int[], $3::text[]) AS a(ord, address)`,
          [cameraId, list.map((_, i) => i + 1), list],
        );
      }
      return list;
    });
  }

  // Every camera address in one read: the discovery results derive "already added" from the whole set,
  // and one query beats one per camera.
  async function allAddresses() {
    const { rows } = await pool.query('SELECT camera_id, address FROM camera_addresses');
    return rows;
  }

  async function createCamera(cam) {
    const id = cam.id || crypto.randomUUID();
    const list = cam.addresses || [];
    return withTx(pool, async (tx) => {
      const { rows: [row] } = await tx.query(
        `INSERT INTO cameras (id, name, state, added_via, recording, error_code, credential_ref,
                              device_id, group_id, meta)
         VALUES ($1, $2, COALESCE($3, 'provisioning'), $4, COALESCE($5, false), $6, $7, $8, $9,
                 COALESCE($10::jsonb, '{}'::jsonb))
         RETURNING ${CAMERA_FIELDS}`,
        [id, cam.name, cam.state ?? null, cam.added_via ?? null, cam.recording ?? null,
          cam.error_code ?? null, cam.credential_ref ?? null, cam.device_id ?? null,
          cam.group_id ?? null, cam.meta ?? null],
      );
      if (list.length) {
        // ord preserves the array order; 1-based like any SQL ordinal.
        await tx.query(
          `INSERT INTO camera_addresses (camera_id, ord, address)
           SELECT $1, a.ord, a.address FROM UNNEST($2::int[], $3::text[]) AS a(ord, address)`,
          [id, list.map((_, i) => i + 1), list],
        );
      }
      return row;
    });
  }

  async function updateCamera(id, patch) {
    const keys = pick(patch, CAMERA_COLS);
    if (!keys.length) return getCamera(id); // nothing to write: do not bump the ETag
    const { rows } = await pool.query(
      `UPDATE cameras SET ${assignments(keys)}, updated_at = now() WHERE id = $1 RETURNING ${CAMERA_FIELDS}`,
      values(id, patch, keys),
    );
    return rows[0] || null;
  }

  async function removeCamera(id) {
    const { rowCount } = await pool.query('DELETE FROM cameras WHERE id = $1', [id]);
    return rowCount > 0; // profiles and addresses go with it (ON DELETE CASCADE)
  }

  // One statement for the whole batch: the statement trigger bumps catalog_rev once, and
  // updated_at is the same transaction timestamp for every row.
  async function setStates(list) {
    if (!list.length) return [];
    const { rows } = await pool.query(
      `UPDATE cameras c SET state = s.state, error_code = s.error_code, updated_at = now()
         FROM UNNEST($1::uuid[], $2::text[], $3::text[]) AS s(id, state, error_code)
        WHERE c.id = s.id
        RETURNING c.id, c.state, c.error_code`,
      [list.map((x) => x.id), list.map((x) => x.state), list.map((x) => x.error_code ?? null)],
    );
    return rows;
  }

  // Cameras that should be recording, WITHOUT choosing the profile: the caller picks it with
  // `cameraRoles` (widest wins), the same rule the Hub publishes and the player reads. The profile
  // name is never consulted — that disagreement is what hid recordings from the player.
  async function listRecording() {
    const { rows } = await pool.query(
      // `meta` travels here because the recorder boot decides the mode from meta.recording_mode
      // (spec 2026-10-27); without it every motion camera would boot as continuous on the PG store.
      `SELECT ${CAMERA_TREE_FIELDS}, meta FROM cameras WHERE recording ORDER BY lower(name), id`,
    );
    return rows;
  }

  // --------------------------------------------------------------- profiles

  async function listProfilesByCamera(cameraId) {
    const { rows } = await pool.query(
      `SELECT ${PROFILE_FIELDS} FROM profiles WHERE camera_id = $1 ORDER BY name`, [cameraId]);
    return rows;
  }

  async function listProfiles() {
    const { rows } = await pool.query(
      `SELECT ${PROFILE_FIELDS} FROM profiles ORDER BY camera_id, name`);
    return rows;
  }

  async function getProfile(id) {
    const { rows } = await pool.query(`SELECT ${PROFILE_FIELDS} FROM profiles WHERE id = $1`, [id]);
    return rows[0] || null;
  }

  async function createProfile(p) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO profiles (id, camera_id, name, source_url, recording_mode, width, height, onvif_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PROFILE_FIELDS}`,
      [p.id || crypto.randomUUID(), p.camera_id, p.name, p.source_url ?? null,
        p.recording_mode ?? null, p.width ?? null, p.height ?? null, p.onvif_token ?? null],
    );
    return row;
  }

  async function updateProfile(id, patch) {
    const keys = pick(patch, PROFILE_COLS);
    if (!keys.length) return getProfile(id);
    const { rows } = await pool.query(
      `UPDATE profiles SET ${assignments(keys)} WHERE id = $1 RETURNING ${PROFILE_FIELDS}`,
      values(id, patch, keys),
    );
    return rows[0] || null;
  }

  async function removeProfile(id) {
    const { rowCount } = await pool.query('DELETE FROM profiles WHERE id = $1', [id]);
    return rowCount > 0;
  }

  // ----------------------------------------------------------------- groups

  async function listGroups() {
    const { rows } = await pool.query(`SELECT ${GROUP_FIELDS} FROM groups ORDER BY lower(name), id`);
    return rows;
  }

  async function getGroup(id) {
    const { rows } = await pool.query(`SELECT ${GROUP_FIELDS} FROM groups WHERE id = $1`, [id]);
    return rows[0] || null;
  }

  async function createGroup(g) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO groups (id, name, parent_id) VALUES ($1, $2, $3) RETURNING ${GROUP_FIELDS}`,
      [g.id || crypto.randomUUID(), g.name, g.parent_id ?? null],
    );
    return row;
  }

  async function updateGroup(id, patch) {
    const keys = pick(patch, GROUP_COLS);
    if (!keys.length) return getGroup(id);
    const { rows } = await pool.query(
      `UPDATE groups SET ${assignments(keys)} WHERE id = $1 RETURNING ${GROUP_FIELDS}`,
      values(id, patch, keys),
    );
    return rows[0] || null;
  }

  async function removeGroup(id) {
    const { rowCount } = await pool.query('DELETE FROM groups WHERE id = $1', [id]);
    return rowCount > 0; // the FKs are ON DELETE SET NULL: children and cameras go to the root
  }

  // Deleting a group used to move its children (and its cameras) up to the deleted group's parent,
  // not to the root as the ON DELETE SET NULL FKs would. One statement covers the whole level.
  async function promoteGroupChildren(oldId, parentId) {
    const { rowCount } = await pool.query(
      'UPDATE groups SET parent_id = $2 WHERE parent_id = $1', [oldId, parentId ?? null]);
    return rowCount;
  }

  // Subtree below `id`; the group itself is not included, callers prepend it when they mean the
  // whole branch. UNION (not UNION ALL) makes a parent_id cycle terminate instead of looping.
  async function descendants(id) {
    const { rows } = await pool.query(
      `WITH RECURSIVE d AS (
         SELECT id FROM groups WHERE parent_id = $1
         UNION
         SELECT g.id FROM groups g JOIN d ON g.parent_id = d.id
       ) SELECT id FROM d`,
      [id],
    );
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------ credentials

  async function getCredential(ref) {
    const { rows } = await pool.query(
      'SELECT ref, username, secret, created_at FROM credentials WHERE ref = $1', [ref]);
    return rows[0] || null;
  }

  async function putCredential(ref, cred = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO credentials (ref, username, secret) VALUES ($1, $2, $3)
       ON CONFLICT (ref) DO UPDATE SET username = EXCLUDED.username, secret = EXCLUDED.secret
       RETURNING ref, username, secret, created_at`,
      [ref, cred.username ?? null, cred.secret ?? null],
    );
    return row;
  }

  async function removeCredential(ref) {
    const { rowCount } = await pool.query('DELETE FROM credentials WHERE ref = $1', [ref]);
    return rowCount > 0;
  }

  // A credential is SHARED by a DVR and its children (amendment E7): the last one to leave removes it,
  // and the devices keep the reference in `meta` (the table has no column for it).
  async function credentialInUse(ref) {
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM cameras WHERE credential_ref = $1)
           OR EXISTS (SELECT 1 FROM devices WHERE meta->>'credential_ref' = $1) AS used`,
      [ref],
    );
    return rows[0].used === true;
  }

  // ---------------------------------------------------------------- devices

  async function listDevices() {
    const { rows } = await pool.query(`SELECT ${DEVICE_FIELDS} FROM devices ORDER BY lower(name), id`);
    return rows;
  }

  async function getDevice(id) {
    const { rows } = await pool.query(`SELECT ${DEVICE_FIELDS} FROM devices WHERE id = $1`, [id]);
    return rows[0] || null;
  }

  async function putDevice(d) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO devices (id, name, meta) VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb))
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, meta = EXCLUDED.meta
       RETURNING ${DEVICE_FIELDS}`,
      [d.id || crypto.randomUUID(), d.name, d.meta ?? null],
    );
    return row;
  }

  async function removeDevice(id) {
    const { rowCount } = await pool.query('DELETE FROM devices WHERE id = $1', [id]);
    return rowCount > 0;
  }

  // ------------------------------------------------------------------- ETag

  // last_value only counts as a revision once the sequence was called: before the first bump
  // is_called is false and the value is the START, which is 0.
  async function catalogRev() {
    const { rows } = await pool.query(
      'SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS rev FROM catalog_rev_seq');
    return rows.length ? Number(rows[0].rev) : 0;
  }

  return {
    cameras: {
      listCatalog, get: getCamera, addresses, allAddresses, replaceAddresses, create: createCamera,
      update: updateCamera, remove: removeCamera, setStates, listRecording,
    },
    profiles: {
      listByCamera: listProfilesByCamera, listAll: listProfiles, get: getProfile,
      create: createProfile, update: updateProfile, remove: removeProfile,
    },
    groups: {
      list: listGroups, get: getGroup, create: createGroup, update: updateGroup,
      remove: removeGroup, promoteChildren: promoteGroupChildren, descendants,
    },
    credentials: { get: getCredential, put: putCredential, remove: removeCredential, inUse: credentialInUse },
    devices: { list: listDevices, get: getDevice, put: putDevice, remove: removeDevice },
    catalogRev,
  };
}

module.exports = { catalog };

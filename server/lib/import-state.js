'use strict';
const crypto = require('node:crypto'), net = require('node:net');
const { withTx } = require('./pgpool');

// One-shot import of the legacy state document (spec §8). The document holds most collections as
// objects keyed by id (`state.json`) and two as arrays (`events`, `gaps`); `rows` accepts both and the
// key becomes the id when the record carries none.
const rows = (v) => (Array.isArray(v) ? v : Object.entries(v || {}).map(([id, r]) => ({ id, ...r })));
const json = (v) => (v == null ? null : JSON.stringify(v));
const iso = (v) => v ?? new Date().toISOString();
// Layout timestamps are epoch seconds (`api/layouts.js`); every other timestamp in the document is ISO.
const stamp = (v) => (typeof v === 'number' ? new Date(v * 1000) : v ?? new Date());
const addressText = (a) => (typeof a === 'string' ? a : a.address ?? a.url ?? a.ip ?? JSON.stringify(a));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Legacy candidate ids are `<ip>|<port>`, not UUIDs. Keep a real UUID; mint one otherwise — the row is
// keyed by `ip` from here on, and dropping the whole table would lose the biggest slice of the document.
const uuid = (v) => (UUID_RE.test(String(v)) ? v : crypto.randomUUID());
// `profile_ids` and `retention_days` are gone from the schema (spec §3); these are the only camera
// fields `meta` keeps. `channel_missing` is the live spelling of the legacy `canal_ausente`.
const CAMERA_META = ['onvif', 'ptz', 'positions', 'manual', 'physical_id', 'channel', 'canal_ausente', 'channel_missing'];

function insert(client, table, cols, values) {
  return client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    values,
  );
}

// ponytail: opts is unused — the plan had `configPath`, but `settings` is not imported (spec §8).
async function importState(pool, doc = {}, opts = {}) {
  return withTx(pool, async (client) => {
    const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM cameras');
    if (n > 0) return { imported: false, reason: 'not_empty' };

    const counts = { camera_addresses: 0, camera_grants: 0, candidates: 0, events: 0, gaps: 0 };

    // ---- access ------------------------------------------------------------
    const access = rows(doc.access_profiles);
    const accessIds = new Set(access.map((p) => p.id));
    const users = rows(doc.users);
    // A legacy user can point at a profile that never made it into the document. Recreating it as a
    // system profile keeps the FK valid and loses no user; the alternative is the import aborting.
    for (const u of users) {
      if (!u.profile_id || accessIds.has(u.profile_id)) continue;
      accessIds.add(u.profile_id);
      access.push({ id: u.profile_id, name: u.profile_id, kind: 'system' });
    }
    for (const p of access) {
      // ON CONFLICT: a previous boot may have seeded the system profiles before the import committed.
      await client.query(
        `INSERT INTO access_profiles (id, name, kind, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name ?? p.id, p.kind ?? 'custom', iso(p.created_at), iso(p.updated_at)],
      );
    }
    counts.access_profiles = access.length;

    for (const u of users) {
      // An empty hash is a user that cannot log in — the safe direction when the document lost it.
      await insert(client, 'users',
        ['username', 'profile_id', 'status', 'secret_hash', 'must_change_password',
          'credential_version', 'created_at', 'updated_at'],
        [u.username ?? u.id, u.profile_id, u.status ?? 'active', u.secret_hash ?? '',
          u.must_change_password === true, Number(u.credential_version ?? 1),
          iso(u.created_at), iso(u.updated_at)]);
    }
    counts.users = users.length;

    // ---- catalog -----------------------------------------------------------
    const credentials = Object.entries(doc.credentials || {}).map(([ref, c]) => ({ ...c, ref }));
    for (const c of credentials) {
      await insert(client, 'credentials', ['ref', 'username', 'secret', 'created_at'],
        [c.ref, c.username ?? null, c.secret ?? null, iso(c.created_at)]);
    }
    counts.credentials = credentials.length;
    const credIds = new Set(credentials.map((c) => c.ref));

    const devices = rows(doc.devices);
    for (const d of devices) {
      const { id, name, created_at, ...meta } = d;   // kind/addresses/credential_ref/onvif/channels
      await insert(client, 'devices', ['id', 'name', 'created_at', 'meta'],
        [id, name ?? id, iso(created_at), json(meta)]);
    }
    counts.devices = devices.length;
    const deviceIds = new Set(devices.map((d) => d.id));

    // Parent cycles: every group lands with parent_id NULL, then the edges are applied.
    const groups = rows(doc.groups);
    const groupIds = new Set(groups.map((g) => g.id));
    for (const g of groups) {
      await insert(client, 'groups', ['id', 'name', 'parent_id', 'created_at'],
        [g.id, g.name ?? g.id, null, iso(g.created_at)]);
    }
    for (const g of groups) {
      if (!g.parent_id || !groupIds.has(g.parent_id)) continue;
      await client.query('UPDATE groups SET parent_id = $1 WHERE id = $2', [g.parent_id, g.id]);
    }
    counts.groups = groups.length;

    const cameras = rows(doc.cameras);
    const camIds = new Set(cameras.map((c) => c.id));
    for (const c of cameras) {
      const meta = {};
      for (const k of CAMERA_META) if (c[k] !== undefined) meta[k] = c[k];
      await insert(client, 'cameras',
        ['id', 'name', 'state', 'added_via', 'recording', 'error_code', 'credential_ref',
          'device_id', 'group_id', 'created_at', 'updated_at', 'meta'],
        [c.id, c.name ?? c.id, c.state ?? 'provisioning', c.added_via ?? null,
          c.recording === true, c.error_code ?? null,
          credIds.has(c.credential_ref) ? c.credential_ref : null,
          deviceIds.has(c.device_id) ? c.device_id : null,
          groupIds.has(c.group_id) ? c.group_id : null,
          iso(c.created_at), iso(c.updated_at ?? c.created_at), json(meta)]);
      const addrs = c.addresses || [];
      for (let ord = 0; ord < addrs.length; ord += 1) {
        await insert(client, 'camera_addresses', ['camera_id', 'ord', 'address'],
          [c.id, ord, addressText(addrs[ord])]);
      }
      counts.camera_addresses += addrs.length;
    }
    counts.cameras = cameras.length;

    const profiles = rows(doc.profiles);
    const profileIds = new Set(profiles.map((p) => p.id));
    for (const p of profiles) {
      await insert(client, 'profiles',
        ['id', 'camera_id', 'name', 'source_url', 'recording_mode', 'width', 'height',
          'onvif_token', 'created_at'],
        [p.id, p.camera_id, p.name ?? p.id, p.source_url ?? null, p.recording_mode ?? null,
          p.width ?? null, p.height ?? null, p.onvif_token ?? null, iso(p.created_at)]);
    }
    counts.profiles = profiles.length;

    // A grant outlives its camera in the document (DELETE /cameras does not clean the map): the FK here.
    const grants = [];
    for (const [profileId, byCamera] of Object.entries(doc.camera_grants || {})) {
      if (!accessIds.has(profileId)) continue;
      for (const [cameraId, level] of Object.entries(byCamera || {})) {
        if (camIds.has(cameraId)) grants.push([profileId, cameraId, level]);
      }
    }
    for (const g of grants) await insert(client, 'camera_grants', ['profile_id', 'camera_id', 'level'], g);
    counts.camera_grants = grants.length;

    // ---- operation ---------------------------------------------------------
    // The pg.js document (12 keys) has no `layouts`; it has `walls` with the same fields.
    const layouts = rows(Object.keys(doc.layouts || {}).length ? doc.layouts : doc.walls);
    for (const l of layouts) {
      await insert(client, 'layouts', ['id', 'name', 'cells', 'created_ts', 'updated_ts'],
        [l.id, l.name ?? l.id, json(l.cells || []), stamp(l.created_ts), stamp(l.updated_ts)]);
    }
    counts.layouts = layouts.length;

    const exports_ = rows(doc.exports);
    for (const e of exports_) {
      await insert(client, 'exports',
        ['id', 'stream_profile_id', 'camera_name', 'state', 'progresso', 'path', 'bytes', 'error',
          'created_at', 'updated_at'],
        [e.id, profileIds.has(e.stream_profile_id) ? e.stream_profile_id : null, e.camera_name ?? null,
          e.state ?? 'queued', Number(e.progresso ?? 0), e.path ?? null, e.bytes ?? null,
          e.error ?? null, iso(e.created_at), iso(e.updated_at)]);
    }
    counts.exports = exports_.length;

    const scans = rows(doc.scans);
    const scanIds = new Set(scans.map((s) => s.id));
    for (const s of scans) {
      await insert(client, 'scans', ['id', 'kind', 'state', 'scope', 'found', 'error',
        'started_ts', 'finished_ts'],
        [s.id, s.kind ?? null, s.state ?? 'done', json(s.scope), Number(s.found ?? 0),
          s.error ?? null, iso(s.started_ts), s.finished_ts ?? null]);
    }
    counts.scans = scans.length;

    for (const c of rows(doc.candidates)) {
      // A hostname in `ip` would abort the transaction on the inet cast: drop the row, keep the import.
      if (c.ip != null && !(typeof c.ip === 'string' && net.isIP(c.ip))) continue;
      await insert(client, 'candidates',
        ['id', 'scan_id', 'ip', 'xaddr', 'name', 'manufacturer', 'model', 'status', 'outcome',
          'seen_count', 'video_sources', 'open_ports', 'first_seen_at', 'last_seen_at'],
        [uuid(c.id), scanIds.has(c.scan_id) ? c.scan_id : null, c.ip ?? null, c.xaddr ?? null,
          c.name ?? null, c.manufacturer ?? null, c.model ?? null, c.status ?? null, c.outcome ?? null,
          Number(c.seen_count ?? 1), json(c.video_sources ?? c.videoSources ?? []),
          c.open_ports ?? c.openPorts ?? [], iso(c.first_seen_at), iso(c.last_seen_at ?? c.first_seen_at)]);
      counts.candidates += 1;
    }

    for (const g of rows(doc.gaps)) {
      if (!profileIds.has(g.stream_profile_id)) continue;   // orphan gap: its profile is gone
      await insert(client, 'gaps', ['id', 'stream_profile_id', 'from_ts', 'to_ts', 'reason'],
        [g.id, g.stream_profile_id, g.from_ts, g.to_ts, g.reason ?? null]);
      counts.gaps += 1;
    }

    for (const e of rows(doc.events)) {
      await insert(client, 'events', ['id', 'ts', 'kind', 'severity', 'message', 'camera_id', 'profile_id'],
        [e.id, e.ts, e.kind ?? '', e.severity ?? 'info', e.message ?? '',
          camIds.has(e.camera_id) ? e.camera_id : null,
          profileIds.has(e.profile_id) ? e.profile_id : null]);
      counts.events += 1;
    }

    return { imported: true, counts };
  });
}

module.exports = { importState };

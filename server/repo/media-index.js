'use strict';
const { mergeCoverage } = require('../lib/fmp4index');
// Persisted media index (plan 2026-10-20): one row per hour file plus one row per (profile, day) with
// the directory mtime that lets the discovery scan skip unchanged days. Every write is one statement
// over UNNEST — the index holds tens of thousands of hours and the boot must not pay a query per row.
//
// `day` travels as text ('YYYY-MM-DD') in both directions: node-postgres would hand back a Date in the
// process timezone, and the index works with day folders, not instants.

async function loadAll(pool) {
  const { rows } = await pool.query(
    `SELECT profile_id, day::text AS day, hour, session, path, size_bytes, mtime_ns, timescale, nominal_ms,
            init_fim, anchor, end_ts, frags, coverage, frag_count, error
       FROM media_hours`);
  return rows;
}

// Boot view (plan 2026-10-20): everything EXCEPT `frags`. The fragments of an hour are read only when
// someone seeks into it (`fragsFor`), so 30k hours cost 30k small rows instead of 35M fragments.
async function loadMeta(pool) {
  const { rows } = await pool.query(
    `SELECT profile_id, day::text AS day, hour, session, path, size_bytes, mtime_ns, timescale, nominal_ms,
            init_fim, anchor, end_ts, coverage, frag_count, error
       FROM media_hours`);
  return rows;
}

// One (profile, day) window of metadata for the timeline (plan 2026-10-20, T1): the days a query is
// about to display. Never `frags` — an hour's fragments stay one PK lookup away.
async function loadWindow(pool, profile, days = []) {
  if (!days.length) return [];
  const { rows } = await pool.query(
    `SELECT profile_id, day::text AS day, hour, session, path, size_bytes, mtime_ns, timescale, nominal_ms,
            init_fim, anchor, end_ts, coverage, frag_count, error
       FROM media_hours
      WHERE profile_id = $1 AND day = ANY($2::date[])`,
    [profile, days]);
  return rows;
}

// Metadata-only view for the retention pass: it plans over the WHOLE archive, so the query is not
// windowed, but the 35M fragments stay in the database (ponytail: no cursor dependency — retention
// needs the complete list anyway; `frags` is what made this read expensive).
async function listAll(pool) {
  const { rows } = await pool.query(
    `SELECT profile_id, day::text AS day, hour, session, path, size_bytes, init_fim, anchor, coverage, frag_count
       FROM media_hours`);
  return rows;
}

// Fragments of ONE hour (PK lookup): flat quadruples [t0, t1, byteStart, size]. Empty when the row is
// gone — a removed hour is not an error. `session` separates the files of an hour whose recording was
// resumed at the same hour (spec 2026-10-21); callers without a session read the original row (0).
async function fragsFor(pool, profile, day, hour, session = 0) {
  const { rows } = await pool.query(
    'SELECT frags FROM media_hours WHERE profile_id = $1 AND day = $2::date AND hour = $3 AND session = $4',
    [profile, day, hour, session]);
  return rows.length && Array.isArray(rows[0].frags) ? rows[0].frags : [];
}

// Light view for the orphan sweep: the scan compares these paths with what the disk has now.
async function listPaths(pool) {
  const { rows } = await pool.query('SELECT profile_id, day::text AS day, path FROM media_hours');
  return rows;
}

async function upsertHours(pool, rows = []) {
  if (!rows.length) return 0;
  const col = (k) => rows.map((r) => (r[k] === undefined ? null : r[k]));
  // A caller that does not carry `coverage`/`frag_count` (an older row, a test fixture) gets both
  // derived from `frags`: the timeline must never see a row with fragments and no coverage.
  const coverage = (r) => r.coverage || mergeCoverage(r.frags || []);
  const count = (r) => (r.frag_count === undefined || r.frag_count === null
    ? (r.frags || []).length : r.frag_count);
  await pool.query(
    `INSERT INTO media_hours (profile_id, day, hour, session, path, size_bytes, mtime_ns, timescale, nominal_ms,
            init_fim, anchor, end_ts, frags, coverage, frag_count, error)
     SELECT a.profile_id, a.day::date, a.hour, a.session, a.path, a.size_bytes, a.mtime_ns, a.timescale, a.nominal_ms,
            a.init_fim, a.anchor, a.end_ts, a.frags, a.coverage, a.frag_count, a.error
       FROM UNNEST($1::text[], $2::text[], $3::smallint[], $16::smallint[], $4::text[], $5::bigint[], $6::bigint[],
                   $7::int[], $8::int[], $9::bigint[], $10::bigint[], $11::bigint[], $12::jsonb[],
                   $13::jsonb[], $14::int[], $15::text[])
         AS a(profile_id, day, hour, session, path, size_bytes, mtime_ns, timescale, nominal_ms, init_fim, anchor,
              end_ts, frags, coverage, frag_count, error)
     ON CONFLICT (profile_id, day, hour, session) DO UPDATE SET
       path = EXCLUDED.path, size_bytes = EXCLUDED.size_bytes, mtime_ns = EXCLUDED.mtime_ns,
       timescale = EXCLUDED.timescale, nominal_ms = EXCLUDED.nominal_ms, init_fim = EXCLUDED.init_fim,
       anchor = EXCLUDED.anchor, end_ts = EXCLUDED.end_ts, frags = EXCLUDED.frags,
       coverage = EXCLUDED.coverage, frag_count = EXCLUDED.frag_count, error = EXCLUDED.error,
       scanned_at = now()`,
    // node-postgres binds BY POSITION: the session array rides at the END of the arguments array
    // (16th -> $16). Putting it at the hour position would renumber $4 (path) and break the INSERT.
    [col('profile_id'), col('day'), col('hour'), col('path'), col('size_bytes'), col('mtime_ns'),
      col('timescale'), col('nominal_ms'), col('init_fim'), col('anchor'), col('end_ts'),
      rows.map((r) => JSON.stringify(r.frags || [])), rows.map((r) => JSON.stringify(coverage(r))),
      rows.map(count), col('error'),
      rows.map((r) => (r.session === undefined || r.session === null ? 0 : r.session))],  // 16th argument = $16
  );
  return rows.length;
}

// Deletes by PATH: the callers (retention and the orphan sweep) know the files, not the keys.
async function deleteHours(pool, paths = []) {
  if (!paths.length) return 0;
  const { rowCount } = await pool.query('DELETE FROM media_hours WHERE path = ANY($1::text[])', [paths]);
  return rowCount;
}

// deletes the hours AND the day rows left without any hour: the file is gone, its day knowledge is gone.
async function forget(pool, paths = []) {
  const deleted = await deleteHours(pool, paths);
  if (!deleted) return 0;
  await pool.query(
    `DELETE FROM media_days d
      WHERE NOT EXISTS (SELECT 1 FROM media_hours h
                         WHERE h.profile_id = d.profile_id AND h.day = d.day)`);
  return deleted;
}

async function loadDays(pool) {
  const { rows } = await pool.query(
    `SELECT profile_id, day::text AS day, dir_mtime_ns, hour_files FROM media_days`);
  return rows;
}

async function upsertDays(pool, rows = []) {
  if (!rows.length) return 0;
  const col = (k) => rows.map((r) => (r[k] === undefined ? null : r[k]));
  await pool.query(
    `INSERT INTO media_days (profile_id, day, dir_mtime_ns, hour_files)
     SELECT a.profile_id, a.day::date, a.dir_mtime_ns, a.hour_files
       FROM UNNEST($1::text[], $2::text[], $3::bigint[], $4::int[])
         AS a(profile_id, day, dir_mtime_ns, hour_files)
     ON CONFLICT (profile_id, day) DO UPDATE SET
       dir_mtime_ns = EXCLUDED.dir_mtime_ns, hour_files = EXCLUDED.hour_files, scanned_at = now()`,
    [col('profile_id'), col('day'), col('dir_mtime_ns'), col('hour_files')],
  );
  return rows.length;
}

module.exports = { loadAll, loadMeta, loadWindow, listAll, fragsFor, listPaths, upsertHours,
  deleteHours, forget, loadDays, upsertDays };

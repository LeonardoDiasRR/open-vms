'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path');
const { buckets } = require('../lib/timeline');
const { AppError } = require('../lib/errors');
const { appendEvent } = require('../lib/events');
const { mediaIdentity } = require('../lib/fmp4index');
// ponytail: routes = path->handler map, testable without an HTTP server
const MAX_BUCKETS = 10000; // ceiling avoids OOM/DoS on an absurd period (a 30M-bucket timeline took the process down)
const MAX_EXPORT_SECONDS = 1800; // spec 2026-10-19 (video export, user E1): 30 min ceiling
// plan 2026-10-23 (description on the export): the operator names the export. The description is a
// display field. The file name stays `exportName()`. Limit in UTF-16 units; the CHECK of the
// database uses char_length (code points) and is therefore looser. It never refuses what passed here.
const MAX_DESCRIPTION = 50;
const limpaDescricao = (s) => String(s ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
// spec 2026-10-23 (batch deletion/download): the client sends ids; the format is checked BEFORE the
// query. Plan amendment E2.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DELETE = 100;
const idsDe = (v, max) => {
  if (!Array.isArray(v) || v.length === 0 || v.length > max
    || v.some((x) => typeof x !== 'string' || !UUID.test(x))) {
    throw new AppError('field_invalid', { field: 'ids' });
  }
  return [...new Set(v)];
};
function archiveRoutes(store, deps) {
  // Profiles come from the catalog (spec 2026-10-20 §3); every method is async.
  const requireProfile = async (id) => {
    const p = await store.catalog.profiles.get(id);
    if (!p) throw new AppError('stream_profile_not_found');
    return p;
  };
  // spec 2026-10-18 (5.2): the read comes from the INDEX derived from the file; the disk is not
  // scanned on every query.
  const mediaIndex = () => {
    if (!deps.indice) throw new AppError('media_index_missing');
    return deps.indice;
  };
  // The hour-file address: the per-session delivery route (spec 5.3). The disk path NEVER leaves here
  // — only the `HH.mp4` name.
  const fileUrl = (profileId, file) => `/api/v1/play/${profileId}/${encodeURIComponent(mediaIdentity(file))}/file`;
  // spec 2026-10-19 (video export, sec 3): the file name = camera + period in America/Boa_Vista. The
  // container runs in UTC (measured on the boot probe): without an EXPLICIT zone the name would drift
  // 4 h from what the user sees in the UI. The sv-SE format yields ISO '2026-10-19 10:00'.
  const cameraSlug = (name) => {
    const s = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
      .slice(0, 40);
    return s || 'camera';
  };
  const datePart = (ts) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Boa_Vista',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(ts * 1000)).replace(' ', 'T').replace(':', '');
  const exportName = ({ camera_name, from, to }) =>
    `${cameraSlug(camera_name)}_${datePart(from)}_${datePart(to)}.mp4`;
  // The public shape (GET /exports and the POST response): the disk path NEVER leaves the server
  // (house rule, see fileUrl) — whoever downloads resolves it by id on the delivery route.
  // The display fields (`name`, `from_ts`, `to_ts`) live in the row since migration 002, so the
  // listing says which camera period a job is, not only the POST response.
  const publicShape = (j) => ({ id: j.id, stream_profile_id: j.stream_profile_id, camera_name: j.camera_name,
    name: j.name, description: j.description, from_ts: j.from_ts, to_ts: j.to_ts, state: j.state, progress: j.progresso,
    // bigint arrives as text from pg; the contract is a number, as the document store handed it.
    bytes: j.bytes == null ? j.bytes : Number(j.bytes),
    created_at: j.created_at, error: j.error });
  return {
    'GET /api/v1/archive/timeline': async ({ stream_profile_id, from, to, bucket_seconds = 60 }) => {
      // trust-boundary defence: the handler does not trust the caller/query type (string + step means
      // endless concatenation -> OOM)
      from = Number(from); to = Number(to); bucket_seconds = Number(bucket_seconds) || 60;
      await requireProfile(stream_profile_id);
      const nBuckets = Math.ceil((to - from) / bucket_seconds);
      if (!(to > from)) throw new AppError('period_invalid');
      if (nBuckets > MAX_BUCKETS) throw new AppError('period_too_long', { buckets: MAX_BUCKETS });
      const now = Math.floor(Date.now() / 1000);
      // One item per HOUR FILE (spec 5.2): the response shape did not change, only what fills it. Since
      // plan 2026-10-20 the index answers on demand: this call LOADS the (profile, day) window of the
      // period (one query per day) and the two calls below read it from the window cache.
      const ranges = await mediaIndex().segments(stream_profile_id, from, to, now);
      // EVENT gap (gaps table) + engine INTERNAL gap (the hour switch, spec 5.1): both describe a
      // coverage hole and the client sees a single list. bigint arrives as text from pg: the response
      // keeps numbers, as the document store used to hand them.
      const eventGaps = (await store.ops.gaps.listByProfile(stream_profile_id, from, to)).map((g) => ({
        stream_profile_id: g.stream_profile_id, from_ts: Number(g.from_ts), to_ts: Number(g.to_ts),
        ...(g.reason == null ? {} : { reason: g.reason }),
      }));
      const gaps = [...eventGaps, ...(await mediaIndex().gaps(stream_profile_id, from, to))];
      // `recording` tells the truth (spec 2026-10-21, 4.4): the honest end of the open hour — where
      // its fragments stop (+ GRACE) — never the wall clock. Only the index can read the fragments
      // of an open hour, so the index computes it (plan amendment E5).
      const recording = await mediaIndex().recordingWindow(stream_profile_id, from, to, now);
      return { profile_id: stream_profile_id, from, to, bucket_seconds, buckets: buckets(ranges, from, to, bucket_seconds),
        gaps, segments: ranges.length,
        // spec 2026-10-17: the client needs the real boundaries and the address of each range. `url` is
        // the relative ROUTE (the client adds base + token): the disk path does not leave here.
        segmentos: ranges.map((t) => ({ start_ts: t.start_ts, end_ts: t.end_ts, bytes: t.bytes,
          url: fileUrl(stream_profile_id, t.file) })),
        recording };
    },
    // spec 2026-10-19 (video export): the export becomes an ASYNC JOB. The POST validates, records
    // 'queued' and returns at once; the heavy work walks the queue (deps.queue), one worker_thread per
    // job, ceiling = floor(cpus/2) measured at boot by main.js. The recording disk gate
    // (recordingBlocked, 80% with hysteresis) DENIES the request (507) — no new math.
    'POST /api/v1/archive/export': async ({ stream_profile_id, from, to, description }) => {
      const p = await requireProfile(stream_profile_id);
      from = Number(from); to = Number(to);
      if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) throw new AppError('period_invalid');
      if (to - from > MAX_EXPORT_SECONDS) throw new AppError('export_period_too_long');
      // plan 2026-10-23: fails fast, before the disk gate and the index scan.
      const descricao = limpaDescricao(description);
      if (!descricao || descricao.length > MAX_DESCRIPTION) throw new AppError('field_invalid', { field: 'description' });
      if (deps.recordingBlocked && deps.recordingBlocked()) throw new AppError('export_disk_full');
      const fragments = await mediaIndex().range(stream_profile_id, from, to);
      if (!fragments.length) throw new AppError('recording_in_period_missing');
      // spec 2026-10-20 (export naming): the file name is the CAMERA's, not the stream profile's —
      // a real install names the profile `mainStream`. Fallback order: camera, profile, profile id.
      const cam = await store.catalog.cameras.get(p.camera_id);
      const camera_name = (cam && cam.name) || p.name || stream_profile_id;
      const name = exportName({ camera_name, from, to });
      const id = randomUUID();
      // The job row goes to the store; fragments+dest live in the queue payload (memory), never in the
      // database: the worker does not depend on a live index and the boot sweep turns an abandoned job
      // into the failed state anyway.
      const job = await store.ops.exports.put(id, { stream_profile_id, camera_name,
        name, description: descricao, from_ts: from, to_ts: to,
        state: 'queued', progresso: 0, created_at: new Date().toISOString() });
      // spec 2026-10-20 (export folder): finished clips live with the recordings, under
      // <archive_dir>/export/. The container /tmp died with every API recreation. mkdir here keeps
      // the queue and the worker file-system-free, as they are today.
      const exportDir = path.join(deps.archiveRoot, 'export');
      fs.mkdirSync(exportDir, { recursive: true });
      deps.queue.submit(id, { fragments, dest: path.join(exportDir, name) });
      return publicShape(job);
    },
    // Amendment E1: the deleted filter stays HERE. It is the only reader and the test mem-store does not
    // need a rule of its own.
    'GET /api/v1/exports': async () => (await store.ops.exports.list())
      .filter((j) => j.state !== 'deleted').map(publicShape),
    // spec 2026-10-23 (batch deletion): all or nothing. A job in queued/exporting refuses the whole
    // batch BEFORE any unlink. A silent partial deletion is worse to explain.
    'DELETE /api/v1/exports': async ({ ids }) => {
      const pedidos = idsDe(ids, MAX_DELETE);
      const jobs = [];
      for (const id of pedidos) {
        const j = await store.ops.exports.get(id);
        if (j) jobs.push(j);
      }
      const ativos = jobs.filter((j) => j.state === 'queued' || j.state === 'exporting').map((j) => j.id);
      if (ativos.length) throw new AppError('export_active', { ids: ativos.join(', ') });
      const existentes = new Set(jobs.map((j) => j.id));
      const deleted = [];
      for (const j of jobs) {
        // force: true makes ENOENT a non-error; any other error (EACCES) propagates and nothing else is marked
        if (j.path) fs.rmSync(j.path, { force: true });
        // Amendment E1: the record stays (audit trail). The path is cleared so the file route does not serve it
        await store.ops.exports.put(j.id, { state: 'deleted', path: null });
        const p = j.stream_profile_id ? await store.catalog.profiles.get(j.stream_profile_id) : null;
        await appendEvent(store, { kind: 'export', severity: 'info', message: 'export deleted',
          camera_id: (p && p.camera_id) || null, profile_id: j.stream_profile_id || null });
        deleted.push(j.id);
      }
      const missing = pedidos.filter((id) => !existentes.has(id));
      return { deleted, missing };
    },
  };
}
module.exports = { archiveRoutes };


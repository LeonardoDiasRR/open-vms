'use strict';
const fs = require('node:fs');
const { resolveSegment } = require('../lib/archive');
const { AppError } = require('../lib/errors');

// ponytail: binary handlers kept apart from the JSON map; each returns bytes/path + contentType (or
// throws AppError) and main decides how to write the response.

// GET /api/v1/exports/:id/file -> { path, bytes, contentType: 'video/mp4' } (streaming in main).
// async: the job row comes from the store (spec 2026-10-20).
async function exportFileHandler(store, exportId) {
  const job = await store.ops.exports.get(exportId);
  if (!job) throw new AppError('export_not_found');
  if (!job.path || !fs.existsSync(job.path)) throw new AppError('export_file_missing');
  // spec 2026-10-19 (video export, sec 3): `Content-Disposition` carries the job name — a shared link
  // downloads under the right name (camera + period), not the /tmp slug.
  const name = job.name || `export-${exportId}.mp4`;
  return { path: job.path, bytes: fs.statSync(job.path).size, contentType: 'video/mp4',
    disposition: `attachment; filename="${name}"` };
}

// GET /api/v1/segments/:profile_id/:start_ts/file -> { path, bytes, contentType } (streaming in main),
// the SAME shape as the export file. The client never sends a path: start_ts is resolved on disk, and
// the segment still being recorded stays out (listSegments already excludes it).
function segmentFileHandler(state, deps, profileId, startTs) {
  if (!state.get().profiles[profileId]) throw new AppError('stream_profile_not_found');
  if (!deps.archiveRoot) throw new AppError('archive_root_missing');
  const segment = resolveSegment({
    base: deps.archiveRoot, profileId, startTs, chunkSeconds: deps.chunkSeconds,
    recording: !!(deps.recording && deps.recording(profileId)),
  });
  if (!segment) throw new AppError('segment_not_found');
  return { path: segment.file, bytes: segment.bytes, contentType: 'video/mp4' };
}

module.exports = { exportFileHandler, segmentFileHandler };

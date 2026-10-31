'use strict';
const fs = require('node:fs'), path = require('node:path');

// ponytail: retention = two pure functions + a disk effect. Since 2026-10-18 the unit is the HOUR
// FILE (spec 5.5): the state keeps no segment at all and the source is the INDEX — there is no
// parallel storage index, and what the index indexed is what exists on disk.

// Retention days when the camera has no saved value (spec 2026-10-15). Whoever resolves it per camera
// is main; only the number lives here, so both sides speak the same default.
const DEFAULT_RETENTION_DAYS = 3;

// Plans what to delete. Does not touch disk.
// `hours`: [{ profile, file, start, end|null, bytes, day }] — the shape the index delivers.
//   `end === null` = OPEN (current) file: never enters the plan, under either rule.
// daysFor(hora) > 0: deletes once the WHOLE DAY has expired (`day + 86400 <= now - days*86400`),
//   which takes every hour of that day along — the "day folder" rule of spec 5.5. The `<=` is the
//   boundary: the folder that ENDS exactly at the cut is already outside the window (with `<` it
//   stayed for one second and the exact-ceiling case never went out).
// maxBytes > 0: GLOBAL FIFO from oldest to newest, deleting while what remains exceeds the ceiling.
function planRetention({ hours = [], now, maxDays = 0, maxBytes = 0, daysFor = null }) {
  const all = hours.slice();
  const open = new Set(all.filter((h) => h.end === null).map((h) => h.file));
  const del = new Set();

  if (maxDays > 0 || daysFor) {
    for (const h of all) {
      if (open.has(h.file)) continue;
      const days = daysFor ? Number(daysFor(h)) || 0 : maxDays;
      if (!(days > 0)) continue;
      if ((h.day + 86400) <= now - days * 86400) del.add(h.file);
    }
  }

  if (maxBytes > 0) {
    const ordered = all.filter((h) => !del.has(h.file)).sort((a, b) => a.start - b.start);
    let kept = ordered.reduce((n, h) => n + (h.bytes || 0), 0);
    for (const h of ordered) {
      if (kept <= maxBytes) break;
      if (open.has(h.file)) continue;
      del.add(h.file);
      kept -= h.bytes || 0;
    }
  }

  return { del: all.filter((h) => del.has(h.file)), keep: all.filter((h) => !del.has(h.file)) };
}

// Applies the plan: deletes the hour files, tries to remove the day folders left empty.
// Returns { deleted, bytesFreed, files } — `files` is what the caller needs to drop the index records and
// the media_hours rows that describe them (plan 2026-10-20, T10). It touches no state otherwise.
function runRetention({ hours = [], now = Date.now() / 1000, maxDays = 0, maxBytes = 0, daysFor = null }) {
  const { del } = planRetention({ hours, now, maxDays, maxBytes, daysFor });
  let bytesFreed = 0;
  const dirs = new Set();
  const files = [];
  for (const h of del) {
    fs.rmSync(h.file, { force: true });   // ponytail: force=missing is not an error
    fs.rmSync(h.file + '.start', { force: true });   // anchor sidecar of the hour file (plan 2026-10-20)
    bytesFreed += h.bytes || 0;
    files.push(h.file);
    dirs.add(path.dirname(h.file));
  }
  // ponytail: best effort; a directory with a live file stays, the catch is the signal.
  for (const d of dirs) { try { fs.rmdirSync(d); } catch {} }
  return { deleted: del.length, bytesFreed, files };
}

module.exports = { planRetention, runRetention, DEFAULT_RETENTION_DAYS };

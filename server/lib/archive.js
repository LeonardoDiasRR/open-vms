'use strict';
// Reading the recording chunks straight from DISK (spec 2026-10-16: the state.segments index is
// only written at the end of a session of up to 3 h, and disappears when the container restarts in
// the middle). Knows no state: it receives the root, the profile and the window.
const fs = require('node:fs');
const path = require('node:path');

const SEGMENT_RE = /^segment_(\d{6})\.m4s$/;

// day directory in the LOCAL timezone: <base>/<profile>/YYYY/MM/DD (the same layout as the recorder)
function dayDir(base, when) {
  return path.join(base, String(when.getFullYear()),
    String(when.getMonth() + 1).padStart(2, '0'), String(when.getDate()).padStart(2, '0'));
}

function daysInRange(from, to) {
  const days = [];
  const d = new Date(from * 1000); d.setHours(0, 0, 0, 0);
  const end = new Date(to * 1000); end.setHours(23, 59, 59, 999);
  while (d <= end) { days.push(new Date(d)); d.setDate(d.getDate() + 1); }
  return days;
}

// Segments that EXIST on disk in the interval. The last file becomes `recordingOpen` when the worker
// of that profile is alive AND the file was touched within chunkSeconds: an mp4 without a moov does
// not open (measured), so it never enters `segments`.
function listSegments({ base, profileId, from, to, chunkSeconds = 300, recording: recording = false, now: now = Math.floor(Date.now() / 1000) }) {
  const root = profileId ? path.join(base, profileId) : base;
  const files = [];
  for (const day of daysInRange(from, to)) {
    const dir = dayDir(root, day);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = SEGMENT_RE.exec(name);
      if (!m) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || st.size === 0) continue;
      files.push({ file: full, number: +m[1], mtime: Math.floor(st.mtimeMs / 1000), bytes: st.size });
    }
  }
  files.sort((a, b) => a.mtime - b.mtime || a.number - b.number);

  const segments = [];
  let recordingOpen = null;
  for (let i = 0; i < files.length; i++) {
    const a = files[i];
    const previous = i > 0 ? files[i - 1].mtime : a.mtime - chunkSeconds;
    const isLast = i === files.length - 1;
    if (isLast && recording && a.mtime > now - chunkSeconds) {
      recordingOpen = { start_ts: previous, end_ts: now };
      continue;
    }
    segments.push({ file: a.file, start_ts: previous, end_ts: a.mtime, bytes: a.bytes });
  }
  return { segments: segments.filter((t) => t.end_ts > from && t.start_ts < to), recordingOpen };
}

// Segment the client ASKED for by start_ts. The scan of now may have shifted the boundary (a new
// chunk changes the `previous` of the last file), so an exact match wins and, failing that, the
// segment that CONTAINS the requested instant. With no segment in the window, returns null.
function resolveSegment({ base, profileId, startTs, chunkSeconds = 300, recording: recording = false }) {
  const window = chunkSeconds * 2;
  const { segments } = listSegments({
    base, profileId, from: startTs - window, to: startTs + window, chunkSeconds, recording: recording,
  });
  return segments.find((t) => t.start_ts === startTs)
    || segments.find((t) => t.start_ts <= startTs && startTs < t.end_ts)
    || null;
}

module.exports = { listSegments, resolveSegment, dayDir, daysInRange, SEGMENT_RE };

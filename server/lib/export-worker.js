'use strict';
// spec 2026-10-19 (video-export): the export "worker". Runs in a worker_thread: copying the bytes
// and running ffmpeg do NOT freeze the server event loop (that was the execFileSync in exportRange).
// postMessage protocol: { type: 'progress', progress } | { type: 'done', path, bytes }
// | { type: 'error', error }.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { exportRange } = require('./exporter');

// ponytail: the fragment shape is the index one ({ size, byteStart }), consumed as is
const total = workerData.fragments.reduce((s, f) => s + f.size, 0) || 1;
let last = { pct: -100, t: 0 };
// spec 2026-10-20 (export folder): write `<dest>.part` and rename to the final name on success. The
// rename is atomic inside the same filesystem (the archive_dir), so a download of the previous clip
// never observes a half-written file.
const dest = workerData.dest;
const part = `${dest}.part`;
try {
  const out = exportRange({
    fragments: workerData.fragments, dest: part,
    // throttle: at least 5 points OR at least 1 s between events — a 1 s fragment job would write
    // ~1800 mutates over a 30 min period and spam the state.json.
    progress: (bytes) => {
      const pct = Math.min(99, Math.floor(100 * bytes / total));
      const now = Date.now();
      if (pct - last.pct >= 5 || now - last.t >= 1000) {
        last = { pct, t: now };
        parentPort.postMessage({ type: 'progress', progress: pct });
      }
    },
  });
  fs.renameSync(part, dest);
  parentPort.postMessage({ type: 'done', path: dest, bytes: out.bytes });
} catch (e) {
  try { fs.unlinkSync(part); } catch { /* the part may never have been created */ }
  parentPort.postMessage({ type: 'error', error: e.message });
}

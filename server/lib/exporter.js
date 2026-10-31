'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AppError } = require('./errors');

// Exports the requested window (spec 5.5) WITHOUT re-encoding: extracts `<init><fragments of the
// interval>` from EACH hour file into a temporary fMP4 and joins the temporaries with the SAME
// `-f concat -c copy` the old exporter used. A single init with fragments from different files is not
// valid (each file's `tfdt` restarts at 0 — spec risk 3), which is why the extraction is PER FILE.
// Measured: two 5 s temporaries -> `ffprobe` reports 10.000 s, ffmpeg exit 0.
function extract({ file, initFim, fragments, dest, progress }) {
  const input = fs.openSync(file, 'r');
  const output = fs.openSync(dest, 'w');
  let total = 0;
  try {
    const init = Buffer.alloc(initFim);
    fs.readSync(input, init, 0, initFim, 0);
    fs.writeSync(output, init);
    for (const f of fragments) {
      const b = Buffer.alloc(f.size);
      fs.readSync(input, b, 0, f.size, f.byteStart);
      fs.writeSync(output, b);
      // spec 2026-10-19 (video-export): ADDITIVE progress — fragment bytes already copied, after
      // each write. Callers that pass no callback (all the old ones) are unaffected.
      total += f.size;
      if (progress) progress(total);
    }
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
  return fs.statSync(dest).size;
}

// `fragments`: [{ file, initFim, byteStart, size, t0 }] in chronological order (the shape of the
// index `range`). `dest` is the output path. Returns { path, bytes, fragmentsUsed }.
function exportRange({ fragments = [], dest, progress }) {
  if (!fragments.length) throw new AppError('segments_missing');
  const byFile = new Map();
  for (const f of fragments) {
    if (!byFile.has(f.file)) byFile.set(f.file, { initFim: f.initFim, fragments: [] });
    byFile.get(f.file).fragments.push(f);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovms-export-'));
  try {
    const parts = [];
    for (const [file, p] of byFile) {
      const tmp = path.join(dir, `part-${parts.length}.mp4`);
      extract({ file, initFim: p.initFim, fragments: p.fragments, dest: tmp, progress });
      parts.push(tmp);
    }
    // A single file: the temporary IS the clip (copy, no ffmpeg). Two or more: concat with `-c copy`.
    if (parts.length === 1) {
      fs.copyFileSync(parts[0], dest);
    } else {
      const list = path.join(dir, 'list.txt');
      fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      // explicit `-f mp4`: the worker writes to `<dest>.part` and ffmpeg guesses the format from the
      // extension. Without this it refuses the `.part` (measured in production, 2026-10-23).
      execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
        '-i', list, '-c', 'copy', '-f', 'mp4', '-y', dest], { timeout: 60000 });
    }
    return { path: dest, bytes: fs.statSync(dest).size, fragmentsUsed: fragments.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { exportRange, extract };

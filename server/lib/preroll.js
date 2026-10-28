'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
// Regression 2026-10-27: same single-array spawn contract bug as motion-detector (see its header).
const defaultSpawn = (args) => cp.spawn('/usr/bin/ffmpeg', args, { stdio: 'ignore' });

// Spec 2026-10-23 (§6.3): 60 s buffer on the LOCAL disk (/tmp) with `-c copy`. On the event the last
// segments are copied into the file as sessions of the hour — never re-encoded. `copyFile` and not
// `rename`: /tmp and the NFS are different file systems (rename would give EXDEV).
const SEGMENT_SECONDS = 10;
const KEEP = 12;                 // 120 s of local buffer
const PROMOTED_BASE = 1000;      // name space of the promoted sessions (E2)

const pad = (n) => String(n).padStart(2, '0');
const localOf = (epoch) => new Date(epoch * 1000);

function buildArgs({ source, dir, segmentSeconds = SEGMENT_SECONDS }) {
  // ponytail: `-rtsp_transport` only applies to rtsp:// — a test file rejects the option.
  // Deviation from the pinned block: the test requires the option in the first two positions; for ffmpeg the order
  // of the input options does not matter, so it comes before `-hide_banner`/`-loglevel`.
  const args = /^rtsp:/i.test(source) ? ['-rtsp_transport', 'tcp'] : [];
  return args.concat([
    '-hide_banner', '-loglevel', 'error',
    '-i', source,
    '-map', '0:v:0', '-c', 'copy',
    '-f', 'segment', '-segment_time', String(segmentSeconds), '-reset_timestamps', '1',
    '-segment_format_options', 'movflags=+empty_moov+default_base_moof+frag_keyframe',
    '-strftime', '1', path.join(dir, '%s.mp4'),
  ]);
}

// Name outside the recorder space (1..90): `<HH>-s<1000 + 10 s slot>`.
function sessionName(epoch, secondsInHour) {
  return `${pad(localOf(epoch).getHours())}-s${PROMOTED_BASE + Math.floor(secondsInHour / SEGMENT_SECONDS)}`;
}

class Preroll {
  constructor({ dir = '/tmp/ovms-preroll', spawn = defaultSpawn, segmentSeconds = SEGMENT_SECONDS, keep = KEEP } = {}) {
    this.dir = dir; this.spawn = spawn; this.segmentSeconds = segmentSeconds; this.keep = keep;
    this.children = new Map();
    this.cleanup = new Map();
  }
  _dir(id) { return path.join(this.dir, id); }
  running(id) { return this.children.has(id); }

  async start(id, { source }) {
    await this.stop(id);
    const dir = this._dir(id);
    await fs.mkdir(dir, { recursive: true });
    const child = this.spawn(buildArgs({ source, dir, segmentSeconds: this.segmentSeconds }));
    this.children.set(id, child);
    // rotation: keeps at most `keep` segments (2 min). A read failure does not bring the buffer down.
    const timer = setInterval(() => { this._prune(id).catch(() => {}); }, this.segmentSeconds * 1000);
    timer.unref?.();
    this.cleanup.set(id, timer);
    child.on?.('exit', () => { if (this.children.get(id) === child) this.children.delete(id); });
    return { dir };
  }

  async _prune(id) {
    let names = [];
    try { names = await fs.readdir(this._dir(id)); } catch { return; }
    const segs = names.filter((n) => /^\d+\.mp4$/.test(n)).sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)));
    for (const name of segs.slice(0, Math.max(0, segs.length - this.keep))) {
      await fs.rm(path.join(this._dir(id), name), { force: true });
    }
  }

  async _halt(id) {
    const child = this.children.get(id);
    if (this.cleanup.has(id)) { clearInterval(this.cleanup.get(id)); this.cleanup.delete(id); }
    if (!child) return;
    this.children.delete(id);
    // SIGINT closes the segment in progress; without it the final piece is lost and the seam with the
    // live session has a gap. Waits up to 5 s and then kills.
    const done = new Promise((resolve) => { child.once?.('exit', resolve); });
    child.kill?.('SIGINT');
    // the cap must not hold the event loop after it resolves (unref)
    await Promise.race([done, new Promise((r) => { const t = setTimeout(r, 5000); t.unref?.(); })]);
  }

  async stop(id) {
    await this._halt(id);
    await fs.rm(this._dir(id), { recursive: true, force: true });
  }

  // Copies the last `seconds` of segment into the file and returns the promoted paths.
  async promote(id, { base, profileId, seconds = 60 }) {
    await this._halt(id);
    let names = [];
    try { names = await fs.readdir(this._dir(id)); } catch { return []; }
    const segs = names
      .map((name) => ({ name, epoch: Number(name.replace(/\.mp4$/, '')) }))
      .filter((s) => /^\d+\.mp4$/.test(s.name) && Number.isFinite(s.epoch))
      .sort((a, b) => a.epoch - b.epoch);
    const take = Math.ceil(seconds / this.segmentSeconds) + 1;
    const out = [];
    for (const s of segs.slice(-take)) {
      const d = localOf(s.epoch);
      const rel = path.join(base, profileId, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
      await fs.mkdir(rel, { recursive: true });
      const dest = path.join(rel, sessionName(s.epoch, d.getMinutes() * 60 + d.getSeconds()) + '.mp4');
      // Deviation from the pinned block: `sessionName` returns only `<HH>-s<n>`; the file index
      // (`fmp4index.HOUR_NAME`) requires `.mp4` — without the extension the promoted session is invisible.
      try {
        await fs.copyFile(path.join(this._dir(id), s.name), dest, fs.constants.COPYFILE_EXCL);
      } catch { continue; } // already promoted (same slot) — does not overwrite
      await fs.writeFile(dest + '.start', `${s.epoch}\n`);
      out.push(dest);
    }
    await fs.rm(this._dir(id), { recursive: true, force: true });
    return out;
  }
}

module.exports = { Preroll, buildArgs, sessionName, SEGMENT_SECONDS, PROMOTED_BASE };

'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { indexFile, HOUR_NAME } = require('./fmp4index');
const { AppError } = require('./errors');

// Continuous recording per hour (spec 2026-10-18, 5.1): ONE fMP4 per profile per hour in
// <base>/<YYYY>/<MM>/<DD>/<HH>.mp4, muxed with `-movflags +faststart+empty_moov+default_base_moof
// +frag_keyframe` — fragment = camera keyframe, NEVER re-encoded. The file name is the ONLY path:
// the index derives its byte ranges from it (spec 5.2) and nothing else describes a segment.

// Day directory in the LOCAL timezone: <base>/<YYYY>/<MM>/<DD> (same layout as before).
function dayDir(base, now = new Date()) {
  return path.join(base, String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
}

// The file of the CURRENT hour: `<dir>/<HH>.mp4` (spec 5.1).
function hourFile(dir, now = new Date()) {
  return path.join(dir, String(now.getHours()).padStart(2, '0') + '.mp4');
}

// The hour does not wait for its turn after a fall (spec 2026-10-21, 4.2): the next session of the
// SAME hour opens `HH-s1.mp4`, `HH-s2.mp4`, ... `HOUR_NAME` comes from fmp4index (single source).
const BUSY_S = 5;        // last session wrote this recently: stay in backoff, open nothing
const MAX_SESSIONS = 50; // hour ceiling; above it the hour is given up for PERMANENT (spec 2)
// Spec 2026-10-23 (E2): the pre-roll promotes its segments into `<HH>-s1000+` — a DIFFERENT name space,
// so they never look like "the last session" and never eat the hour ceiling of the live recorder.
const PROMOTED_FROM = 1000;
const MAX_SESSIONS_MOTION = 90; // motion mode coalesces within the 60 s post-roll: <= ~60 sessions/h

// The next file this hour may open, or the verdict why nothing may open.
// `busy` compares the WALL clock with the mtime, never the injected `now` (plano emenda E3): the
// injected clock is a simulated date; the mtime is always real.
async function nextSessionFile(dir, now, maxSessions = MAX_SESSIONS) {
  const hh = String(now.getHours()).padStart(2, '0');
  let names = [];
  try { names = await fs.readdir(dir); } catch { return { dest: path.join(dir, `${hh}.mp4`) }; }
  const sessions = [];
  for (const name of names) {
    const m = HOUR_NAME.exec(name);
    const n = m && m[1] === hh ? (m[2] === undefined ? 0 : Number(m[2])) : null;
    if (n !== null && n < PROMOTED_FROM) sessions.push({ name, n });
  }
  if (!sessions.length) return { dest: path.join(dir, `${hh}.mp4`) };
  sessions.sort((a, b) => a.n - b.n);
  const last = sessions[sessions.length - 1];
  const st = await statOrNull(path.join(dir, last.name));
  if (st && Date.now() / 1000 - st.mtimeMs / 1000 < BUSY_S) return { busy: true };
  if (sessions.length >= maxSessions) return { full: true };
  return { dest: path.join(dir, `${hh}-s${last.n + 1}.mp4`) };
}

function buildArgs({ source, dest }) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  // ponytail: `-rtsp_transport` is an INPUT option and a file demuxer rejects it; only valid for rtsp://.
  if (/^rtsp:/i.test(source)) args.push('-rtsp_transport', 'tcp');
  return args.concat([
    '-i', source,
    // ponytail: VIDEO ONLY (user decision, 2026-10-15). The mp4 does not carry G711/pcm_mulaw — the
    // audio production cameras deliver — and with `-map 0` ffmpeg failed before writing.
    '-map', '0:v:0',
    '-c', 'copy',
    '-f', 'mp4',
    '-movflags', '+faststart+empty_moov+default_base_moof+frag_keyframe',
    // ponytail: `-n` is DELIBERATE (spec 2026-10-18, amendment E7) — a session restarting WITHIN the
    // same hour must not truncate what is already recorded (with `-y` it lost up to 1 h of
    // recording). ffmpeg refuses and exits; the one detecting the case is `recordOnce`, BEFORE
    // spawning.
    '-n',
    dest,
  ]);
}

// ponytail: the ffmpeg message repeats the source URL — which carries the credential. Every output
// that becomes an ingest error (event + state.json) goes through here, otherwise the secret leaks
// into the state.
const maskSecret = (t) => String(t).replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***:***@');

// ponytail: execFile wrapped in a Promise — the `await` gives the event loop back to the server
// while ffmpeg runs. `signal` exists so the manager's stop() kills the in-flight ffmpeg instead of
// waiting for the timeout. NO synchronous fs/process call here (guard of test/recorder.test.js): the
// synchronous version froze the whole API when a recording was shut down (measured 2026-10-16).
function ffmpegPromise(args, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/ffmpeg', args, { timeout: timeoutMs, signal, stdio: ['ignore', 'pipe', 'pipe'] },
      (error) => (error ? reject(error) : resolve()));
  });
}

async function statOrNull(filePath) {
  try { return await fs.stat(filePath); } catch { return null; }
}

// The last line of the ffmpeg output, masked: it is the reason that becomes an ingest event and
// state.json.
function reason(error) {
  const output = error && (error.stderr || error.message);
  const raw = output ? String(output).split('\n').filter(Boolean).pop() : 'no ffmpeg output';
  return maskSecret(raw);
}

// The NORMAL end of a session is the TIMEOUT (hour switch) and the ABORT (stop) — both ARE the
// design (amendment E6). Measured: the execFile timeout arrives with `killed: true` and the abort
// with `AbortError`; an ffmpeg that dies from outside (SIGKILL, full disk, camera dropping midway)
// arrives with `code`/`signal`.
const sessionEnd = (e) => !!e && (e.name === 'AbortError' || e.killed === true);

// ONE ffmpeg session: records the current hour from `source` and returns its file.
async function recordOnce({ source, outDir, timeoutMs, signal, maxSessions, now = new Date() }) {
  const dir = dayDir(outDir, now);
  await fs.mkdir(dir, { recursive: true });
  // spec 2026-10-21 (4.2): the hour file existing is no longer a dead end — the next session of the
  // hour opens after it. E7 keeps its meaning in the new form: nothing that exists is ever rewritten
  // (`-n` and the `wx` sidecar stay as the last line of defense).
  const next = await nextSessionFile(dir, now, maxSessions);
  if (next.busy) throw new AppError('recording_hour_busy');
  if (next.full) throw new AppError('recording_hour_full');
  const dest = next.dest;
  // ponytail: NFS has no birthtime; without the real open instant the index stamps the hour at
  // HH:00 and the whole file plays minutes in the past (prod incident 2026-10-20). Sidecar rule
  // mirrors ffmpeg `-n`: a restart inside the same hour must NOT move the anchor, so the write is
  // "only if absent" — flag `wx` does it in one async call, EEXIST means already stamped.
  await fs.writeFile(dest + '.start', `${Math.floor(Date.now() / 1000)}\n`, { flag: 'wx' })
    .catch((e) => { if (e.code !== 'EEXIST') throw e; });
  const args = buildArgs({ source, dest });
  let ffmpegError = null;
  try {
    await ffmpegPromise(args, { timeoutMs, signal });
  } catch (e) {
    ffmpegError = e;
  }
  // SUCCESS is the INDEX, never the size: a session that opens the output and dies BEFORE the first
  // keyframe leaves only the init (`ftyp`/`moov`, measured: 28 B) — and such a file, left on disk,
  // makes the pre-check above block EVERY retry of that hour (up to ~58 min lost to a transient
  // flap) while ingest announces `online`. With no complete fragment: delete the file (only the
  // init, no real recording) and return an error.
  // ponytail: `indexFile` is synchronous and runs ONCE per session, reading only box headers —
  // measured in the worst case (1 h, 3600 fragments, 158 MB): 41 ms. The `mdat` is never read.
  const st = await statOrNull(dest);
  const frags = st && st.size > 0 ? (indexFile(dest) || { frags: [] }).frags : [];
  if (!frags.length) {
    if (st) await fs.rm(dest, { force: true });
    throw new AppError('recording_empty', { reason: reason(ffmpegError) });
  }
  // With a fragment on disk the disk is what counts — but an ffmpeg dying MIDWAY (camera drop, full
  // disk) after recording is not success: propagate it, otherwise `IngestManager` announces a lying
  // `online` and there is no useful retry. What became a fragment STAYS on disk.
  if (ffmpegError && !sessionEnd(ffmpegError)) {
    throw new AppError('recording_interrupted', { reason: reason(ffmpegError) });
  }
  return { outDir, dir, file: dest, bytes: st.size };
}

module.exports = { buildArgs, recordOnce, dayDir, hourFile, nextSessionFile, MAX_SESSIONS, MAX_SESSIONS_MOTION };

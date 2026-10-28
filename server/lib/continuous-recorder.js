'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { dayDir, nextSessionFile, MAX_SESSIONS } = require('./recorder');
const { indexFile, HOUR_NAME } = require('./fmp4index');
const { AppError } = require('./errors');

// onSegment({kind: 'opened'|'closed', outDir, dir, file, bytes, epoch}) may be async.
// 'opened' means a complete fragment is readable, not just an init. 'closed' includes
// the final tail (including yesterday at midnight). Callbacks are awaited in order.
// timeoutMs is accepted for recordOnce compatibility, but never limits this process.
async function recordContinuous({ source, outDir, signal, maxSessions = MAX_SESSIONS,
  now = new Date(), segmentSeconds = 3600, onSegment }) {
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0 ||
      !Number.isInteger(maxSessions) || maxSessions < 1 || !Number.isFinite(+now)) {
    throw new TypeError('Invalid continuous recorder options');
  }
  if (signal?.aborted) throw new AppError('recording_empty', { reason: 'Capture cancelled' });
  const started = Date.now();
  const initialDir = dayDir(outDir, now);
  await fs.mkdir(initialDir, { recursive: true });
  const next = await nextSessionFile(initialDir, now, maxSessions);
  if (next.busy) throw new AppError('recording_hour_busy');
  if (next.full) throw new AppError('recording_hour_full');
  // ponytail: placing mkdtemp under the archive makes link() same-filesystem by construction.
  const staging = await fs.mkdtemp(path.join(outDir, '.continuous-'));
  const args = ['-hide_banner', '-loglevel', 'info', '-nostdin'];
  if (/^rtsp:/i.test(source)) args.push('-rtsp_transport', 'tcp');
  args.push('-i', source, '-map', '0:v:0', '-c', 'copy', '-an', '-f', 'segment',
    '-segment_time', String(segmentSeconds), '-segment_atclocktime', '1',
    '-reset_timestamps', '1', '-segment_format', 'mp4',
    '-segment_format_options', 'movflags=+empty_moov+default_base_moof+frag_keyframe:flush_packets=1',
    path.join(staging, 'segment-%09d.mp4'));
  const entries = [];
  const owned = new Set();
  let active, last, failure, queue = Promise.resolve(), buffer = '', killTimer, closed = false;
  let child;
  const stop = () => {
    if (closed || !child) return;
    child.kill('SIGTERM');
    if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  };
  const fail = e => {
    // Never retain FFmpeg diagnostics, source URLs, spawn arguments or callback errors:
    // all may contain credentials (including query tokens and non-RTSP sources).
    failure ||= e instanceof AppError && ['recording_hour_busy', 'recording_hour_full'].includes(e.code)
      ? e : new AppError('recording_interrupted', { reason: 'Continuous capture publication failed' });
    stop();
  };
  const enqueue = fn => { queue = queue.then(fn).catch(fail); };
  const progress = async (entry, kind) => {
    if (!entry?.file || (kind === 'opened' && entry.opened)) return;
    const indexed = indexFile(entry.file);
    if (!indexed?.frags.length) return;
    const event = { outDir, dir: path.dirname(entry.file), file: entry.file,
      bytes: (await fs.stat(entry.file)).size, epoch: entry.epoch };
    if (!entry.opened) {
      entry.opened = true;
      await onSegment?.({ ...event, kind: 'opened' });
    }
    if (kind === 'closed' && !entry.closed) {
      entry.closed = true;
      await onSegment?.({ ...event, kind });
    }
    last = event;
  };
  async function publish(entry) {
    const date = new Date(+now + entry.instant - started);
    const dir = dayDir(outDir, date), hh = String(date.getHours()).padStart(2, '0');
    await fs.mkdir(dir, { recursive: true });
    for (;;) {
      const verdict = await nextSessionFile(dir, date, maxSessions);
      // Our previous segment is naturally recent; it must not block this same writer.
      const names = await fs.readdir(dir);
      const sessions = new Map();
      for (const name of names) {
        const media = name.endsWith('.start') ? name.slice(0, -6) : name;
        const m = HOUR_NAME.exec(media);
        const n = m && m[1] === hh ? Number(m[2] || 0) : -1;
        if (n >= 0 && n < 1000) sessions.set(n, path.join(dir, media));
      }
      const highest = sessions.size ? Math.max(...sessions.keys()) : -1;
      if (verdict.busy && !owned.has(sessions.get(highest))) throw new AppError('recording_hour_busy');
      if (sessions.size >= maxSessions || highest >= 999) throw new AppError('recording_hour_full');
      const n = highest + 1;
      const file = path.join(dir, `${hh}${n ? `-s${n}` : ''}.mp4`);
      try { await fs.writeFile(file + '.start', `${entry.epoch}\n`, { flag: 'wx' }); }
      catch (e) { if (e.code === 'EEXIST') continue; throw e; }
      // A separate immutable record per attempted destination survives even a link failure.
      await fs.writeFile(`${entry.stage}.${n}.json`, JSON.stringify({ file, epoch: entry.epoch }), { flag: 'wx' });
      try { await fs.link(entry.stage, file); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // ponytail: our exclusive reservation must not anchor another writer's media.
        await fs.unlink(file + '.start');
        continue;
      }
      entry.file = file; owned.add(file);
      await fs.writeFile(entry.stage + '.json', JSON.stringify({ file, epoch: entry.epoch }), { flag: 'wx' });
      return;
    }
  }
  async function opened(entry) {
    entries.push(entry);
    // The actual observed open epoch is durable before ANY public exposure.
    await fs.writeFile(entry.stage + '.start', `${entry.epoch}\n`, { flag: 'wx' });
    await fs.writeFile(entry.stage + '.date', new Date(+now + entry.instant - started).toISOString(), { flag: 'wx' });
    await progress(active, 'closed');
    active = entry;
    if (failure) return; // still keep the recovery anchor for events queued before a failure
    // FFmpeg announces opening just before its open syscall; yield if the file is not there yet.
    for (let i = 0; ; i++) {
      try { await fs.stat(entry.stage); break; }
      catch (e) {
        if (e.code !== 'ENOENT' || i >= 100) throw e;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    await publish(entry);
    await progress(entry, 'opened');
  }
  let lastSequence = -1;
  function line(text) {
    const match = /Opening '([^']+)' for writing/.exec(text);
    if (!match || path.dirname(match[1]) !== staging) return;
    const number = /^segment-(\d{9})\.mp4$/.exec(path.basename(match[1]));
    if (!number || Number(number[1]) <= lastSequence) return;
    lastSequence = Number(number[1]);
    const instant = Date.now();
    const entry = { stage: match[1], instant, epoch: Math.floor(instant / 1000) };
    enqueue(() => opened(entry));
  }
  try { child = spawn('/usr/bin/ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch {
    await fs.rmdir(staging).catch(() => {});
    throw new AppError('recording_empty', { reason: 'FFmpeg could not start' });
  }
  child.stderr.on('data', chunk => {
    // Bound retained process output; never forward it to logs or errors.
    const lines = (buffer + chunk.toString()).split('\n');
    buffer = lines.pop().slice(-8192);
    for (const text of lines) line(text.slice(-8192));
  });
  const exit = new Promise(resolve => {
    child.once('error', () => { failure ||= new AppError('recording_empty', { reason: 'FFmpeg could not start' }); });
    child.once('close', (code, sig) => { closed = true; line(buffer); resolve({ code, sig }); });
  });
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  let polling = false;
  const timer = setInterval(() => {
    if (polling || failure) return;
    polling = true;
    enqueue(async () => { try { await progress(active, 'opened'); } finally { polling = false; } });
  }, 200);
  let outcome;
  try {
    outcome = await exit;
    clearInterval(timer);
    await queue;
    try { await progress(active, 'closed'); } catch (e) { fail(e); }
  } finally {
    clearInterval(timer); clearTimeout(killTimer);
    signal?.removeEventListener('abort', stop);
  }
  if (!signal?.aborted && (outcome.code !== 0 || outcome.sig)) {
    failure ||= new AppError(last ? 'recording_interrupted' : 'recording_empty', { reason: 'FFmpeg exited unexpectedly' });
  }
  for (const entry of entries) {
    // An init-only public link must not look online or prevent a retry. Keep nonempty
    // staging data for recovery; remove only empty media or redundant staging links.
    const valid = entry.file && indexFile(entry.file)?.frags.length;
    if (entry.file && !valid) {
      await fs.rm(entry.file, { force: true });
      await fs.rm(entry.file + '.start', { force: true });
    }
    const st = await fs.stat(entry.stage).catch(() => null);
    if (!st || st.size === 0 || (!failure && valid)) {
      if (st) await fs.unlink(entry.stage);
      for (const name of await fs.readdir(staging)) {
        if (name.startsWith(path.basename(entry.stage) + '.')) await fs.unlink(path.join(staging, name));
      }
    }
  }
  // rmdir deliberately refuses to delete any orphan not accounted for above.
  await fs.rmdir(staging).catch(() => {});
  if (failure) throw failure;
  if (!last) throw new AppError('recording_empty', { reason: 'No complete fragments' });
  return last;
}

module.exports = { recordContinuous };

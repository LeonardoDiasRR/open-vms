'use strict';
const { execFile: nativeExecFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { indexFile } = require('./fmp4index');
const { planChunks, transcodeCommand } = require('./transcode-plano');
const { AppError } = require('./errors');

// Per-session transcoding engine (spec 2026-10-19, 5.1-5.6 + per-profile queue of 2026-10-19):
// schedules 60 s chunks (the pure plan lives in transcode-plano.js), runs ffmpeg with one lane (its
// own queue) per profile in round-robin under the global `maxFfmpeg` ceiling, serves ready / waiting
// chunks and keeps the LRU cache by atime. No state leaks between sessions: a session = (profile,
// window) and it releases the ceiling when the last chunk of the window finishes (ready OR error).

const CANDIDATES = ['h264_nvenc', 'h264_qsv', 'h264_vaapi', 'libx264'];

// The ffmpeg output goes to log/ingest error: mask any credential first (same rule as the recorder —
// here the cache path shows up, not the source URL, but the cost is zero).
const mask = (t) => String(t).replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***:***@');
function reason(error) {
  const output = error && (error.stderr || error.message);
  return mask(output ? String(output).split('\n').filter(Boolean).pop() : 'no ffmpeg output');
}
const statOrNull = async (p) => { try { return await fs.stat(p); } catch { return null; } };

function createTranscoder({ cacheRoot: cacheRoot, execFile = nativeExecFile, ffprobeBin = '/usr/bin/ffprobe',
  ffmpegBin = '/usr/bin/ffmpeg', maxSessions: maxSessions, maxFfmpeg, cacheMaxBytes = 2 * 1024 ** 3,
  waitMs: waitMs = 30000, fixedEncoder: fixedEncoder, signal, cpus = os.cpus().length,
  chunkSeconds = 60, maxQueued = 256 } = {}) {

  // execFile wrapped in a Promise with the AbortController `signal` (recorder.js pattern): kills the
  // in-flight ffmpeg on shutdown instead of waiting for the process to end by itself.
  const run = (bin, args, jobSignal = signal) => new Promise((res, rej) => execFile(bin, args,
    { signal: jobSignal, timeout: 60000, maxBuffer: 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] }, (e, stdout) => (e ? rej(e) : res(stdout || ''))));

  // ---- 5.1 source codec (ffprobe cached: the hour file is immutable) --------------------------
  const codecs = new Map();
  async function codecOfSource(filePath) {
    const stat = await statOrNull(filePath);
    if (!stat) throw new AppError('source_missing', { path: filePath });
    const key = `${filePath}|${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    if (codecs.has(key)) return codecs.get(key);
    const output = await run(ffprobeBin, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,r_frame_rate,avg_frame_rate', '-of', 'json', filePath]);
    let st;
    try { st = JSON.parse(output).streams[0]; } catch { throw new AppError('probe_json_invalid', { path: filePath }); }
    const [num, den] = String(st.r_frame_rate || st.avg_frame_rate || '').split('/').map(Number);
    const info = { name: st.codec_name, fps: num > 0 && den > 0 ? num / den : null };
    codecs.set(key, info);
    while (codecs.size > 256) codecs.delete(codecs.keys().next().value);
    return info;
  }

  // ---- 5.6 encoder: one real probe; fixedEncoder (env) skips everything ------------------------
  const logs = [];
  // Envs from spec 5.4/5.6: explicit option > env > default. Defensive parse: an invalid integer
  // (not an integer or <= 0) falls back to the default with a WARN in `logs` — a typo in the env
  // cannot bring the server down nor release the ceiling by accident. A non-empty ENCODER skips the
  // probe, like fixedEncoder.
  const intEnv = (name, option, fallback) => {
    if (option !== undefined) return option;
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) return n;
    logs.push(`WARN transcoder: ${name}="${v}" is invalid; using the default ${fallback}`);
    return fallback;
  };
  maxSessions = intEnv('OPENVMS_TRANSCODE_MAX_SESSIONS', maxSessions, 4);      // D3 (spec 2026-10-19)
  maxFfmpeg = intEnv('OPENVMS_TRANSCODE_MAX_FFMPEG', maxFfmpeg, Math.min(4, cpus));
  if (fixedEncoder === undefined && process.env.OPENVMS_TRANSCODE_ENCODER) {
    fixedEncoder = process.env.OPENVMS_TRANSCODE_ENCODER;
  }
  let chosen = fixedEncoder ? { encoder: fixedEncoder, logs } : null;
  let probing = null;
  // spec 2026-10-27 (on-demand GPU decode): try CUDA, fall back to CPU per chunk, and do not retry
  // CUDA for CUDA_COOLDOWN_MS after a failed CUDA attempt (a box without a driver must not pay a
  // failed init on every 60 s chunk). The cooldown expiring re-tries it: a temporary outage recovers.
  const CUDA_COOLDOWN_MS = 10 * 60 * 1000;
  let cudaNextTryAt = 0;
  // spec 2026-10-27 (full surface): stage 0 keeps frames on the GPU (nvdec -> nvenc). Its own
  // circuit: a surface failure must NOT demote stage 1 (hwaccel decode), which is proven working.
  let surfaceNextTryAt = 0;
  async function chooseEncoder() {
    if (chosen) return chosen;
    if (probing) return probing;
    probing = (async () => {
    // 2 testsrc frames per candidate: the first rc 0 wins (the GPU answers or the codec does not exist).
    const probe = (enc) => {
      const args = transcodeCommand({ encoder: enc, source: 'testsrc=size=128x72:rate=30:duration=1',
        sourceAnchor: 0, ini: 0, fim: 1, fps: 30, dest: '-', threads: 1 });
      const input = args.indexOf('-i'); args.splice(input, 0, '-f', 'lavfi');
      args.splice(args.indexOf('-f', args.indexOf('-an')), 2, '-f', 'null');
      return run(ffmpegBin, args);
    };
    for (const enc of CANDIDATES) {
      try { await probe(enc); logs.push(`transcoder: encoder=${enc}`); chosen = { encoder: enc, logs }; return chosen; }
      catch { /* candidate without a GPU: the next one in order */ }
    }
    logs.push('WARN transcoder: no test encoder passed; falling back to libx264 (CPU)');
    chosen = { encoder: 'libx264', logs };
    return chosen;
    })();
    try { return await probing; } finally { probing = null; }
  }

  // ---- 5.5 cache: <cacheRoot>/<profile>/<hour-YYYY-MM-DD-HH>/<ini>.fmp4 ------------------------
  // Single CHOKEPOINT for paths in this module: chunkPath is the ONLY path builder (every call —
  // ensureWindow, awaitChunk, chunkInfo, LRU — goes through it), so the profile/ini validation
  // lives only here. Without it, path.join collapses '../' and the profile escapes cacheRoot (path
  // traversal). A dirty ini ('60/../../x') also became a file name.
  const PROFILE_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const pins = new Map();
  function chunkPath(profile, ini) {
    if (!PROFILE_OK.test(profile)) throw new AppError('stream_profile_invalid');
    if (/^[a-f0-9]{64}$/.test(String(ini))) return path.join(cacheRoot, profile, 'v2', `${ini}.fmp4`);
    ini = Number(ini);
    if (!Number.isInteger(ini) || ini < 0 || ini % 60 !== 0) throw new AppError('ini_invalid');
    const d = new Date(ini * 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    return path.join(cacheRoot, profile,
      `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}`, `${ini}.fmp4`);
  }
  const beingCreated = new Set();       // live .part paths: the LRU never touches them
  async function pruneLru() {
    const walk = async (dir, out) => {
      let names;
      try { names = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        const p = path.join(dir, n.name);
        if (n.isDirectory()) await walk(p, out);
        else if (n.name.endsWith('.fmp4')) out.push(p);          // .part does not exist by definition
      }
    };
    const files = [];
    await walk(cacheRoot, files);
    const info = [];
    let total = 0;
    for (const p of files) {
      const st = await fs.stat(p);
      total += st.size;                                          // what is being born counts against the ceiling
      if (!beingCreated.has(p) && !pins.has(p)) info.push({ p, atime: st.atimeMs, size: st.size });
    }
    if (total <= cacheMaxBytes) return;
    info.sort((a, b) => a.atime - b.atime);                      // LRU by atime (spec 5.5)
    for (const f of info) {
      if (total <= cacheMaxBytes) return;
      await fs.rm(f.p, { force: true });
      total -= f.size;
    }
  }

  // ---- 5.4 per-profile queue + sessions (D1, spec 2026-10-19) ---------------------------------
  const chunks = new Map();   // `${profile}/${ini}` -> { state, prom, res, rej, ... }
  const sessions = new Map(); // `${profile}|${de}|${ate}` -> Set of live keys
  const lanes = new Map();    // profile -> { queue: [], queued: Set } (single lane: 1 ffmpeg per profile)
  const running = new Set();  // profiles with a live ffmpeg; the global ceiling is still maxFfmpeg
  const clients = new Map();
  let admission = Promise.resolve();
  let rr = null;              // round-robin cursor: last profile served
  const chunkKey = (profile, ini) => `${profile}/${ini}`;

  function enqueue(profile, k) {
    let lane = lanes.get(profile);
    if (!lane) { lane = { queue: [], queued: new Set() }; lanes.set(profile, lane); }  // the lane is born on the 1st enqueue
    if (lane.queued.has(k)) return;                 // duplicate dropped by the lane's own `queued`
    lane.queued.add(k);
    lane.queue.push(k);
  }

  function pruneLane(profile) {                     // dead lane: empty queue and idle profile (no leak)
    const lane = lanes.get(profile);
    if (lane && !lane.queue.length && !running.has(profile)) lanes.delete(profile);
  }

  function nextLane() {                             // round-robin: sweeps starting at the lane after `rr`
    const profiles = [...lanes.keys()];
    let i = profiles.indexOf(rr);                   // pruned rr -> indexOf -1 -> restart from the beginning
    for (let n = 0; n < profiles.length; n += 1) {
      i = (i + 1) % profiles.length;
      const profile = profiles[i];
      if (!running.has(profile) && lanes.get(profile).queue.length) return profile;
    }
    return null;
  }

  function pump() {
    while (running.size < maxFfmpeg) {
      const profile = nextLane();
      if (!profile) break;
      rr = profile;
      const lane = lanes.get(profile);
      let e = null;
      while (lane.queue.length) {
        const k = lane.queue.shift();
        lane.queued.delete(k);                      // left the queue: a retry (awaitChunk) may re-enqueue
        const cand = chunks.get(k);
        if (cand && cand.state === 'pending') { e = cand; break; }
      }
      if (!e) { pruneLane(profile); continue; }      // the lane queue only had dead keys
      running.add(profile);
      // D2: threads at launch time, with the profile itself already in `running`
      // (1 lane alone: cpus; 3 lanes: cpus/3). An in-flight ffmpeg does not resize (spec 9).
      const threads = Math.max(1, Math.floor(cpus / maxFfmpeg) - 1);
      execute(e, threads).finally(() => {
        running.delete(profile);
        pruneLane(profile);
        pump();
      });
    }
  }

  // ONE chunk execution: ffmpeg writes <dest>.part and the rename publishes it (atomic write — a
  // half chunk is NEVER served). rc != 0 deletes the .part and marks the chunk for a redo.
  async function execute(e, threads) {
    const part = `${e.path}.part`;
    try {
      await fs.mkdir(path.dirname(e.path), { recursive: true });
      beingCreated.add(e.path);
      const { encoder } = await chooseEncoder();
      const { fps } = await codecOfSource(e.source.filePath);
      const cmd = { encoder, source: e.source.filePath, sourceAnchor: e.source.anchor,
        ini: e.ini, fim: e.fim, fps: e.outputFps || fps, dest: part, filters: e.filters || [], decoderThreads: 1 };
      if (encoder === 'libx264') cmd.threads = threads;   // D2: -threads only makes sense for libx264
      // spec 2026-10-27: stage ladder surface(0) -> hwaccel(1) -> CPU(2). Stage 0 requires the
      // nvenc encoder and NO software filters; each GPU stage owns its cooldown circuit; an abort
      // surfaces as before and opens no circuit.
      const gpuEncoder = encoder === 'h264_nvenc';
      const stage0 = gpuEncoder && !(e.filters || []).length && Date.now() >= surfaceNextTryAt;
      // stage 1 depends only on its own circuit (nvdec works whatever the encoder is): today's rule.
      const stages = [...(stage0 ? ['surface'] : []), ...(Date.now() >= cudaNextTryAt ? ['hwaccel', 'cpu'] : ['cpu'])];
      for (let i = 0; i < stages.length; i += 1) {
        const st = stages[i];
        const last = i === stages.length - 1;
        try {
          await run(ffmpegBin, transcodeCommand({ ...cmd,
            hwDecode: st !== 'cpu', hwSurface: st === 'surface' }), e.ctl?.signal || signal);
          break;
        } catch (err) {
          // An abort (shutdown/seek cancellation) is not a GPU failure: the CPU retry would spawn on
          // an already-dead signal. Surface as before and open no circuit.
          if ((e.ctl?.signal || signal)?.aborted || last) throw err;
          if (st === 'surface') {
            surfaceNextTryAt = Date.now() + CUDA_COOLDOWN_MS;
            console.warn(`transcoder: GPU surface failed (${err.message}); chunk retried at lower stage`);
          } else {
            cudaNextTryAt = Date.now() + CUDA_COOLDOWN_MS;
            console.warn(`transcoder: CUDA decode failed (${err.message}); chunk retried on CPU`);
          }
        }
      }
      if (e.ctl?.signal.aborted) throw new Error('cancelled');
      await fs.rename(part, e.path);
      const st = await fs.stat(e.path);
      e.state = 'ready';
      // The LRU sweep runs BEFORE releasing the waiters (and never touches the newly born chunk,
      // still in `beingCreated`): the next request only sees a cache already under the ceiling.
      // The cache is disposable by definition: a prune error cannot turn a ready chunk into a 502.
      try { await pruneLru(); } catch { /* best-effort prune */ }
      e.res({ filePath: e.path, bytes: st.size });
    } catch (error) {
      await fs.rm(part, { force: true });
      e.state = 'error';
      e.rej(new AppError('transcode_fragments_missing', { ini: e.ini, reason: reason(error) }));
    } finally {
      beingCreated.delete(e.path);
      e.ctl?.abort();
      releaseSessions(e);
      for (const [k, item] of chunks) {
        if (chunks.size <= 512) break;
        if (item.state !== 'pending') chunks.delete(k);
      }
    }
  }

  function releaseSessions(e) {
    const k = chunkKey(e.profile, e.id || e.ini);
    for (const [id, live] of sessions) {
      if (!live.has(k)) continue;
      live.delete(k);
      if (!live.size) sessions.delete(id);                       // whole window terminal: released the ceiling
    }
  }

  async function ensureWindow({ profile: profile, ts, janela: window, sources: sources, representation = 'h264', filters = [], outputFps, client }) {
    const before = admission;
    let unlock;
    admission = new Promise(resolve => { unlock = resolve; });
    await before;
    try {
    const { encoder } = await chooseEncoder();
    const plan = planChunks({ ...window, sources, seconds: chunkSeconds,
      representation: JSON.stringify({ representation, encoder, filters, outputFps }) });
    if (!plan.length) throw new AppError('window_without_chunks', { from: window.de, to: window.ate });
    const byFile = new Map(sources.map((f) => [f.arquivoHora, f]));
    for (const c of plan) {
      if (!byFile.get(c.arquivoHora)) throw new AppError('hour_source_missing', { file: c.arquivoHora });
    }
    const id = client ? `${profile}|${client}` : `${profile}|${window.de}|${window.ate}`;
    const keys = new Set(plan.map(c => chunkKey(profile, c.id || c.ini)));
    for (const [oldId, entry] of clients) {
      if (Date.now() - entry.touched < 60000) continue;
      for (const key of entry.keys) {
        const e = chunks.get(key); e?.owners?.delete(oldId);
        if (e?.state === 'pending' && e.owners && !e.owners.size) {
          e.state = 'cancelled'; e.ctl?.abort(); e.rej(new AppError('chunk_not_scheduled', { ini: e.ini, profile: e.profile }));
          releaseSessions(e);
        }
      }
      clients.delete(oldId);
    }
    if (client) {
      const previous = clients.get(id);
      for (const k of previous?.keys || []) {
        if (keys.has(k)) continue;
        const e = chunks.get(k); e?.owners?.delete(id);
        if (e?.state === 'pending' && e.owners && !e.owners.size) {
          e.state = 'cancelled'; e.ctl?.abort(); e.rej(new AppError('chunk_not_scheduled', { ini: e.ini, profile }));
          releaseSessions(e);
        }
      }
      clients.set(id, { keys, touched: Date.now() });
    }
    if (!sessions.has(id) && sessions.size >= maxSessions) {
      throw new AppError('transcode_ceiling_reached', { max: maxSessions });
    }
    const cached = new Set();
    for (const c of plan) if (await statOrNull(chunkPath(profile, c.id || c.ini))) cached.add(chunkKey(profile, c.id || c.ini));
    const pendingNow = [...chunks.values()].filter(e => e.state === 'pending').length;
    const needed = plan.filter(c => {
      const key = chunkKey(profile, c.id || c.ini), state = chunks.get(key)?.state;
      return !cached.has(key) && state !== 'pending' && state !== 'ready';
    }).length;
    if (pendingNow + needed > maxQueued) throw new AppError('transcode_ceiling_reached', { max: maxQueued });
    // a seek does not wait for the start: the chunk containing ts enters the queue first, the rest in order.
    const iTs = plan.findIndex((c) => c.ini <= Number(ts) && Number(ts) < c.fim);
    const order = iTs >= 0 ? [plan[iTs], ...plan.filter((_, i) => i !== iTs)] : plan;
    const live = new Set();
    let pending = 0;
    for (const c of order) {
      const address = c.id || c.ini, k = chunkKey(profile, address);
      const e = chunks.get(k);
      if (e && !['error', 'cancelled'].includes(e.state)) {
        if (client) e.owners?.add(id);
        if (e.state === 'pending') { pending += 1; live.add(k); } continue;
      }
      if (!e && cached.has(k)) continue;
      // Double-spawn race: between the chunks.get() above and this stat await, a concurrent
      // overlapping window may have created/queued the SAME chunk. Re-read the map before creating:
      // without this a second ffmpeg would be born for the same ini (the `e` above is stale exactly
      // because of the await).
      const e2 = chunks.get(k);
      if (e2 && !['error', 'cancelled'].includes(e2.state)) {
        if (client) e2.owners?.add(id);
        if (e2.state === 'pending') { pending += 1; live.add(k); } continue;
      }
      if ([...chunks.values()].filter(e => e.state === 'pending').length >= maxQueued) {
        throw new AppError('transcode_ceiling_reached', { max: maxQueued });
      }
      const fresh = { profile: profile, id: c.id, ini: c.ini, fim: c.fim, source: c.source || byFile.get(c.arquivoHora), filters, outputFps,
        path: chunkPath(profile, address), state: 'pending', ctl: new AbortController(), owners: new Set(client ? [id] : []) };
      if (signal) {
        if (signal.aborted) fresh.ctl.abort();
        else signal.addEventListener('abort', () => fresh.ctl.abort(), { once: true, signal: fresh.ctl.signal });
      }
      fresh.prom = new Promise((res, rej) => { fresh.res = res; fresh.rej = rej; });
      fresh.prom.catch(() => {});                                // nobody needs to be waiting
      chunks.set(k, fresh);
      enqueue(profile, k);
      pending += 1;
      live.add(k);
    }
    // B2: a window 100% cached has an empty `live` and NEVER goes through releaseSessions (nothing is
    // born, nothing dies): registering it would be an eternal ghost eating the session ceiling -> a
    // false 429 with zero ffmpeg. Before registering, drop whoever terminated during the loop awaits
    // (their releaseSessions already went through here without seeing us). Minimal option: only
    // register whoever still has a live chunk; the real 429 remains: a hot window holds the slot
    // until it terminates.
    for (const k of live) {
      const e = chunks.get(k);
      if (!e || e.state !== 'pending') live.delete(k);
    }
    if (live.size) sessions.set(id, live);
    pump();
    return { activeSessions: sessions.size, pendentes: pending, ...(plan.some(c => c.id) ? { plan } : {}) };
    } finally { unlock(); }
  }

  async function awaitChunk({ profile: profile, ini, pin = false }) {
    if (!/^[a-f0-9]{64}$/.test(String(ini))) ini = Number(ini);
    const filePath = chunkPath(profile, ini);
    const st = await statOrNull(filePath);
    const protect = (out) => {
      if (!pin) return out;
      pins.set(filePath, (pins.get(filePath) || 0) + 1);
      let released = false;
      return { ...out, release: () => {
        if (released) return; released = true;
        const n = (pins.get(filePath) || 1) - 1;
        if (n) pins.set(filePath, n); else pins.delete(filePath);
        void pruneLru().catch(() => {});
      } };
    };
    if (st) return protect({ filePath, bytes: st.size });
    const e = chunks.get(chunkKey(profile, ini));
    if (!e) throw new AppError('chunk_not_scheduled', { ini, profile });
    if (e.state === 'error' || e.state === 'ready') {            // error (or eviction) => a new request redoes it
      e.ctl = new AbortController();
      if (signal?.aborted) e.ctl.abort();
      else signal?.addEventListener('abort', () => e.ctl.abort(), { once: true, signal: e.ctl.signal });
      e.state = 'pending';
      e.prom = new Promise((res, rej) => { e.res = res; e.rej = rej; });
      e.prom.catch(() => {});
      enqueue(profile, chunkKey(profile, ini));                   // retry: the key left the lane queue in pump()
      pump();
    }
    let timer;                                                   // long-poll with a ceiling -> 503 (spec 5.4)
    try {
      return protect(await Promise.race([e.prom, new Promise((_, rej) => {
        timer = setTimeout(() => rej(new AppError('transcode_chunk_timeout', { ini, profile, ms: waitMs })), waitMs);
      })]));
    } finally { clearTimeout(timer); }
  }

  // Parse of the created chunk with the SAME parser as the player (fmp4index): initFim + frags with
  // byte ranges (byteStart/size). null = chunk not born yet (the playlist postpones).
  function chunkInfo(profile, ini) {
    try { return indexFile(chunkPath(profile, ini)) || null; } catch { return null; }
  }

  return { codecOfSource, chooseEncoder, ensureWindow, awaitChunk, chunkInfo, chunkPath, chunkSeconds,
    stats: () => ({ active: running.size, sessions: sessions.size, clients: clients.size,
      queued: [...lanes.values()].reduce((n, lane) => n + lane.queue.length, 0), pins: pins.size }) };
}

module.exports = { createTranscoder };


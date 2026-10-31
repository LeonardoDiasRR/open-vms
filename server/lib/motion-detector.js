'use strict';
const cp = require('node:child_process');
// Regression 2026-10-27: the old default was child_process.spawn itself, which takes (file, args) —
// calling it with just the args array threw ERR_INVALID_ARG_TYPE and NO camera ever armed in motion
// in production. Tests inject their own spawn (single-array contract); the real default must wrap
// the binary. Read cp.spawn at CALL time so tests can mock the module without injection.
const defaultSpawn = (args) => cp.spawn('/usr/bin/ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
const { analyse, MotionLatch, FRAME_BYTES } = require('./motion-kernel');

// Spec 2026-10-23 (§6.2): one instance per armed camera. Decodes the Hub secondary stream at 2 fps
// and hands the frames to the kernel. No exception escapes: an ffmpeg crash becomes backoff, as in ingest.
const DEFAULT_FPS = 2;

function buildArgs({ source, fps = DEFAULT_FPS }) {
  const args = [];
  if (/^rtsp:/i.test(source)) args.push('-rtsp_transport', 'tcp');
  return args.concat(['-hide_banner', '-loglevel', 'error', '-i', source, '-an',
    '-vf', `fps=${fps},scale=320:180,format=gray`,
    '-f', 'rawvideo', '-']);
}

class MotionDetector {
  constructor({ spawn = defaultSpawn, onEvent = () => {}, restartMs = 2000, maxRestartMs = 60000,
                fps = DEFAULT_FPS, now = Date.now } = {}) {
    this.spawn = spawn; this.onEvent = onEvent; this.restartMs = restartMs;
    this.maxRestartMs = maxRestartMs; this.fps = fps; this.now = now;
    this.workers = new Map();
  }
  running(id) { return this.workers.has(id); }

  async start(id, { source, sensitivity = 5, onMotion, onIdle } = {}) {
    await this.stop(id);
    const w = { id, source, sensitivity, onMotion, onIdle, child: null, buf: Buffer.alloc(0),
      prev: null, backoff: this.restartMs, stopped: false, timer: null, latched: false };
    this.workers.set(id, w);
    this._spawn(w);
    return { id };
  }

  _latch(w) {
    // Spec §6.1: start with 2 consecutive frames above the threshold (1 s at 2 fps). The kernel default
    // is already 2. The injected `now` is what changes here.
    return new MotionLatch({ sensitivity: w.sensitivity, now: this.now });
  }

  _spawn(w) {
    if (w.stopped) return;
    const child = this.spawn(buildArgs({ source: w.source, fps: this.fps }));
    w.child = child;
    // ponytail: the latch is created with the process. The 3 s window does not cross a reconnection
    const latch = this._latch(w);
    w.latch = latch;
    w.buf = Buffer.alloc(0); w.prev = null;
    child.stdout.on('data', (d) => this._data(w, d));
    child.on('exit', () => this._exit(w, child));
    child.on('error', () => this._exit(w, child));
  }

  _data(w, chunk) {
    w.buf = w.buf.length ? Buffer.concat([w.buf, chunk]) : chunk;
    let off = 0;
    while (off + FRAME_BYTES <= w.buf.length) {
      const cur = w.buf.subarray(off, off + FRAME_BYTES);
      if (w.prev) {
        const r = analyse(w.prev, cur);
        if (!r) break;                       // unexpected size: discards the buffer, never misaligns
        const verdict = w.latch.push(r.score, this.now());
        if (verdict === 'start' && !w.latched) { w.latched = true; w.onMotion?.(); this.onEvent(w.id, 'motion'); }
        if (verdict === 'end' && w.latched) { w.latched = false; w.onIdle?.(); this.onEvent(w.id, 'idle'); }
      }
      w.prev = Buffer.from(cur);
      off += FRAME_BYTES;
    }
    w.buf = w.buf.subarray(off);
  }

  _exit(w, child) {
    if (w.stopped || w.child !== child) return;
    w.child = null;
    w.buf = Buffer.alloc(0); w.prev = null;
    w.backoff = Math.min(Math.max(w.backoff * 2, this.restartMs), this.maxRestartMs);
    w.timer = setTimeout(() => this._spawn(w), w.backoff);
  }

  async stop(id) {
    const w = this.workers.get(id);
    if (!w) return;
    w.stopped = true;
    if (w.timer) clearTimeout(w.timer);
    this.workers.delete(id);
    const child = w.child;
    if (child) {
      // Amendment E10: 1,5 s cap without holding the event loop after the process has already exited.
      const done = new Promise((r) => { const t = setTimeout(r, 1500); t.unref?.(); child.once?.('exit', r); });
      child.kill?.('SIGTERM');
      await done;
    }
  }

  async stopAll() { await Promise.all([...this.workers.keys()].map((id) => this.stop(id))); }
  stats() { return [...this.workers.keys()].map((id) => ({ id, running: this.running(id) })); }
}

module.exports = { MotionDetector, buildArgs, DEFAULT_FPS };

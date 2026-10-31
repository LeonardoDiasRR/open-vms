'use strict';
// ponytail: the recorder is ASYNCHRONOUS since 2026-10-15 — the execFileSync version blocked the
// event loop while ffmpeg ran, and the worker itself broke the Hub auth callback.
// 2026-10-18 (spec 5.1): the session now covers ONE clock HOUR. The timeout ends at the next full
// HOUR, so ffmpeg closes the hour file and the next session opens the new hour's
// (cost: one `minBackoffMs` reconnect per hour, declared in amendment E6).
// FLOOR (amendment E21): a session born in the last ms of the hour would have a ~1 ms timeout,
// ffmpeg would die before writing and `recordOnce` would throw "no segment recorded" — a spurious
// error with a doubled backoff. With the floor it records the start of the hour and exits through
// the file switch, like the others.
const TIMEOUT_FLOOR_MS = 1000;
function sessionTimeout(now = new Date()) {
  const nextHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);
  return Math.max(nextHour - now, TIMEOUT_FLOOR_MS);
}

class IngestManager {
  constructor({ recordOnce, continuous = false, events = () => {}, minBackoffMs = 2000, maxBackoffMs = 60000, now = () => new Date() }) {
    this.recordOnce = recordOnce;
    this.continuous = continuous;
    this.events = events;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.now = now; // test seam (like `recordOnce`/`events`): the timeout clock
    this.workers = new Map();
  }
  start(id, opts) {
    if (this.workers.has(id)) return;
    const w = { id, opts, backoff: this.minBackoffMs, stopped: false, timer: null, abort: new AbortController() };
    this.workers.set(id, w);
    w.timer = setTimeout(() => this.run(w), 0);
  }
  // ponytail: ASYNCHRONOUS — the recorder returns a Promise and the `await` gives the event loop back
  // to the server while ffmpeg runs (that was the measured defect: the worker held the API and the
  // Hub auth expired).
  async run(w) {
    if (w.stopped) return;
    try {
      // ponytail: ONE instant for the timeout and for the file name. With two independent
      // `new Date()` calls (this one and the one in `recordOnce`), a session born at the hour turn
      // asked for ~1 ms of recording on the NEW hour file and died before writing: the hour file
      // stayed empty, recordOnce threw "no segment recorded" and the backoff doubled for no reason
      // (E21).
      const now = this.now();
      const options = { timeoutMs: sessionTimeout(now), now, ...w.opts, signal: w.abort.signal };
      if (this.continuous) {
        // ponytail: the process owns rotation; keep the legacy timeout only for recordOnce.
        delete options.timeoutMs;
        options.onSegment = async (segment) => {
          if (w.stopped && segment.kind === 'opened') return;
          w.backoff = this.minBackoffMs;
          await this.events({ id: w.id, state: segment.kind === 'opened' ? 'online' : 'final',
            backoffMs: w.backoff, ...segment });
        };
      }
      const out = await this.recordOnce(options);
      // ponytail: stop() aborts ffmpeg, but the byte ranges already written stay on disk and the
      // index finds them by itself. The event carries the FILE: `final` does not announce a camera
      // online, `online` does. `bytes` is what the recorder measured on disk.
      if (w.stopped) { this.events({ id: w.id, state: 'final', file: out && out.file, bytes: out && out.bytes }); return; }
      this.events({ id: w.id, state: 'online', backoffMs: w.backoff, file: out && out.file, bytes: out && out.bytes });
      w.backoff = this.minBackoffMs;
    } catch (e) {
      if (w.stopped) return; // same: the stop() abort is not an ingest failure
      // spec 2026-10-21 (4.2): the session ceiling of the hour is PERMANENT. Retrying with backoff
      // would only flood the events until the turn (sessionTimeout is the INITIAL backoff, not a
      // cap). One error event, next attempt AT the turn of the hour.
      if (e && e.code === 'recording_hour_full') {
        w.backoff = Math.max(this.minBackoffMs, sessionTimeout(this.now()));
        this.events({ id: w.id, state: 'error', backoffMs: w.backoff, error: e.message });
        w.timer = setTimeout(() => this.run(w), w.backoff);
        return;
      }
      w.backoff = Math.min(Math.max(w.backoff * 2, this.minBackoffMs), this.maxBackoffMs);
      this.events({ id: w.id, state: 'error', backoffMs: w.backoff, error: e.message });
    }
    if (!w.stopped) w.timer = setTimeout(() => this.run(w), w.backoff);
  }
  // ponytail: same signature as LiveManager — with an id for one worker, without an id for all
  stop(id) {
    if (id === undefined) {
      for (const key of [...this.workers.keys()]) this.stop(key);
      return;
    }
    const w = this.workers.get(id);
    if (!w) return;
    w.stopped = true;
    if (w.timer) clearTimeout(w.timer);
    w.abort.abort(); // kills the in-flight ffmpeg: deleting a camera must stop its ffmpeg, without waiting for the timeout
    this.workers.delete(id);
  }
  liveCount() {
    return [...this.workers.values()].filter((w) => !w.stopped).length;
  }
  // spec 2026-10-16: the playback page uses this to know whether the profile's last file is still
  // being written (the open hour file has no `t1` in the index).
  isRecording(profileId) {
    const w = this.workers.get(profileId);
    return !!w && !w.stopped;
  }
}
module.exports = { IngestManager, sessionTimeout };

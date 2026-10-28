'use strict';
const { MotionDetector } = require('./motion-detector');
const { Preroll } = require('./preroll');

// Spec 2026-10-23 (§6.5): per camera, it turns the detector and the pre-recording on. On the event it
// promotes the buffer, opens the ingest session and turns the pre-roll off (two pulls of the same stream
// do not add up). It stops `postRollMs` after the last motion. A new motion before that cancels the stop (D6).
const POST_ROLL_MS = 60000;

class MotionRecording {
  constructor({ detector = new MotionDetector(), preroll = new Preroll(), ingest,
                diskLimited = () => false, postRollMs = POST_ROLL_MS,
                schedule = (fn, ms) => setTimeout(fn, ms), cancel = (h) => clearTimeout(h),
                log = () => {} } = {}) {
    this.detector = detector; this.preroll = preroll; this.ingest = ingest;
    this.diskLimited = diskLimited; this.postRollMs = postRollMs;
    this.schedule = schedule; this.cancel = cancel; this.log = log;
    this.cameras = new Map();
  }
  stateOf(id) { const c = this.cameras.get(id); return c ? c.state : 'off'; }

  async arm({ cameraId, profileId, detectSource, recordSource, outDir, base, sensitivity = 5 }) {
    if (this.diskLimited()) { this.log(`motion ${cameraId}: disk limit reached, not arming`); return { armed: false }; }
    await this.disarm(cameraId).catch(() => {});
    const c = { cameraId, profileId, recordSource, outDir, base, state: 'idle', stopHandle: null };
    this.cameras.set(cameraId, c);
    await this.preroll.start(cameraId, { source: recordSource }).catch((e) => this.log(`preroll ${cameraId}: ${e.message}`));
    await this.detector.start(cameraId, {
      source: detectSource, sensitivity,
      onMotion: () => this._onMotion(c),
      onIdle: () => this._onIdle(c),
    });
    return { armed: true };
  }

  async _onMotion(c) {
    if (c.state === 'recording') {
      if (c.stopHandle !== null) { this.cancel(c.stopHandle); c.stopHandle = null; }
      return;
    }
    c.state = 'recording';
    try {
      const promoted = await this.preroll.promote(c.cameraId, { base: c.base, profileId: c.profileId, seconds: 60 });
      if (!promoted.length) this.log(`motion ${c.cameraId}: no pre-recording available`);
    } catch (e) {
      // pre-recording is best-effort: the live session starts anyway
      this.log(`motion ${c.cameraId}: promotion failed (${e.message})`);
    }
    await this.preroll.stop(c.cameraId).catch(() => {});
    this.ingest.start(c.profileId, { source: c.recordSource, outDir: c.outDir, maxSessions: 90 });
  }

  _onIdle(c) {
    if (c.state !== 'recording' || c.stopHandle !== null) return;
    const handle = this.schedule(() => {
      // handle identity: a cancelled timer (motion came back) cannot stop the session
      if (c.stopHandle !== handle) return;
      c.stopHandle = null;
      if (c.state !== 'recording') return;
      c.state = 'idle';
      this.ingest.stop(c.profileId);
      this.preroll.start(c.cameraId, { source: c.recordSource })
        .catch((e) => this.log(`preroll ${c.cameraId}: ${e.message}`));
    }, this.postRollMs);
    c.stopHandle = handle;
  }

  async disarm(cameraId) {
    const c = this.cameras.get(cameraId);
    if (!c) return;
    if (c.stopHandle !== null && c.stopHandle !== undefined) { this.cancel(c.stopHandle); c.stopHandle = null; }
    this.cameras.delete(cameraId);
    await this.detector.stop(cameraId).catch(() => {});
    // ponytail: while recording, the pre-roll was already dropped when the session opened. One more stop
    // would duplicate the call and test 6 counts exactly one. While idle (armed or post-timer) it is up.
    if (c.state !== 'recording') await this.preroll.stop(cameraId).catch(() => {});
    this.ingest.stop(c.profileId);
  }

  async disarmAll() { await Promise.all([...this.cameras.keys()].map((id) => this.disarm(id))); }
  stats() { return [...this.cameras.values()].map((c) => ({ cameraId: c.cameraId, profileId: c.profileId, state: c.state })); }
}

module.exports = { MotionRecording, POST_ROLL_MS };

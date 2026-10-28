'use strict';
// Spec 2026-10-23 (§6.1): pure motion detection kernel. No I/O and no process — it receives two
// 320x180 gray frames and returns the fraction of changed cells. The 8x8 grid gives 40x22 = 880 cells,
// the same order of magnitude as the 42x32 grid of Nx.
const W = 320, H = 180, CELL = 8, PIXEL_DELTA = 12;
const FRAME_BYTES = W * H;
const CW = W / CELL, CH = (H / CELL) | 0;   // 40x22 = 880 cells. The 4 px at the bottom stay out
const CELLS = CW * CH;

// Measured in the spec §4.3: a static scene stays at 0,0023 and a scene with traffic starts at 0,075. The default
// threshold (5) cuts at 0,005 — 2x above the noise and 15x below the floor of real motion.
const THRESHOLDS = Object.freeze({
  1: 0.030, 2: 0.017, 3: 0.010, 4: 0.007, 5: 0.005,
  6: 0.0035, 7: 0.0025, 8: 0.0015, 9: 0.0010,
});

// A cell counts as changed when ANY of its pixels varied more than PIXEL_DELTA.
// Returns null for a missing or wrong-sized frame: the caller discards it and never misaligns.
function analyse(prev, cur) {
  if (!prev || !cur || prev.length !== FRAME_BYTES || cur.length !== FRAME_BYTES) return null;
  const cells = new Uint8Array(CELLS);
  for (let y = 0; y < CH * CELL; y++) {
    const cy = (y / CELL) | 0, row = y * W;
    for (let x = 0; x < W; x++) {
      if (Math.abs(cur[row + x] - prev[row + x]) > PIXEL_DELTA) cells[cy * CW + ((x / CELL) | 0)] = 1;
    }
  }
  let changed = 0;
  for (let i = 0; i < CELLS; i++) changed += cells[i];
  return { score: changed / CELLS, cells: changed };
}

// start on the transition after `onFrames` frames above the threshold. end after `offMs` with none
// (parity with Nx: 3 s). `now` exists so the test does not depend on the clock.
class MotionLatch {
  constructor({ sensitivity = 5, onFrames = 2, offMs = 3000, now = Date.now } = {}) {
    this.threshold = THRESHOLDS[sensitivity] ?? THRESHOLDS[5];
    this.onFrames = onFrames;
    this.offMs = offMs;
    this.now = now;
    this.active = false;
    this.hits = 0;
    this.lastHit = 0;
  }
  push(score, at = this.now()) {
    if (score >= this.threshold) {
      this.hits += 1;
      this.lastHit = at;
      if (!this.active && this.hits >= this.onFrames) { this.active = true; return 'start'; }
      return null;
    }
    this.hits = 0;
    if (this.active && at - this.lastHit >= this.offMs) { this.active = false; return 'end'; }
    return null;
  }
}

module.exports = { analyse, MotionLatch, THRESHOLDS, FRAME_BYTES, CELLS, W, H };

'use strict';

// F3 (spec §9): login rate limit per ACCOUNT and per ORIGIN with progressive delay and a generic
// response. In process (no persistence): a restart clears the delay, and so does what it protects
// (brute force). Whoever decides the keys is the dispatcher — here they are opaque.
const WINDOW_MS = 15 * 60e3;   // failures older than this drop out of the count
const FREE = 3;                // the first 4 attempts answer right away; the 5th is delayed
const BASE_DELAY_MS = 250;     // doubles on each failure from the 5th on
const MAX_DELAY_MS = 30e3;     // ceiling: ~2 attempts/min per hot key

// ponytail: injectable clock — the progress test stays deterministic without sleep
function createLoginLimiter({ now = Date.now } = {}) {
  const state = new Map();   // key -> { falhas: [ts] }

  function live(key) {
    const e = state.get(key);
    if (!e) return null;
    const t = now();
    e.falhas = e.falhas.filter((ts) => t - ts < WINDOW_MS);
    if (!e.falhas.length) { state.delete(key); return null; }
    return e;
  }

  return {
    // ms of delay BEFORE answering; 0 = no delay. Reading does not change the state (it only drops
    // stale failures).
    delayMs(keys) {
      let max = 0;
      for (const c of [].concat(keys || [])) {
        const e = live(c);
        if (!e || e.falhas.length <= FREE) continue;
        max = Math.max(max, Math.min(BASE_DELAY_MS * 2 ** (e.falhas.length - FREE - 1), MAX_DELAY_MS));
      }
      return max;
    },
    failed(keys) {
      for (const c of [].concat(keys || [])) {
        const e = live(c) || { falhas: [] };
        e.falhas.push(now());
        state.set(c, e);
      }
    },
    succeeded(keys) { for (const c of [].concat(keys || [])) state.delete(c); },
    // visible to the test and to a future log
    failuresOf(key) { const e = live(key); return e ? e.falhas.length : 0; },
  };
}

module.exports = { createLoginLimiter, WINDOW_MS, FREE, BASE_DELAY_MS, MAX_DELAY_MS };

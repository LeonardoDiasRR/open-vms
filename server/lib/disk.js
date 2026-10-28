'use strict';
// spec 2026-10-19 (global recording settings): disk math as pure functions. Whoever touches
// the filesystem is main; only the two decisions the test must prove with numbers live here.

// Usage percentage in `df` terms: (blocks - bavail) / blocks. `bavail`, not `bfree`: reserved
// blocks are not available for writing, so they count as used (same as df's Use%).
function usedPercent({ blocks = 0, bavail = 0, bsize = 1 } = {}) {
  if (!(blocks > 0)) return 0;
  return Math.round(100 * (blocks - bavail) / blocks);
}

// Hysteresis gate: turns on when the limit is reached; releases only below (limit - 2). Without the
// gap, a recording sitting right at the limit would start and stop the workers every minute.
function decideLimit({ used_percent, limit, limited }) {
  if (limited) return used_percent > limit - 2;
  return used_percent >= limit;
}

module.exports = { usedPercent, decideLimit };

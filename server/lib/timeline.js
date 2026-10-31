'use strict';
// ponytail: faithful CJS port of client/src/lib/timeline.mjs (.mjs is not requireable from CJS)
function buckets(segments, from, to, step) {
  const out = [];
  for (let t = from; t < to; t += step) {
    let covered = 0;
    for (const s of segments) {
      covered += Math.max(0, Math.min(s.end_ts, t + step, to) - Math.max(s.start_ts, t));
    }
    out.push({ t, fraction: Math.min(1, covered / step) });
  }
  return out;
}
function firstGap(segments, threshold) {
  const sorted = [...segments].sort((a, b) => a.start_ts - b.start_ts);
  let end = null;
  for (const s of sorted) {
    if (end !== null && s.start_ts - end > threshold) return { from_ts: end, to_ts: s.start_ts };
    end = end === null ? s.end_ts : Math.max(end, s.end_ts);
  }
  return null;
}
module.exports = { buckets, firstGap };

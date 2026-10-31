// ponytail: segment x bucket intersection; no libraries

// Shape of the segment — the same {start_ts,end_ts} that ArchiveView builds from the server
// buckets and that TimelineBar draws on the bar.
export type Segment = { start_ts: number; end_ts: number };

export function buckets(segments: Segment[], from: number, to: number, step: number): { t: number; fraction: number }[] {
  const out: { t: number; fraction: number }[] = [];
  for (let t = from; t < to; t += step) {
    let covered = 0;
    for (const s of segments) {
      covered += Math.max(0, Math.min(s.end_ts, t + step, to) - Math.max(s.start_ts, t));
    }
    out.push({ t, fraction: Math.min(1, covered / step) });
  }
  return out;
}

export function firstGap(segments: Segment[], threshold: number): { from_ts: number; to_ts: number } | null {
  const sorted = [...segments].sort((a, b) => a.start_ts - b.start_ts);
  let end: number | null = null;
  for (const s of sorted) {
    if (end !== null && s.start_ts - end > threshold) return { from_ts: end, to_ts: s.start_ts };
    end = end === null ? s.end_ts : Math.max(end, s.end_ts);
  }
  return null;
}

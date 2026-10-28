// ponytail: the server sends ready buckets (not the segments); we merge the covered buckets into
// blocks for the bar, for firstGap and for the wall coverage (spec 2026-10-18, 4.4).
// `Bucket` is NOT declared here: `@/shared/utils/api` already exports it with this same shape.
import type { Bucket } from '@/shared/utils/api';

export type Segment = { start_ts: number; end_ts: number };

export function runs(buckets: Bucket[] = [], step = 60, to = 0): Segment[] {
  const out: Segment[] = [];
  for (const b of buckets) {
    if (!b.fraction) continue;
    const end = Math.min(to, b.t + step);
    const last = out[out.length - 1];
    if (last && last.end_ts >= b.t) last.end_ts = Math.max(last.end_ts, end);
    else out.push({ start_ts: b.t, end_ts: end });
  }
  return out;
}

// spec 2026-10-20 (edge, D3, amendment E8 of the plan): merge of the tail of the current day coverage.
// The server does not retract a bucket inside the same day (the hour file only grows), so the
// coverage of today is additive: coalesce `prev` + `tail`. The original rule (“keep from `prev`
// only what ends before `from - 60`”) erased the history of the continuous day on the first poll:
// the timeline returns buckets only from `from` onwards, so nothing re-delivered the morning. Measured in the
// final review: [08:00, 12:00] became only the tail. Coalesce with the same adjacency rule of
// `runs()`. Always returns new objects and arrays: the coverage map is React state.
export function mergeTail(prev: Segment[], tail: Segment[]): Segment[] {
  const all = [...prev, ...tail].map((s) => ({ ...s })).sort((a, b) => a.start_ts - b.start_ts);
  const out: Segment[] = [];
  for (const seg of all) {
    const last = out[out.length - 1];
    if (last && last.end_ts >= seg.start_ts) last.end_ts = Math.max(last.end_ts, seg.end_ts);
    else out.push(seg);
  }
  return out;
}

// spec 2026-10-18 (4.2, contract C4): the wall has ONE global clock — a single epoch shared by all
// cells. This hook is the only source of the instant; the cells become clients (Phase 3).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Segment } from '../services/faixas';
import { SPEEDS } from '../components/PlayerGravacao';

export type ClockInput = {
  midnight: number;                         // epoch of the local 00:00 of the chosen day
  cameras: string[];                        // ids of the wall set
  coverage: Record<string, Segment[]>;      // cameraId -> blocks of the day (from `runs`)
  initialInstant?: number | null;
  // spec 2026-10-18 (C5/E3): speed from the snapshot; default SPEEDS[0]
  initialSpeed?: number;
  // spec 2026-10-20 (edge, D5): the coverage of the day may still grow (today). Without this the clock
  // only parks at the end of the coverage (behavior of a past day).
  mayGrow?: boolean;
  canAdvance?: (epoch: number) => boolean;
};

export type GlobalClock = {
  instant: number;
  playing: boolean;
  speed: number;
  skipGaps: boolean;
  seek: (t: number) => void;
  toggle: () => void;
  setSpeed: (v: number) => void;
  now: () => void;
  setSkipGaps: (b: boolean) => void;
  covered: (cameraId: string, t: number) => boolean;
  // spec 2026-10-20 (D5): the clock waits for the recording to grow at the edge of the day coverage
  atEdge: boolean;
  /** Recording hole the playhead sits in (≥ GAP_STOP_S with no camera): the cell label; null outside it */
  hole: { from: number; to: number } | null;
  seekRequest?: { id: number; target: number };
  read?: () => number;
};

const DAY = 86400;
export const GAP_STOP_S = 60; // spec 2026-10-21 (4.6): a historic gap of this size STOPS the clock (D3)

export function useGlobalClock(q: ClockInput): GlobalClock {
  const { midnight, cameras, coverage } = q;
  const end = midnight + DAY;
  const clamp = useCallback((t: number) => Math.min(Math.max(t, midnight), end), [midnight]);

  const [instant, setInstant] = useState(() => clamp(q.initialInstant ?? midnight));
  const [seekRequest, setSeekRequest] = useState({ id: 0, target: clamp(q.initialInstant ?? midnight) });
  const advance = useRef(q.canAdvance);
  advance.current = q.canAdvance;
  const command = useCallback((target: number) => {
    s.current.instant = target;
    setInstant(target); setSeekRequest(old => ({ id: old.id + 1, target }));
  }, []);
  const [playing, setPlaying] = useState(false);
  // spec 2026-10-18 (C7/E3): the page restores the snapshot speed; outside SPEEDS it falls to the default
  const [speed, setSpeedState] = useState(() =>
    (q.initialSpeed !== undefined && SPEEDS.includes(q.initialSpeed) ? q.initialSpeed : SPEEDS[0]));
  // spec 4.2/D6: skipping gaps is born ON by default
  const [skipGaps, setSkipGaps] = useState(true);
  // spec 2026-10-20 (D5): it waits at the edge. The recording will still grow
  const [atEdge, setAtEdge] = useState(false);
  // spec 2026-10-21 (4.6/D3): the long historic hole the clock parked on (null outside it)
  const [hole, setHole] = useState<{ from: number; to: number } | null>(null);
  const holeRef = useRef<{ from: number; to: number } | null>(null);
  useEffect(() => { holeRef.current = hole; });
  const mayGrow = q.mayGrow === true;

  const covered = useCallback(
    (cameraId: string, t: number) => (coverage[cameraId] ?? []).some((s) => s.start_ts <= t && t < s.end_ts),
    [coverage],
  );

  // state read from inside the rAF loop without recreating the loop on every frame
  const s = useRef({ instant, speed, skipGaps, mayGrow });
  useEffect(() => { s.current = { ...s.current, speed, skipGaps, mayGrow }; });

  // (1) a single rAF loop active only while playing; advances dt*speed in real seconds.
  // (2) stops at the end of the day without turning the day; (3) with skipGaps, jumps the set gap.
  useEffect(() => {
    if (!playing) return;
    let last: number | null = null; // the first frame only anchors the timestamp (dt = 0)
    let raf = 0;
    let painted = -Infinity;
    const tick = (ts: number) => {
      const dt = last === null ? 0 : (ts - last) / 1000;
      last = ts;
      const { instant: t0, speed: v, skipGaps: ig } = s.current;
      if (cameras.some(id => covered(id, t0)) && advance.current && !advance.current(t0)) {
        raf = requestAnimationFrame(tick); return;
      }
      let t = t0 + dt * v;
      if (t >= end) { setInstant(end); setPlaying(false); return; }
      if (ig && !cameras.some((id) => covered(id, t))) {
        let next: number | null = null; // smallest start_ts > instant across every camera
        for (const id of cameras) {
          for (const seg of coverage[id] ?? []) {
            if (seg.start_ts > t && (next === null || seg.start_ts < next)) next = seg.start_ts;
          }
        }
        if (next === null) {
          // defect measured 2026-10-19: parking at `end` (24:00) left the playhead at an instant
          // WITHOUT coverage forever — the player mounted there asked for a playlist outside the
          // coverage and the cell went black. spec 2026-10-20 (D5): parks at LAST END - 1 — a
          // strict rule of `covered()` leaves `lastEnd` itself out, and the cell would show
          // "No recording" at the parking point. With mayGrow it sets atEdge: the effect below
          // reconnects the clock when the coverage grows past that point.
          let lastEnd = t0;
          for (const id of cameras) for (const seg of coverage[id] ?? []) {
            if (seg.end_ts <= end && seg.end_ts > lastEnd) lastEnd = seg.end_ts;
          }
          command(Math.max(lastEnd - 1, midnight));
          setPlaying(false);
          setAtEdge(s.current.mayGrow);
          return;
        }
        // spec 2026-10-21 (4.6/D3): a HISTORIC gap of GAP_STOP_S or more STOPS the clock at the last
        // real frame and reports the hole. `atEdge` stays reserved for "may grow": with mayGrow
        // (today) the old path always wins and `hole` is never used (precedence). lastEnd only
        // counts blocks that END behind the playhead — the next block must not drag its stop.
        if (!s.current.mayGrow && next - t >= GAP_STOP_S) {
          let lastEnd = t0;
          for (const id of cameras) for (const seg of coverage[id] ?? []) {
            if (seg.end_ts <= t && seg.end_ts > lastEnd) lastEnd = seg.end_ts;
          }
          command(Math.max(lastEnd - 1, midnight));
          setPlaying(false);
          setHole({ from: lastEnd, to: next });
          return;
        }
        t = next; setSeekRequest(old => ({ id: old.id + 1, target: t }));
      }
      s.current.instant = t;
      if (ts - painted >= 100) { setInstant(t); painted = ts; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, end, midnight, cameras, coverage, covered, command]);

  // spec 2026-10-20 (D5): it waits at the edge. When the coverage of the wall covers `instant + 1`, the
  // clock resumes alone from `instant + 1`. Nobody pressed play again.
  useEffect(() => {
    if (!atEdge) return;
    const next = instant + 1;
    if (!cameras.some((id) => covered(id, next))) return;
    setAtEdge(false);
    command(next);
    setPlaying(true);
  }, [atEdge, instant, cameras, coverage, covered]);

  const seek = useCallback((t: number) => {
    setAtEdge(false); holeRef.current = null; setHole(null); command(clamp(t));
  }, [clamp, command]);
  // play after a long-hole stop resumes at the start of the next block (spec 2026-10-21:
  // no silent jump, no replay from the frozen frame)
  const toggle = useCallback(() => {
    const h = holeRef.current;
    if (h) { holeRef.current = null; setHole(null); command(h.to); setPlaying(true); return; }
    setPlaying((b) => !b);
  }, [command]);
  // (6) the speed only comes from SPEEDS
  const setSpeed = useCallback((v: number) => {
    if (SPEEDS.includes(v)) setSpeedState(v);
  }, []);
  // (5) now() limited to the window of the day
  // the operator skipped with "Now": the wait at the edge is over (same rule as seek, amendment E2)
  const now = useCallback(() => {
    setAtEdge(false); holeRef.current = null; setHole(null); command(clamp(Math.floor(Date.now() / 1000)));
  }, [clamp, command]);
  const setSkipGapsValue = useCallback((b: boolean) => setSkipGaps(b), []);

  return { instant, playing, speed, skipGaps, seek, toggle, setSpeed, now,
    setSkipGaps: setSkipGapsValue, covered, atEdge, hole, seekRequest, read: () => s.current.instant };
}


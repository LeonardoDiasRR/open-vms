import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useGlobalClock, type ClockInput } from './useRelogioGlobal';

// fake rAF: keeps the last callback so the test fires it by hand (controlled timestamps).
let rafCb: ((ts: number) => void) | null = null;
const step = (ts: number) => act(() => { const cb = rafCb; rafCb = null; cb?.(ts); });

const M = 1_000_000_000; // abstract midnight of the day
const DAY = 86400;
const wholeDay = { a: [{ start_ts: M, end_ts: M + DAY }] };

function render(q: Partial<ClockInput> = {}) {
  const input: ClockInput = { midnight: M, cameras: ['a'], coverage: wholeDay, ...q };
  return renderHook(() => useGlobalClock(input));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date((M + 3600) * 1000)); // the real clock of the day stays fixed
  rafCb = null;
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => { rafCb = cb; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => { rafCb = null; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('useGlobalClock', () => {
  it('explicit same-target seeks get distinct command ids; buffering does not advance the clock', () => {
    let ready = false;
    const { result } = render({ canAdvance: () => ready });
    act(() => result.current.seek(M)); const id = result.current.seekRequest!.id;
    act(() => result.current.seek(M)); expect(result.current.seekRequest!.id).toBe(id + 1);
    act(() => result.current.toggle()); step(0); step(1000);
    expect(result.current.instant).toBe(M);
    ready = true; step(2000); expect(result.current.instant).toBe(M + 1);
  });
  it('with play on the instant advances dt*speed', () => {
    const { result } = render();
    act(() => { result.current.toggle(); result.current.setSpeed(4); });
    step(0);     // the first frame anchors the timestamp (dt = 0)
    step(2000);  // +2 s of clock at 4x = +8 s
    expect(result.current.instant).toBe(M + 8);
    expect(result.current.playing).toBe(true);
  });

  it('coordinator reads the live clock between throttled UI updates at 4x', () => {
    const { result } = render();
    act(() => { result.current.setSpeed(4); result.current.toggle(); });
    step(0); step(50);
    expect(result.current.instant).toBe(M);
    expect(result.current.read!()).toBeCloseTo(M + 0.2);
    step(100); expect(result.current.instant).toBeCloseTo(M + 0.4);
  });

  it('seek, toggle and setSpeed write the state', () => {
    const { result } = render();
    act(() => result.current.seek(M + 500));
    expect(result.current.instant).toBe(M + 500);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(false);
    act(() => result.current.setSpeed(4));
    expect(result.current.speed).toBe(4);
    act(() => result.current.setSpeed(3)); // outside SPEEDS: ignored
    expect(result.current.speed).toBe(4);
  });

  it('covered answers for the blocks of the day', () => {
    const { result } = render({ coverage: { a: [{ start_ts: M + 100, end_ts: M + 200 }] } });
    expect(result.current.covered('a', M + 100)).toBe(true);
    expect(result.current.covered('a', M + 199)).toBe(true);
    expect(result.current.covered('a', M + 200)).toBe(false); // exclusive end
    expect(result.current.covered('a', M + 50)).toBe(false);  // in the gap
    expect(result.current.covered('zz', M + 150)).toBe(false);
  });

  it('gap longo (≥ GAP_STOP_S) estaciona no último frame real e reporta o hole', () => {
    // set gap from M+100 to M+300 (next block of the set at M+300)
    const layers = {
      a: [{ start_ts: M, end_ts: M + 100 }],
      b: [{ start_ts: M, end_ts: M + 100 }],
      c: [{ start_ts: M + 300, end_ts: M + 400 }],
    };
    const { result, unmount } = render({ cameras: ['a', 'b', 'c'], coverage: layers });
    act(() => { result.current.setSkipGaps(true); result.current.toggle(); });
    step(0);
    step(110000); // dt = 110 → M+110 inside the gap. the next block is 190 s ahead
    expect(result.current.instant).toBe(M + 99); // lastEnd (M+100) − 1: the last real frame
    expect(result.current.playing).toBe(false);
    expect(result.current.hole).toEqual({ from: M + 100, to: M + 300 });
    // play after the stop resumes in the next block (E15: no silent jump)
    act(() => result.current.toggle());
    expect(result.current.instant).toBe(M + 300);
    expect(result.current.playing).toBe(true);
    expect(result.current.hole).toBeNull();
    unmount();

    const off = render({ cameras: ['a', 'b', 'c'], coverage: layers });
    // the default is now ON (spec 4.2/D6): the "no skip" branch has to turn it off explicitly
    act(() => { off.result.current.setSkipGaps(false); off.result.current.toggle(); });
    step(0);
    step(110000); // without the toggle, it crosses the gap at the normal pace
    expect(off.result.current.instant).toBe(M + 110);
  });

  it('the clock starts with gap skipping on', () => {
    const { result } = render();
    expect(result.current.skipGaps).toBe(true);
  });

  // spec 2026-10-18 (C5/E3): optional initialSpeed; outside SPEEDS it falls to the default
  it('initialSpeed comes in the state; a value outside SPEEDS falls to the default', () => {
    const a = render({ initialSpeed: 4 });
    expect(a.result.current.speed).toBe(4);
    const b = render({ initialSpeed: 16 });
    expect(b.result.current.speed).toBe(1);
  });

  it('with no next block, it parks at the last coverage of the set — never at 24:00', () => {
    // defect measured 2026-10-19: parking at `end` left the playhead without coverage (black cell).
    const layers = { a: [{ start_ts: M, end_ts: M + 100 }], b: [{ start_ts: M + 50, end_ts: M + 300 }] };
    const { result, unmount } = render({ cameras: ['a', 'b'], coverage: layers });
    act(() => { result.current.setSkipGaps(true); result.current.toggle(); });
    step(0);       // anchors at M (inside a/b)
    step(310000);  // dt=310 s -> M+310: no next block -> park at LAST END - 1 (M+299), spec 2026-10-20 D5
    expect(result.current.instant).toBe(M + 299);
    expect(result.current.playing).toBe(false);
    expect(result.current.atEdge).toBe(false);   // mayGrow absent (past day): it does not wait, it only parks
    unmount();
  });

  it('at the end of the day the clock stops and does not turn the day', () => {
    const { result } = render({ initialInstant: M + DAY - 1 });
    act(() => result.current.toggle());
    step(0);      // anchors
    step(1000);   // +1 s hits midnight of the next day
    expect(result.current.playing).toBe(false);
    expect(result.current.instant).toBe(M + DAY); // stays at the end, does not go back to zero
  });

  // spec 2026-10-20 (playback edge, D5): the current day waits for the recording to grow
  it('with mayGrow, parks at lastEnd-1 and marks atEdge', () => {
    const layers = { a: [{ start_ts: M, end_ts: M + 100 }], b: [{ start_ts: M + 50, end_ts: M + 300 }] };
    const { result } = render({ cameras: ['a', 'b'], coverage: layers, mayGrow: true });
    act(() => { result.current.setSkipGaps(true); result.current.toggle(); });
    step(0);
    step(310000);
    expect(result.current.instant).toBe(M + 299);
    expect(result.current.playing).toBe(false);
    expect(result.current.atEdge).toBe(true);
  });

  it('with mayGrow and new coverage, resumes at instant+1 and plays again', () => {
    const before = { a: [{ start_ts: M, end_ts: M + 100 }], b: [{ start_ts: M + 50, end_ts: M + 300 }] };
    const after = { a: [{ start_ts: M, end_ts: M + 100 }], b: [{ start_ts: M + 50, end_ts: M + 400 }] };
    const input: ClockInput = { midnight: M, cameras: ['a', 'b'], coverage: before, mayGrow: true };
    const { result, rerender } = renderHook((q: ClockInput) => useGlobalClock(q), { initialProps: input });
    act(() => { result.current.setSkipGaps(true); result.current.toggle(); });
    step(0);
    step(310000);
    expect(result.current.atEdge).toBe(true);
    rerender({ ...input, coverage: after });
    expect(result.current.atEdge).toBe(false);
    expect(result.current.instant).toBe(M + 300);   // retoma exatamente em instant + 1
    expect(result.current.playing).toBe(true);
  });

  // spec 2026-10-21 (4.6): a short gap is still a skip. mayGrow takes precedence
  it('gap curto (< GAP_STOP_S) ainda é pulado', () => {
    const layers = { a: [{ start_ts: M, end_ts: M + 100 }], c: [{ start_ts: M + 130, end_ts: M + 230 }] };
    const { result, unmount } = render({ cameras: ['a', 'c'], coverage: layers });
    act(() => { result.current.setSkipGaps(true); result.current.toggle(); });
    step(0);
    step(110000); // M+110 in the 30 s gap: it skips, it does not stop
    expect(result.current.instant).toBe(M + 130);
    expect(result.current.hole).toBeNull();
    unmount();
  });

  it('com mayGrow (hoje), bloco seguinte distante ainda é pulado: hole é só histórico', () => {
    const layers = { a: [{ start_ts: M, end_ts: M + 100 }], c: [{ start_ts: M + 300, end_ts: M + 400 }] };
    const { result, unmount } = render({ cameras: ['a', 'c'], coverage: layers, mayGrow: true });
    act(() => { result.current.setSkipGaps(true); result.current.toggle(); });
    step(0);
    step(110000);
    expect(result.current.instant).toBe(M + 300);
    expect(result.current.hole).toBeNull();
    unmount();
  });
});


import { describe, expect, it } from 'vitest';
import { clipSegment, fullDay, normalizeWheelDelta, rulerMarks, timeAt, timeFraction, zoomViewport } from './timeline-viewport';

const DAY = 86400;
const midnight = 1_760_000_000;

describe('timeline viewport', () => {
  it('opens the complete selected day and maps its edges and midpoint', () => {
    const view = fullDay(midnight);
    expect(view).toEqual({ start: midnight, end: midnight + DAY });
    expect(timeAt(0, view)).toBe(midnight);
    expect(timeAt(0.5, view)).toBe(midnight + 43200);
    expect(timeAt(1, view)).toBe(midnight + DAY);
    expect(timeAt(-1, view)).toBe(midnight);
    expect(timeAt(2, view)).toBe(midnight + DAY);
    expect(timeFraction(midnight + 43200, view)).toBe(0.5);
  });

  it('zooms in around the pointer, preserving its timestamp', () => {
    const view = zoomViewport(fullDay(midnight), midnight, 0.25, -100);
    expect(view.start).toBeCloseTo(midnight + 4320, 5);
    expect(view.end - view.start).toBeCloseTo(69120, 5);
    expect(timeAt(0.25, view)).toBe(midnight + 21600);
  });

  it.each([0.1, 0.5, 0.9])('keeps the anchor at fraction %s through repeated zooms', fraction => {
    let view = fullDay(midnight);
    const anchor = timeAt(fraction, view);
    for (let i = 0; i < 24; i++) {
      view = zoomViewport(view, midnight, fraction, -100);
      expect(timeAt(fraction, view)).toBeCloseTo(anchor, 4);
    }
  });

  it('reverses a zoom without drift away from day boundaries', () => {
    const before = { start: midnight + 3600, end: midnight + 7200 };
    const after = zoomViewport(zoomViewport(before, midnight, 0.4, -100), midnight, 0.4, 100);
    expect(after.start).toBeCloseTo(before.start, 5);
    expect(after.end).toBeCloseTo(before.end, 5);
  });

  it.each([0, 1])('keeps the window inside the day when zooming at edge %s', fraction => {
    let view = zoomViewport(fullDay(midnight), midnight, fraction, -10000);
    expect(view.end - view.start).toBe(30);
    expect(view.start).toBeGreaterThanOrEqual(midnight);
    expect(view.end).toBeLessThanOrEqual(midnight + DAY);
    expect(zoomViewport(view, midnight, fraction, 10000)).toEqual(fullDay(midnight));
  });

  it('clamps zoom out at the day boundary while preserving the requested duration', () => {
    const view = zoomViewport({ start: midnight, end: midnight + 60 }, midnight, 0.8, 100);
    expect(view).toEqual({ start: midnight, end: midnight + 75 });
  });

  it('stops at 30 seconds and a full day without redundant changes', () => {
    const smallest = zoomViewport(fullDay(midnight), midnight, 0.5, -10000);
    expect(smallest.end - smallest.start).toBe(30);
    expect(zoomViewport(smallest, midnight, 0.5, -100)).toBe(smallest);
    const largest = fullDay(midnight);
    expect(zoomViewport(largest, midnight, 0.5, 100)).toBe(largest);
  });

  it('normalizes pixel, line and page deltas', () => {
    expect(normalizeWheelDelta(-48, 0, 300)).toBe(-48);
    expect(normalizeWheelDelta(-3, 1, 300)).toBe(-48);
    expect(normalizeWheelDelta(-1, 2, 300)).toBe(-300);
  });

  it('clips existing coverage without changing the source or inventing gaps', () => {
    const view = { start: 100, end: 130 };
    const segment = { start_ts: 60, end_ts: 180 };
    expect(clipSegment(segment, view)).toEqual({ start_ts: 100, end_ts: 130 });
    expect(segment).toEqual({ start_ts: 60, end_ts: 180 });
    expect(clipSegment({ start_ts: 80, end_ts: 100 }, view)).toBeNull();
    expect(clipSegment({ start_ts: 130, end_ts: 160 }, view)).toBeNull();
    expect(clipSegment({ start_ts: 105, end_ts: 120 }, view)).toEqual({ start_ts: 105, end_ts: 120 });
  });

  it('keeps the full-day ruler at two-hour intervals on a wide timeline', () => {
    const marks = rulerMarks(fullDay(midnight), midnight, 1000);
    expect(marks).toHaveLength(13);
    expect(marks[0]).toMatchObject({ time: midnight, label: '00:00' });
    expect(marks[12]).toMatchObject({ time: midnight + DAY, label: '24:00' });
  });

  it('adds seconds at close zoom and reduces labels on narrow timelines', () => {
    const view = { start: midnight + 43200, end: midnight + 43230 };
    const marks = rulerMarks(view, midnight, 1000);
    expect(marks[0].label).toBe('12:00:00');
    expect(marks.at(-1)?.label).toBe('12:00:30');
    expect(rulerMarks(view, midnight, 240).length).toBeLessThan(marks.length);
    for (const width of [240, 400, 1000, 2000]) {
      const ticks = rulerMarks(view, midnight, width);
      for (let i = 1; i < ticks.length; i++) {
        expect((timeFraction(ticks[i].time, view) - timeFraction(ticks[i - 1].time, view)) * width).toBeGreaterThanOrEqual(90);
      }
    }
  });

  it('uses seconds whenever ticks are less than a minute apart, including wide views', () => {
    for (const duration of [600, 601, 900]) {
      const marks = rulerMarks({ start: midnight, end: midnight + duration }, midnight, 2400);
      expect(new Set(marks.map(mark => mark.label)).size).toBe(marks.length);
      if (marks[1].time - marks[0].time < 60) expect(marks[1].label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
  });
});

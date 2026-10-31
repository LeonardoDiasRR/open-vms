import type { Segment } from './faixas';

export const DAY_SECONDS = 86400;
export const MIN_TIMELINE_SPAN = 30;
export type TimeViewport = { start: number; end: number };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const fullDay = (midnight: number): TimeViewport => ({ start: midnight, end: midnight + DAY_SECONDS });
export const timeFraction = (time: number, view: TimeViewport) => (time - view.start) / (view.end - view.start);
export const timeAt = (fraction: number, view: TimeViewport) => view.start + clamp(fraction, 0, 1) * (view.end - view.start);

// DOM_DELTA_LINE is normalized to a compact 16px line; pages use the interaction surface height.
export const normalizeWheelDelta = (delta: number, mode: number, pageHeight: number) =>
  delta * (mode === 1 ? 16 : mode === 2 ? pageHeight : 1);

export function zoomViewport(view: TimeViewport, midnight: number, fraction: number, deltaPixels: number): TimeViewport {
  const duration = view.end - view.start;
  const next = clamp(duration * Math.exp(deltaPixels * Math.log(1.25) / 100), MIN_TIMELINE_SPAN, DAY_SECONDS);
  if (next === duration) return view;
  const anchor = timeAt(fraction, view);
  const start = clamp(anchor - clamp(fraction, 0, 1) * next, midnight, midnight + DAY_SECONDS - next);
  return { start, end: start + next };
}

export function clipSegment(segment: Segment, view: TimeViewport): Segment | null {
  const start_ts = Math.max(segment.start_ts, view.start);
  const end_ts = Math.min(segment.end_ts, view.end);
  return end_ts > start_ts ? { start_ts, end_ts } : null;
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, DAY_SECONDS];

export function rulerMarks(view: TimeViewport, midnight: number, width: number): { time: number; label: string }[] {
  const duration = view.end - view.start;
  const step = STEPS.find(s => s * Math.max(1, width) / duration >= (s < 60 ? 96 : 64)) ?? DAY_SECONDS;
  const seconds = step < 60;
  const first = midnight + Math.ceil((view.start - midnight) / step) * step;
  const marks: { time: number; label: string }[] = [];
  const pad = (n: number) => String(n).padStart(2, '0');
  for (let time = first; time <= view.end; time += step) {
    // Relative to the selected local midnight, matching the existing 24-hour day contract.
    const offset = Math.round(time - midnight);
    const label = `${pad(Math.floor(offset / 3600))}:${pad(Math.floor(offset % 3600 / 60))}`
      + (seconds ? `:${pad(offset % 60)}` : '');
    marks.push({ time, label });
  }
  return marks;
}

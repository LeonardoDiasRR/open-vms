import { expect, it } from 'vitest';
import { qualityFor } from './playback-quality';

const normal = { preview: false, changedAt: -Infinity };
const input = { enabled: true, rate: 8, frames: 100, dropped: 20, stalls: 0, now: 100000 };
it('uses preview only when enabled, accelerated and under observed pressure', () => {
  expect(qualityFor({ ...input, enabled: false }, normal).preview).toBe(false);
  expect(qualityFor({ ...input, rate: 2 }, normal).preview).toBe(false);
  expect(qualityFor({ ...input, dropped: 0 }, normal).preview).toBe(false);
  expect(qualityFor(input, normal).preview).toBe(true);
  expect(qualityFor({ ...input, frames: 0, dropped: 0, stalls: 2 }, normal).preview).toBe(true);
});
it('holds a representation for 30 seconds and returns to original at low speed', () => {
  const preview = qualityFor(input, normal);
  expect(qualityFor({ ...input, now: 110000, dropped: 0 }, preview).preview).toBe(true);
  expect(qualityFor({ ...input, now: 131000, dropped: 0 }, preview).preview).toBe(false);
  expect(qualityFor({ ...input, rate: 1, now: 101000 }, preview).preview).toBe(false);
});

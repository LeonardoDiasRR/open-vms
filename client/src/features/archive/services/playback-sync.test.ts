import { expect, it } from 'vitest';
import { recoveryTarget, syncAction, wallReady, STARTUP_WAIT_MS, type PlaybackSample } from './playback-sync';

const stalled = (nextEpoch?: number): PlaybackSample => ({ epoch: 1000, ready: false, presentedAt: 0, nextEpoch });

it('recovers all-stalled playback to the earliest actual buffered successor, regardless of sample order', () => {
  const samples = [stalled(1012), stalled(), stalled(1003.25), stalled(1008)];
  expect(recoveryTarget(samples, 1000, true)).toBe(1003.25);
  expect(recoveryTarget([...samples].reverse(), 1000, true)).toBe(1003.25);
});

it('keeps the target when one camera is healthy even if its last epoch or presentation time is old', () => {
  expect(recoveryTarget([stalled(1003), { epoch: 999, ready: true, presentedAt: 0 }], 1000, true)).toBeNull();
});

it('does not recover with skipping disabled', () => {
  expect(recoveryTarget([stalled(1003)], 1000, false)).toBeNull();
});

it('does not invent recovery media for an empty wall', () => {
  expect(recoveryTarget([], 1000, true)).toBeNull();
});

it.each([undefined, NaN, Infinity, -Infinity, 999, 1000])('rejects absent or invalid successor %s', nextEpoch => {
  expect(recoveryTarget([stalled(nextEpoch)], 1000, true)).toBeNull();
  expect(recoveryTarget([stalled(nextEpoch), stalled(1005)], 1000, true)).toBe(1005);
});

it.each<[number, number | null]>([
  [1059.999, 1059.999],
  [1060, null],
  [1061, null],
])('only recovers gaps strictly under 60 seconds: %s', (nextEpoch, expected) => {
  expect(recoveryTarget([stalled(nextEpoch)], 1000, true)).toBe(expected);
});

it('waits for startup, degrades after the deadline and freezes if every camera buffers', () => {
  const sample = (ready: boolean) => ({ epoch: 1000, ready, presentedAt: 0 });
  expect(wallReady([sample(true), sample(false)], STARTUP_WAIT_MS - 1)).toBe(false);
  expect(wallReady([sample(true), sample(false)], STARTUP_WAIT_MS)).toBe(true);
  expect(wallReady([sample(false), sample(false)], 100000)).toBe(false);
  expect(wallReady([sample(true), sample(true)], 0)).toBe(true);
  expect(wallReady([], 100000)).toBe(false);
});

it('corrects drift with a deadband and a bounded hard-seek cadence', () => {
  expect(syncAction(1000, 1000.1, 4, 5000)).toEqual({ seek: null, rate: 4 });
  expect(syncAction(1000, 1000.5, 4, 5000)).toEqual({ seek: null, rate: 4.2 });
  expect(syncAction(1001, 1000.5, 4, 5000)).toEqual({ seek: null, rate: 3.8 });
  expect(syncAction(1000, 1010, 8, 1999).seek).toBeNull();
  expect(syncAction(1000, 1010, 8, 2000)).toEqual({ seek: 1010, rate: 8 });
});

import { describe, expect, it } from 'vitest';
import { cellProfile, secondaryProfile, primaryProfile, type Profile } from './perfis';

const P = (id: string, name: string, width: number | null, height: number | null): Profile => ({ id, name, width, height });

describe('profiles', () => {
  it('no profiles: undefined; with a single profile, it serves both the grid and the primary', () => {
    expect(secondaryProfile([])).toBe(undefined);
    expect(primaryProfile([])).toBe(undefined);
    const single = P('a', 'main', null, null);
    expect(secondaryProfile([single])).toBe(single);
    expect(primaryProfile([single])).toBe(single);
  });

  it('primary is the highest resolution; the grid gets the lowest of the others (real HIK case)', () => {
    const main = P('m', 'main', null, null);            // manual profile, no width
    const ms = P('1', 'mainStream', 1920, 1080);
    const sub = P('2', 'subStream', 640, 480);
    const third = P('3', 'thirdStream', 1280, 720);
    const l = [main, ms, sub, third];
    expect(primaryProfile(l)).toBe(ms);
    expect(secondaryProfile(l)).toBe(sub);
  });

  it('without a smaller profile, the grid uses the primary itself', () => {
    const only = P('1', 'mainStream', 1920, 1080);
    expect(secondaryProfile([only])).toBe(only);
    // two profiles with the same width: one is the primary, the other serves the grid
    const a = P('a', 'a', 640, 480), b = P('b', 'b', 640, 480);
    expect([a, b]).toContain(primaryProfile([a, b]));
    expect(secondaryProfile([a, b])).toBe(primaryProfile([a, b]) === a ? b : a);
  });

  it('a profile without width never beats the one with a known width on the grid', () => {
    const noWidth = P('x', 'extra', null, null);
    const sub = P('2', 'subStream', 640, 480);
    const ms = P('1', 'mainStream', 1920, 1080);
    expect(secondaryProfile([noWidth, sub, ms])).toBe(sub);
  });

  it('cellProfile: secondary in the cell, primary in fullscreen and after the fallback', () => {
    const ms = P('1', 'mainStream', 1920, 1080);
    const sub = P('2', 'subStream', 640, 480);
    const l = [ms, sub];
    expect(cellProfile(l)?.id).toBe(sub.id);
    expect(cellProfile(l, { fellBack: true })?.id).toBe(ms.id);
    expect(cellProfile(l, { fullscreen: true })?.id).toBe(ms.id);
    expect(cellProfile(l, { fullscreen: true, fellBack: true })?.id).toBe(ms.id);
    // single-profile camera: no secondary, the cell uses the primary
    expect(cellProfile([ms])?.id).toBe(ms.id);
    expect(cellProfile([])).toBe(undefined);
  });
});

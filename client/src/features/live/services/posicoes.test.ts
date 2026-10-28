import { describe, expect, it } from 'vitest';
import { LIMIT, type Position } from './posicoes';

describe('local positions (spec 2026-10-17)', () => {
  it('the list limit is 20', () => {
    expect(LIMIT).toBe(20);
    // the name is free (the `Position N` rule left with `presets.ts`): any string works
    const free: Position = { id: 1, name: 'Entrada' };
    expect(free.name).toBe('Entrada');
  });
});

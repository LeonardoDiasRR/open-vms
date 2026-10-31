import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('joins classes and resolves a Tailwind conflict with the last one', () => {
    expect(cn('a', 'b')).toBe('a b');
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('a', false && 'b', undefined)).toBe('a');
  });
});

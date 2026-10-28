import { describe, expect, it } from 'vitest';
import { formatters } from './format';

describe('formatters', () => {
  it('formats dates with the locale', () => {
    const d = new Date('2026-10-19T12:00:00Z');
    expect(formatters('pt-BR').date(d)).not.toBe(formatters('en').date(d));
  });
  it('sorts numbers by value in both locales', () => {
    for (const lang of ['en', 'pt-BR'] as const) {
      expect(['10', '2'].sort(formatters(lang).compare)).toEqual(['2', '10']);
    }
  });
});

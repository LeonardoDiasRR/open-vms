import { describe, expect, it } from 'vitest';
import { en } from './en';
import { ptBR } from './pt-BR';

describe('dictionaries', () => {
  it('has the same keys', () => {
    expect(Object.keys(ptBR).sort()).toEqual(Object.keys(en).sort());
  });
  it('has no empty value', () => {
    for (const [k, v] of Object.entries({ ...en, ...ptBR })) expect(v.trim(), k).not.toBe('');
  });
  it('english has no portuguese accent', () => {
    const ACCENTED = /[\u00e3\u00f5\u00e1\u00e9\u00ed\u00f3\u00fa\u00e2\u00ea\u00f4\u00e7]/i;
    for (const [k, v] of Object.entries(en)) expect(ACCENTED.test(v), k).toBe(false);
  });
  it('has no english placeholder left in the portuguese dictionary', () => {
    expect(ptBR['layouts.tab_new']).toBe('Novo layout {n}');
  });
  it('keeps interpolation placeholders', () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      const a = (en[k].match(/\{\w+\}/g) || []).sort();
      const b = ((ptBR[k] as string).match(/\{\w+\}/g) || []).sort();
      expect(b, k).toEqual(a);
    }
  });
  // plan 2026-10-23: keys for the description and for the card state labels.
  it('has the export description keys', () => {
    const KEYS = ['archive.description', 'archive.description_placeholder', 'archive.description_hint',
      'archive.description_required', 'archive.badge_done', 'archive.badge_failed'] as const;
    for (const k of KEYS) {
      expect((ptBR as Record<string, string>)[k], `pt-BR ${k}`).toBeTruthy();
      expect((en as Record<string, string>)[k], `en ${k}`).toBeTruthy();
    }
  });
});

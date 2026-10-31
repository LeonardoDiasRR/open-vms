import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// Forbidden form assembled by concatenation so this file does not match itself in the scan.
const FORBIDDEN = /window\.(prompt|confir[m]|alert)\(/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('invariant: zero native browser windows in the client', () => {
  it('no production file calls the native windows', () => {
    const root = join(process.cwd(), 'src');
    const offences: string[] = [];
    for (const f of tsFiles(root)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (FORBIDDEN.test(line)) offences.push(`${relative(process.cwd(), f)}:${i + 1}`);
      });
    }
    expect(offences).toEqual([]);
  });
  it('the predicate catches the forbidden form (self-test)', () => {
    expect(FORBIDDEN.test('window.al' + 'ert(x)')).toBe(true);
    expect(FORBIDDEN.test('const x = 1;')).toBe(false);
  });
});

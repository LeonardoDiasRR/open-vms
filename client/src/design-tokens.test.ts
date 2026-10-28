import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// Design-system guard (spec 2026-10-17, M4). It does NOT measure pixels: it reads the files as TEXT and
// fails on three ways of breaking the single source. It runs on the client runner (node:fs), with no
// jsdom and no new dependency.
//
// The documented way out when the guard blocks a legitimate PR is NOT to loosen the guard: it is an
// amendment to the spec table ("Risks and mitigation"), which becomes a line in SPEC_TABLE or NOT_COLOR.
const ROOT = join(process.cwd(), 'src');
const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');

// --color-* names of the @theme, measured on 2026-10-17 (23 entries, all var() of :root). The table is
// LITERAL on purpose: a new name in the @theme now requires a spec amendment (M4, check 3).
const SPEC_TABLE = new Set([
  // 18 from the shadcn vocabulary (spec M1)
  'background', 'foreground', 'card', 'popover', 'primary', 'primary-foreground', 'secondary',
  'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'destructive',
  'destructive-foreground', 'border', 'input', 'ring', 'warn',
  // 5 project legacy names, kept by the spec (the guard forbids NEW USE, not existence)
  'bg', 'panel', 'borda', 'texto', 'danger',
]);

// Tailwind utility suffixes that are NOT a color. Only the ones the project uses enter the obvious
// family: without this list `text-sm` would fail the guard (the repo has text-sm/xs/lg/base,
// text-left/center, ring-offset-2).
const NOT_COLOR = new Set([
  'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl',                 // text size
  'left', 'center', 'right', 'justify', 'start', 'end',         // alignment
  'wrap', 'nowrap', 'balance', 'pretty', 'ellipsis', 'clip',    // wrapping/clipping
  'solid', 'dashed', 'dotted', 'double', 'none', 'hidden', 'collapse', 'separate', // border style
  't', 'b', 'l', 'r', 'x', 'y', 's', 'e',                       // border side
]);
const NEUTRAL_NAMES = new Set(['transparent', 'current', 'white', 'black', 'inherit']);

function tsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsx(p));
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const themeNames = () => {
  const theme = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  return [...theme.matchAll(/--color-([a-z][a-z0-9-]*)\s*:/g)].map((m) => m[1]);
};
const withoutTokenBlocks = (text: string) =>
  text.replace(/:root\s*\{[\s\S]*?\n\}/, '').replace(/@theme\s*\{[\s\S]*?\n\}/, '');

describe('design-system guard (spec 2026-10-17, M4)', () => {
  it('1: no hex outside :root and @theme', () => {
    const outside = withoutTokenBlocks(css).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(outside, `hex outside the token blocks: ${outside.join(', ')}`).toEqual([]);
  });

  it('2: every color class in the .tsx exists in the @theme', () => {
    const names = new Set(themeNames());
    const occurrences: string[] = [];
    for (const file of tsx(ROOT)) {
      const rel = relative(ROOT, file);
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        for (const m of line.matchAll(/\b(bg|text|border|ring|fill|stroke)-([a-z][a-z0-9-]*)/g)) {
          let name = m[2];
          if (m[1] === 'ring' && name.startsWith('offset-')) name = name.slice(7);
          if (/^\d/.test(name)) continue;                 // ring-2, border-0, ring-offset-2
          if (names.has(name) || NOT_COLOR.has(name) || NEUTRAL_NAMES.has(name)) continue;
          occurrences.push(`${rel}:${i + 1} ${m[0]}`);
        }
      }
    }
    expect(occurrences, `color classes without --color-* in the @theme:\n${occurrences.join('\n')}`).toEqual([]);
  });

  it('3: the @theme has no --color-* name outside the spec table', () => {
    const names = themeNames();
    expect(names.length).toBeGreaterThanOrEqual(18);       // a broken parse cannot pass by emptiness
    expect(names.filter((n) => !SPEC_TABLE.has(n))).toEqual([]);
  });
});

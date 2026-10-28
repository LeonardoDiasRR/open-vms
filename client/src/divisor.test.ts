import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// spec 2026-10-18 (section 6.2): the fix is STRUCTURAL — the handle gets its own track in the shell
// grid and stops competing for the pointer with the panel scrollbar. jsdom neither applies the sheet
// nor models a scrollbar, so this guard reads `styles.css` as TEXT, in the shape of `selecao.test.ts`,
// and pins the drawing probe D measured. The real hit-test only closes in the browser (acceptance 6.3,
// section "Out of scope").
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const block = (sel: string) => new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css)?.[1] ?? '';

describe('panel divider: its own grid track (spec 2026-10-18)', () => {
  it('the shell has FIVE columns and the two 2px tracks sit between panel and stage', () => {
    // spec 2026-10-18 (2px track): 6px was the old comfortable target; 2px is what the operator asked for.
    // The panel scrollbar lives INSIDE the panel column, so the anti-scrollbar guarantee does not depend on width.
    expect(block('.shell')).toMatch(/grid-template-columns:\s*var\(--col-esq\)\s*2px\s*1fr\s*2px\s*var\(--col-dir\)/);
  });

  it('the grid middle row names both tracks and the rest keeps the previous areas', () => {
    const shell = block('.shell');
    expect(shell).toMatch(/'topbar\s+topbar\s+topbar\s+topbar\s+topbar'/);
    expect(shell).toMatch(/'sidebar\s+alca-esq\s+scene\s+alca-dir\s+rightpanel'/);
    expect(shell).toMatch(/'statusbar\s+statusbar\s+statusbar\s+statusbar\s+statusbar'/);
  });

  it('the handles live in their own area and no longer use grid-column, grid-row or justify-self', () => {
    const left = block('.alca-esq');
    expect(left).toMatch(/grid-area:\s*alca-esq/);
    expect(left).not.toMatch(/grid-column|grid-row|justify-self/);
    const right = block('.alca-dir');
    expect(right).toMatch(/grid-area:\s*alca-dir/);
    expect(right).not.toMatch(/grid-column|grid-row|justify-self/);
  });

  it('the 12px hit area spills to the STAGE side: right on the left one, left on the right one', () => {
    expect(block('.alca-painel')).toMatch(/position:\s*relative/);
    const target = block('.alca-painel::after');
    expect(target).toMatch(/content:\s*''/);
    expect(target).toMatch(/position:\s*absolute/);
    expect(target).toMatch(/top:\s*0/);
    expect(target).toMatch(/bottom:\s*0/);
    expect(target).toMatch(/width:\s*12px/);
    // the PANEL side never gets a hit area: with a 4px strip, the -8px offset makes the hit start
    // EXACTLY at the strip edge (12px hit = 4px strip + 8px towards the stage)
    const left = block('.alca-esq::after');
    expect(left).toMatch(/right:\s*-8px/);
    expect(left).not.toMatch(/(^|[^-])left:/);
    const right = block('.alca-dir::after');
    expect(right).toMatch(/left:\s*-8px/);
    expect(right).not.toMatch(/(^|[^-])right:/);
  });

  it('the divider is invisible: a 4px strip in the panel color covers the gaps; hover lights a 2px center line', () => {
    // spec 2026-10-18 (2px track): strip = 2px track + 2 gaps of 1px. The 2px line sits at the center
    // of the 4px strip: stops 1px/3px (the guard does not walk into calc parentheses; see the previous
    // plan amendment).
    const base = block('.alca-painel');
    expect(base).toMatch(/width:\s*4px/);
    expect(base).toMatch(/margin-inline:\s*-1px/);
    expect(base).toMatch(/background-color:\s*var\(--panel\)/);
    expect(base).toMatch(/background-image:\s*none/);
    expect(base).toMatch(/cursor:\s*col-resize/);
    expect(base).not.toMatch(/background:\s*transparent/);
    const hover = block('.alca-painel:hover, .alca-painel:focus-visible');
    expect(hover).toMatch(/background-color:\s*var\(--panel\)/);
    expect(hover).toMatch(/background-image:\s*linear-gradient\([^)]*var\(--accent\)/);
    expect(hover).toMatch(/transparent 1px/);
    expect(hover).toMatch(/var\(--accent\) 1px/);
    expect(hover).toMatch(/var\(--accent\) 3px/);
  });

  it('the drag compensation follows the shell track and gap: HANDLE_COMPENSATION === track / 2 + gap', () => {
    // ties the 2px compensation (App.tsx) to the track and the 1px gap (.shell): changing the track or
    // the gap without adjusting the compensation fails here, instead of misaligning the drag in silence
    const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    const shell = block('.shell');
    const track = Number(/grid-template-columns:\s*var\(--col-esq\)\s*(\d+)px\s*1fr/.exec(shell)?.[1]);
    const gap = Number(/\bgap:\s*(\d+)px/.exec(shell)?.[1]);
    const compensation = Number(/const HANDLE_COMPENSATION = (\d+)/.exec(app)?.[1]);
    expect(compensation).toBe(track / 2 + gap);
  });
});

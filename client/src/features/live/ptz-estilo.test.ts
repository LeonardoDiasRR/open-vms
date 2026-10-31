import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Style guard of spec 2026-10-16 (ptz-commands-do-not-run): the green has to be the design-system one,
// the cell blue is gone, and the glyph has to be at the size measured as readable. Reading through
// `process.cwd()` is the form the project's static test already uses (shared/dialogo-invariante.test.ts).
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

describe('PTZ style in the cell', () => {
  it('the armed joystick uses the design-system green and the blue is gone', () => {
    expect(css).toMatch(/\.cell-ptz\.ativo\s*\{[^}]*var\(--accent\)/);
    expect(css.includes('#2f81f7')).toBe(false);
  });

  it('the glyph is 18px and the strip uses the theme colors', () => {
    expect(css).toMatch(/\.cell-ptz svg\s*\{[^}]*18px/);
    expect(css).toMatch(/\.cell-ptz-faixa\s*\{[^}]*var\(--muted\)/);
    expect(css).toMatch(/\.cell-ptz-faixa\.erro\s*\{[^}]*var\(--color-danger\)/);
  });

  // spec 2026-10-17: the right-sidebar panel. The disc, the single list scroll and the dots hover are the
  // three shapes jsdom does not measure — the guard pins the lines that produce them.
  it('the PTZ panel has a disc, a single list scroll and menu reveal', () => {
    expect(css).toMatch(/\.ptz-joystick\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.ptz-seta\s*\{[^}]*rotate\(var\(--giro\)\)/);
    expect(css).toMatch(/\.ptz-lista\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.ptz-linha:hover\s+\.cam-dots\s*\{[^}]*opacity:\s*1/);
    expect(css).toMatch(/\.rightpanel\.ptz\s*\{[^}]*overflow:\s*hidden/);
  });

  it('the panel does not reuse the classes the collapsed left sidebar hides', () => {
    // .shell.rec-esq hides .sidebar-rolagem and the header .busca ANYWHERE in the shell: reusing those two
    // in the right panel would make the list and the header disappear with the left sidebar collapsed.
    const panel = css.slice(css.indexOf('.painel-ptz'));
    expect(panel).not.toContain('sidebar-rolagem');
    expect(panel).not.toContain('sidebar-head');
  });

  // spec 2026-10-17: the zoom pair sits on the SAME LINE as the label (geometry of the speed row) and the
  // Center class left with the button — dead style without a consumer is the same defect as a dead click.
  it('the zoom block is a row with the pair on the right and there is no Center style', () => {
    expect(css).toMatch(/\.ptz-zoom\s*\{[^}]*display:\s*flex/);
    expect(css).not.toMatch(/\.ptz-zoom\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/\.ptz-zoom-par\s*\{[^}]*flex:\s*1 1 auto/);
    expect(css.includes('ptz-centralizar')).toBe(false);
  });

  // spec 2026-10-19 (Nx parity): hollow circle in the center of the rectangle — stroke only (addEllipse of
  // FixedArSelectionItem::paint and no brush), 1.5 pen, rectangle color lightened (lighter(120)).
  it('the center circle of the rectangle is hollow, with a 1.5 stroke and round circle corners', () => {
    expect(css).toMatch(/\.ptz-selecao-circulo\s*\{[^}]*border-radius:\s*50%/);
    expect(css).toMatch(/\.ptz-selecao-circulo\s*\{[^}]*border:\s*1\.5px solid/);
    expect(css).toMatch(/\.ptz-selecao-circulo\s*\{[^}]*background:\s*transparent/);
  });
});

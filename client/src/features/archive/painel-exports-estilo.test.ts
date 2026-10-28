import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// plan 2026-10-25: the right panel cannot scroll horizontally. The export status is TEXT
// (a pill) and not the 7 px dot of the cameras' .badge. The truncated description opens a tooltip ABOVE.
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

describe('cartão de exportação no painel direito', () => {
  it('o status é pílula de texto, escopada no cartão (o .badge das câmeras segue ponto de 7 px)', () => {
    expect(css).toMatch(/\.painel-exports-nome \.badge\s*\{[^}]*width:\s*auto/);
    expect(css).toMatch(/\.painel-exports-nome \.badge\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.painel-exports-nome \.badge\s*\{[^}]*flex:\s*0 0 auto/);
    expect(css).toMatch(/\.badge\s*\{[^}]*width:\s*7px/);   // the camera tree does not change
  });

  it('a descrição trunca com reticências e guarda o texto completo para o tooltip', () => {
    expect(css).toMatch(/\.painel-exports-nome-texto\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.painel-exports-nome-texto\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.painel-exports-nome-texto\[data-dica\]:hover::after\s*\{[^}]*content:\s*attr\(data-dica\)/);
  });

  it('o tooltip abre ACIMA da linha (não cobre câmera nem período)', () => {
    expect(css).toMatch(/\.painel-exports-nome-texto\[data-dica\]:hover::after\s*\{[^}]*bottom:\s*calc\(100% \+ 3px\)/);
    expect(css).toMatch(/\.painel-exports-nome\s*\{[^}]*position:\s*relative/);
  });

  it('nada rola na horizontal', () => {
    expect(css).toMatch(/\.painel-exports ul\s*\{[^}]*overflow-x:\s*hidden/);
    expect(css).toMatch(/\.panel dl\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.panel dd\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

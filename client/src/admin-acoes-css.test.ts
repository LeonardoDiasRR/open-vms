import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// spec 2026-10-18 (tabs CTA/pagination/hover): jsdom does not apply the stylesheet, so this guard
// reads styles.css as TEXT, in the shape of divisor.test.ts, and pins the rules the probe measured.
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const block = (sel: string) => new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css)?.[1] ?? '';

describe('Administration tabs: rules outside a layer (spec 2026-10-18 tabs)', () => {
  it('the footer select shrinks to its content with the TWO-class rule (nx-port pattern)', () => {
    expect(block('.nx-input.nx-largura-auto')).toMatch(/width:\s*auto/);
  });

  it('the per-type hovers use the existing tokens, with no new hex', () => {
    expect(block('.nx-acao-editar:hover, .nx-acao-ativar:hover')).toMatch(/color:\s*var\(--accent\)/);
    expect(block('.nx-acao-bloquear:hover, .nx-acao-reset:hover')).toMatch(/color:\s*var\(--warn\)/);
    expect(block('.nx-acao-excluir:hover')).toMatch(/color:\s*var\(--danger\)/);
  });
});

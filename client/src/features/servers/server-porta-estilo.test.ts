import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// spec 2026-10-30 (servidor-porta-login-modal): as regras da linha Server+Port e do card da
// modal de servidor. O padrao de leitura de styles.css e o de login-estilo.test.ts.
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

describe('linha Server+Port e card da modal (spec 2026-10-30)', () => {
  it('as regras da linha Server+Port existem', () => {
    expect(css).toMatch(/\.server-port-row\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.server-port-row \.sp-port\s*\{[^}]*width:\s*90px/);
  });
  it('o card da modal tem o raio do login e o padding do login', () => {
    expect(css).toMatch(/\.nx-dialog-cartao\s*\{[^}]*border-radius:\s*var\(--radius-lg\)/);
    expect(css).toMatch(/\.nx-cartao\s*\{[^}]*padding:\s*20px/);
    // a ordem importa: .nx-dialog-cartao vem DEPOIS de .nx-dialog (empate de especificidade,
    // quem vence e a ordem no arquivo)
    expect(css.indexOf('.nx-dialog-cartao')).toBeGreaterThan(css.indexOf('border-radius: var(--radius-sm)'));
  });
  it('o seletor de labels cobre o login e o card', () => {
    expect(css).toMatch(/\.login-card label,\s*\.nx-cartao label\s*\{/);
  });
});

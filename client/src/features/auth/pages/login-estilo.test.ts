import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// plan 2026-10-26: the login submit is the CTA (padding from the approved prototype) and no
// descendant rule inside the card may reach the password eye — it used to push it 4 px down.
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

describe('login: CTA e olho centrado (plan 2026-10-26)', () => {
  it('o submit usa o seletor direto, com o padding do CTA', () => {
    expect(css).toMatch(/\.login-card > button\s*\{[^}]*padding:\s*10px/);
  });

  it('nenhuma regra do login alcança o olho por descendência', () => {
    expect(css).not.toMatch(/\.login-card button\s*\{/);
  });

  it('o hover do CTA usa o token, não um hex solto na regra', () => {
    expect(css).toMatch(/--accent-hover:\s*#1ad191/);
    expect(css).toMatch(/\.login-card > button:hover\s*\{[^}]*background:\s*var\(--accent-hover\)/);
  });
});

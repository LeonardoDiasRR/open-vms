import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// Scan of PRODUCTION files (this guard's own file is not included: the filter excludes any *.test.*,
// the same shape as dialogo-invariante.test.ts).
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const css = () => readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8');

describe('modal invariant (spec 2026-10-17)', () => {
  it('every file that renders .nx-dialog also renders .nx-close', () => {
    // NAMED exception (spec 2026-10-19 onboarding D3/§5.5): the first-run wizard has no ✕ and no
    // Esc — no way out until both steps are done. A named exception is auditable; the scan keeps
    // applying to everything else (including TrocaSenhaObrigatoria).
    const NO_CLOSE = ['features/auth/components/WizardOnboarding.tsx'];
    const offences = tsFiles(join(process.cwd(), 'src'))
      .filter((f) => { const t = readFileSync(f, 'utf8'); return t.includes('nx-dialog') && !t.includes('nx-close'); })
      .filter((f) => !NO_CLOSE.some((e) => f.split(/[\\/]/).join('/').endsWith(e)));
    expect(offences).toEqual([]);
  });

  it('the actions row sits in the right corner, with a 14px margin when it is a direct child', () => {
    const t = css();
    expect(t.match(/\.nx-actions \{[^}]*\}/)?.[0] ?? '').toContain('justify-content: flex-end');
    expect(t.match(/\.nx-dialog > \.nx-actions \{[^}]*\}/)?.[0] ?? '').toContain('padding: 0 14px 14px');
  });

  it('the .nx-btn-perigo block comes AFTER .nx-btn (order decides the color)', () => {
    const t = css();
    expect(t.indexOf('.nx-btn-perigo')).toBeGreaterThan(t.indexOf('.nx-btn {'));
  });
});

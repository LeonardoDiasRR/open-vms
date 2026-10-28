import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Tooltip guard (spec 2026-10-18, item 3): every actionable control that shows only an icon carries a
// title with the action. The table is LITERAL on purpose (design-tokens.test.ts pattern): a new icon
// button enters the table in the same PR that gives it the title.
const ROOT = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// [file, expected literal expression, occurrences]
const EXACT: Array<[string, string, number]> = [
  ['features/cameras/components/CameraTree.tsx', "title={t('cameras.options', { name: n.name })}", 3],
  ['features/layouts/components/LayoutTree.tsx', "title={t('layouts.options', { name: l.name })}", 1],
  ['features/live/components/PainelPtz.tsx', "title={t('live.ptz.options', { name: p.name })}", 1],
  ['shared/ui/SearchField.tsx', "title={t('shared.clear_search')}", 1],
  ['features/cameras/components/ResultadosDescoberta.tsx', 'title={`Channels of ${r.ip}`}', 1],
  ['shared/ui/UserMenu.tsx', "title={t('topbar.user_menu')}", 1],
];

// [file, minimum of title= in the file] — the dynamic titles of these files do not fit as a single
// string literal; the minimum locks in that no tooltip from the spec disappeared in a refactor.
const MINIMUMS: Array<[string, number]> = [
  ['features/archive/components/BottomSheet.tsx', 2],   // strip (spec 2026-10-19): the open/close button's title= died with the button
  ['features/archive/components/PlayerGravacao.tsx', 9],
  ['features/design/CatalogoDesign.tsx', 5],
];

describe('tooltip guard (spec 2026-10-18 item 3)', () => {
  it('each icon button of the table has the exact expected title', () => {
    for (const [file, expected, n] of EXACT) {
      const hits = read(file).split('\n').filter((line) => line.includes(expected)).length;
      expect(hits, `${file}: expected title x${n}`).toBe(n);
    }
  });

  it('each file of the minimum table keeps the spec titles', () => {
    for (const [file, minimum] of MINIMUMS) {
      const hits = read(file).split('\n').filter((line) => line.includes('title=')).length;
      expect(hits, `${file}: title= x${minimum}`).toBeGreaterThanOrEqual(minimum);
    }
  });
});

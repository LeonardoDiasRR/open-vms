import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Static responsiveness guard (spec 2026-10-17, section "Responsividade operacional").
// jsdom does NOT compute media queries: this guard reads the stylesheet as TEXT and pins the two width
// rules (below 1280 the right panel collapses itself; below 1024, the left one too). The real
// measurement is in the browser, at the wave gate — here it proves the rule is WRITTEN and that it does
// not apply with the PTZ instrument armed.
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

// Every @media block with a width, in the order it appears in the file.
const blocks = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/g)]
  .map((m) => ({ px: m[1], body: m[2] }));

const dirBlock = blocks.find((b) => b.px === '1279')!;
const esqBlock = blocks.find((b) => b.px === '1023')!;

describe('operational responsiveness (spec 2026-10-17, M4)', () => {
  it('the two self-collapse widths exist, in this order, and there is no other', () => {
    // '480' is the login-only block (login/i18n session, d46a9a5..6dd7057): it styles `.login`,
    // never the shell, so it does not enter the collapse contract.
    expect(blocks.map((b) => b.px)).toEqual(['480', '1279', '1023']);
    expect(dirBlock.body).toMatch(/--col-dir:\s*32px/);
    expect(esqBlock.body).toMatch(/--col-esq:\s*32px/);
  });

  it('the right panel does NOT self-collapse with PTZ armed', () => {
    // decision 4.3 of the PTZ panel spec keeps the bar open while the mode is on; the width rule
    // excludes the shell that has the panel. The left one has no exception at all.
    expect(dirBlock.body).toMatch(/:not\(:has\(\.rightpanel\.ptz\)\)/);
    expect(esqBlock.body).toMatch(/\.shell\s*\{/);
    expect(esqBlock.body).not.toMatch(/:has\(/);
  });

  it('the width response introduces no scrolling in the shell', () => {
    // shell invariant preserved: the width @media do not touch overflow
    for (const b of blocks) expect(b.body).not.toMatch(/\.shell\s*\{[^}]*overflow/);
  });

  it('each width really COLLAPSES: hides the content and re-centers the header', () => {
    // the column width alone does not collapse: the panel becomes a 32px strip with 42px content
    // inside, with horizontal scrolling. The declarations have to be the SAME ones `.shell.rec-*`
    // uses — without this assertion, deleting the `display: none` would keep the guard green and the
    // delivery broken.
    expect(dirBlock.body).toMatch(/\.rightpanel\s*>\s*\*:not\(\.rightpanel-head\)\s*\{\s*display:\s*none/);
    expect(dirBlock.body).toMatch(/\.rightpanel-head\s*\{[^}]*justify-content:\s*center/);
    expect(esqBlock.body).toMatch(/\.sidebar-rolagem[^}]*display:\s*none/);
    expect(esqBlock.body).toMatch(/\.sidebar-head\s*\{[^}]*justify-content:\s*center/);
    // spec 2026-10-17 (search in the header): the content hidden in the 32px strip is now the header
    // search `.busca` — the old `.sidebar-head > span` line is gone.
    expect(css).toMatch(/\.shell\.rec-esq\s+\.sidebar-head\s+\.busca\s*\{[^}]*display:\s*none/);
    expect(esqBlock.body).toMatch(/\.sidebar-head\s+\.busca\s*\{[^}]*display:\s*none/);
  });

  // spec 2026-10-17 (item 2): in full screen with PTZ armed the `fixed` strip covers the image. The
  // fix is to RESERVE the space in the content box the video measures (`100cqw`), never reposition
  // the strip. Measured in Chromium with the compiled CSS: without the rule the box takes 0->1280 and
  // the strip sits at x=1005->1265 (overlap); with it the box becomes 1020x574 (1.778 ratio) and the
  // strip moves to x=1020->1280 (no overlap).
  it('full screen with PTZ RESERVES the strip with padding and the strip stays fixed', () => {
    const rule = /\.stream-cell:fullscreen\.ptz-ativo\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/padding-right:\s*var\(--col-dir,\s*260px\)/);
    expect(css).toMatch(/\.cell-painel-ptz\s*\{[^}]*position:\s*fixed/);
    // The discarded variant (turning it into a grid would make `100cqw` measure the whole cell and the
    // image overflow the column) is looked up OUTSIDE the comments: the rule's own comment quotes the
    // discarded form to record the decision, and a free-text predicate would match itself.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/grid-template-columns: 1fr var\(--col-dir\)/);
  });
});

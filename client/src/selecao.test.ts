import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import LiveView, { clearLiveViewSnapshot } from './features/live/pages/LiveView';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LanguageProvider } from './shared/i18n';

// spec 2026-10-18 (6.1, items 1 to 5 and 8): the selection state lives in LiveView (4.2), so the click
// cycle and the snapshot can only be proven with LiveView mounted. `LiveView.test.tsx` is not in the
// spec's "Files touched" table and therefore is not touched (amendment E2). The cell enters through the
// saved layout path and has NO camera: without StreamCell there is no WebRTC in jsdom.
// ponytail: the file is `.test.ts` (spec §5 and amendment E3) and the vite loader does not accept JSX in
// `.ts`; the four mounts use `createElement` to fit the pinned name, without changing a case or an
// assertion. The provider wraps every mount because the stage reads its strings from the dictionary.
// spec 2026-10-18 (1s wait, cell size) + amendment 2026-10-18 (Nx way): NO size change is immediate.
// The border appears on the click; the size comes SIZE_WAIT_MS after the LAST click. The cases use fake
// timers and `advance()` to measure the delay; the border assertions wait for nothing.
import { SIZE_WAIT_MS } from './shared/hooks/useSelecaoCelula';
const api = {
  liveToken: async () => ({ whep_url: 'http://127.0.0.1:8890/uuid/whep', token: 'tk', expires_in: 60 }),
  profiles: () => Promise.resolve([]),
  saveLayout: () => Promise.resolve({ id: 'L1', name: 'Layout 1' }),
};
const layout = {
  id: 'L1', name: 'Layout 1',
  cells: [
    { id: 'a', col: 0, row: 0, colspan: 1, rowspan: 1 },
    { id: 'b', col: 1, row: 0, colspan: 1, rowspan: 1 },
  ],
};
const open = () => render(createElement(LanguageProvider, null,
  createElement(LiveView, { api, cameras: [], layouts: [layout], openRequest: layout })));
const cells = (c: HTMLElement) => [...c.querySelectorAll('.stage-cell')] as HTMLElement[];
// the size delay: SIZE_WAIT_MS from the hook (300 ms, Nx way). Outside act React does not commit the setState.
const advance = (ms = SIZE_WAIT_MS) => act(() => { vi.advanceTimersByTime(ms); });

describe('selected cell: the click cycle (spec 2026-10-18 + 1 s wait)', () => {
  beforeEach(() => { vi.useFakeTimers(); clearLiveViewSnapshot(); });
  afterEach(() => { vi.useRealTimers(); });

  it('1st click puts the border up at once; the expansion arrives 1 s later; the 2nd shrinks 1 s later; the 3rd expands 1 s later', () => {
    const { container } = open();
    const [a] = cells(container);

    fireEvent.click(a);
    expect(a.className).toContain('selecionada');
    expect(a.className).not.toContain('ampliada');
    advance();
    expect(a.className).toContain('ampliada');

    fireEvent.click(a);
    expect(a.className).toContain('ampliada');
    advance();
    expect(a.className).toContain('selecionada');
    expect(a.className).not.toContain('ampliada');

    fireEvent.click(a);
    advance();
    expect(a.className).toContain('ampliada');
  });

  it('two fast clicks on the expanded cell do not change the size (they open the way for dblclick)', () => {
    const { container } = open();
    const [a] = cells(container);
    fireEvent.click(a); advance();            // expanded, committed
    fireEvent.click(a); fireEvent.click(a);   // schedules shrink; the 2nd flips it back to expand
    advance(3000);
    expect(a.className).toContain('selecionada');
    expect(a.className).toContain('ampliada');
  });

  it('spaced clicks complete both toggles, each 1 s later', () => {
    const { container } = open();
    const [a] = cells(container);
    fireEvent.click(a); advance();            // expands
    fireEvent.click(a); advance();            // shrinks
    fireEvent.click(a); advance();            // expands again
    expect(a.className).toContain('ampliada');
  });

  it('click on another cell: the old one loses border and size at once; the new one expands 1 s later', () => {
    const { container } = open();
    const [a, b] = cells(container);
    fireEvent.click(a); advance();            // the expanded one, pending dead
    fireEvent.click(b);
    expect(a.className).not.toContain('selecionada');
    expect(a.className).not.toContain('ampliada');
    expect(b.className).toContain('selecionada');
    expect(b.className).not.toContain('ampliada');
    advance();
    expect(b.className).toContain('ampliada');
  });

  it('click on the empty area of the stage clears at once, even with a live pending', () => {
    const { container } = open();
    const [a] = cells(container);
    fireEvent.click(a);
    expect(a.className).toContain('selecionada');
    fireEvent.click(container.querySelector('.stage-grid') as HTMLElement);
    expect(a.className).not.toContain('selecionada');
    expect(a.className).not.toContain('ampliada');
    advance(3000);
    expect(a.className).not.toContain('ampliada');   // the pending died with the clearing
  });

  it('click on the cell action button does not touch the selection', () => {
    const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [] };
    const withCamera = {
      ...layout,
      cells: [{ id: 'a', col: 0, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: 'c1' } }],
    };
    const { container } = render(createElement(LanguageProvider, null,
      createElement(LiveView, { api, cameras: [cam], layouts: [withCamera], openRequest: withCamera })));
    const cell = container.querySelector('.stage-cell') as HTMLElement;
    fireEvent.click(cell);
    advance();                                             // the size now waits for the delay
    expect(cell.className).toContain('ampliada');
    // the ⛶ (PTZ only exists with an image on screen); remove does not help here: it takes the cell out of the DOM
    fireEvent.click(cell.querySelector('.cell-actions button') as HTMLElement);
    expect(cell.isConnected).toBe(true);
    expect(cell.className).toContain('selecionada');
    expect(cell.className).toContain('ampliada');
  });

  it('the selection and the expansion survive the second mount and die on logout', () => {
    const first = open();
    const [a] = cells(first.container);
    fireEvent.click(a); advance();
    expect(a.className).toContain('ampliada');
    first.unmount();

    // second mount: the App unmounts the stage when switching Live/Archive — the snapshot gives back tabs AND selection
    const second = render(createElement(LanguageProvider, null, createElement(LiveView, { api, cameras: [] })));
    const [a2] = cells(second.container);
    expect(a2.className).toContain('selecionada');
    expect(a2.className).toContain('ampliada');
    second.unmount();

    clearLiveViewSnapshot();
    const third = render(createElement(LanguageProvider, null, createElement(LiveView, { api, cameras: [] })));
    expect(third.container.querySelector('.stage-cell')).toBeNull();
    expect(screen.getByText('Drag a camera here')).toBeInTheDocument();
  });

  // spec 2026-10-18-celula-maximizada-60 (section 3.2): leaving the selection is no longer only the empty
  // stage area. This pair is the oracle: the first case fails on today's code (there is no listener on
  // `document`) and the second one keeps the clearing from going too far.
  it('click outside the cell, on the tab bar, clears the selection and gives the size back', () => {
    const { container } = open();
    const [a] = cells(container);
    fireEvent.click(a); advance();
    expect(a.className).toContain('ampliada');

    fireEvent.click(container.querySelector('.stage-tabs') as HTMLElement);

    expect(a.className).not.toContain('selecionada');
    expect(a.className).not.toContain('ampliada');
  });

  it('click on the armed PTZ right panel does NOT clear the selection', () => {
    const { container } = open();
    const [a] = cells(container);
    fireEvent.click(a); advance();
    expect(a.className).toContain('ampliada');

    // the real right panel lives in the App, outside the LiveView subtree. The listener is on `document`
    // and reads the class from the click target, so a decoy with the class is enough.
    const panel = document.createElement('aside');
    panel.className = 'rightpanel ptz';
    document.body.appendChild(panel);
    try {
      fireEvent.click(panel);
      expect(a.className).toContain('selecionada');
      expect(a.className).toContain('ampliada');
    } finally {
      panel.remove();
    }
  });
});

// spec 2026-10-18 (1s wait, cell size, rules 5, 6 and 7): full screen rules the size while it lasts.
// jsdom does not implement `fullscreenElement`: the mock is a configurable getter, restored at the end.
function mockFullscreen() {
  const own = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
  let el: Element | null = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el });
  return {
    enter(target: Element = document.body) { el = target; fireEvent(document, new Event('fullscreenchange')); },
    exit() { el = null; fireEvent(document, new Event('fullscreenchange')); },
    restore() {
      if (own) Object.defineProperty(document, 'fullscreenElement', own);
      else delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
    },
  };
}

describe('selected cell: full screen rules the size (spec espera-1s)', () => {
  beforeEach(() => { vi.useFakeTimers(); clearLiveViewSnapshot(); });
  afterEach(() => { vi.useRealTimers(); });

  it('entering cancels the pending; leaving shrinks the selected one at once', () => {
    const fs = mockFullscreen();
    try {
      const { container } = open();
      const [a] = cells(container);
      fireEvent.click(a); advance();          // expanded, committed
      fireEvent.click(a);                     // pending: would shrink in 1 s
      fs.enter(a);                            // entering: pending cancelled
      advance(3000);
      expect(a.className).toContain('ampliada');   // nothing shrank during full screen
      fs.exit();
      expect(a.className).toContain('selecionada');
      expect(a.className).not.toContain('ampliada'); // leaving: shrinks at once
    } finally {
      fs.restore();
    }
  });

  it('a click during full screen schedules nothing', () => {
    const fs = mockFullscreen();
    try {
      const { container } = open();
      const [a] = cells(container);
      fs.enter(a);
      fireEvent.click(a);
      fs.exit();
      expect(a.className).not.toContain('selecionada');   // the click from inside did not even mark
      fireEvent.click(a);                                 // outside full screen: marks + schedules
      expect(a.className).toContain('selecionada');
      expect(a.className).not.toContain('ampliada');
      fs.enter(a);                                        // enters again: cancels the pending
      advance(3000);
      expect(a.className).not.toContain('ampliada');
    } finally {
      fs.restore();
    }
  });
});

// Static guard of the selected cell CSS (spec 2026-10-18, 6.2), in the shape of responsividade.test.ts:
// jsdom neither applies container queries nor draws borders, so this guard reads the stylesheet as TEXT
// and pins what the drawing promises (border in var(--accent), spacing in cqh/cqw, two separate rules).
// The px measurement happens in the browser, at acceptance.
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const block = (sel: string) => new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css)?.[1] ?? '';

describe('selected cell: CSS guard (spec 2026-10-18)', () => {
  it('the stage has the maximized inset in a variable, with the unit in the value', () => {
    // spec 2026-10-18-celula-maximizada-60 (plan amendment 1): the unit lives in the VARIABLE VALUE, not
    // in the `inset` rule. 20% of inset = the cell takes the central 60% of the stage.
    const stage = block('.stage-grid');
    expect(stage).toMatch(/container-type:\s*size/);
    expect(stage).toMatch(/--ampliacao:\s*20%/);
  });

  it('the border is a 2px green ring, and the z-index puts the cell in front', () => {
    expect(block('.stage-cell.selecionada')).toMatch(/z-index:\s*3/);
    // spec 2026-10-18-borda-selecao-arquivo: the rule became a list of two anchors; the block is the same,
    // pinned by the final selector (`.cell-quadro::after` now ends with a comma).
    const ring = block('.stage-cell.selecionada .celula-playback::after');
    expect(ring).toMatch(/border:\s*2px solid var\(--accent\)/);
    expect(ring).toMatch(/inset:\s*0/);
    expect(ring).toMatch(/pointer-events:\s*none/);
  });

  it('the maximized one is a stage layer: absolute, with the variable inset and no margin', () => {
    const layer = block('.stage-cell.ampliada');
    // the percentage `inset` of the stage is what guarantees the "does not go past the limits" requirement
    expect(layer).toMatch(/position:\s*absolute/);
    expect(layer).toMatch(/inset:\s*var\(--ampliacao\)/);
    // `transform: scale` would create a containing block for the context menu, which is `position: fixed`.
    // The ban REMAINS (spec 3.1).
    expect(layer).not.toMatch(/transform/);
    // the old spacing was a `margin` in cq; the new model has no margin at all
    expect(layer).not.toMatch(/margin/);
  });

  it('border and spacing are SEPARATE rules: marking does not depend on the size', () => {
    const marked = block('.stage-cell.selecionada');
    const spacing = block('.stage-cell.ampliada');
    // both blocks have to exist: without this assertion the guard would be green with the rules deleted
    expect(marked).not.toBe('');
    expect(spacing).not.toBe('');
    expect(marked).not.toMatch(/margin/);
    expect(spacing).not.toMatch(/border/);
  });
});

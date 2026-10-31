import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import { SIZE_WAIT_MS } from '@/shared/hooks/useSelecaoCelula';

// The real player (MSE) does not live in jsdom: it records profile/covered as the page passed them
// and answers `sample()` from a per-profile fixture (wall coordinator tests below).
type FakeSample = { epoch: number; ready: boolean; presentedAt: number; nextEpoch?: number };
const spy = vi.hoisted(() => ({ props: [] as Record<string, unknown>[], samples: {} as Record<string, unknown> }));
vi.mock('../components/PlayerGravacao', async () => {
  const React = await import('react');
  const Comp = React.forwardRef((props: Record<string, unknown>, ref) => {
    spy.props.push(props);
    // the handle outlives the render: sample() has to read the CURRENT props, not the mount ones
    const cur = React.useRef(props); cur.current = props;
    React.useImperativeHandle(ref, () => ({ seek: () => {}, toggle: () => {}, play: () => {}, now: () => {},
      speed: () => 1, setSpeed: () => {},
      sample: (): FakeSample => {
        const s = spy.samples[String(cur.current.profile)];
        if (typeof s === 'function') return (s as (p: Record<string, unknown>) => FakeSample)(cur.current);
        return (s as FakeSample) ?? { epoch: Number(cur.current.resumeTs) || 0, ready: false, presentedAt: 0 };
      } }));
    return React.createElement('div', { className: 'player-fake', 'data-perfil': String(props.profile),
      'data-coberto': String(props.covered) });
  });
  return { default: Comp, SPEEDS: [1, 2, 4] };
});

// The page has no UI for the skip policy (the clock is born with skipGaps ON): keep the REAL hook and
// only expose its setter, so the "skipGaps off" case exercises the page's own decision.
const clockCtl = vi.hoisted(() => ({ setSkipGaps: null as null | ((b: boolean) => void) }));
vi.mock('../hooks/useRelogioGlobal', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useRelogioGlobal')>('../hooks/useRelogioGlobal');
  return { ...actual, useGlobalClock: (q: Parameters<typeof actual.useGlobalClock>[0]) => {
    const c = actual.useGlobalClock(q);
    clockCtl.setSkipGaps = c.setSkipGaps;
    return c;
  } };
});

import ArchiveView, { clearArchiveSnapshot } from './ArchiveView';

const MIDNIGHT = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);
const camC1 = { id: 'c1', name: 'Cam 1', state: 'online', profile_ids: ['p-c1'], recording_profile_id: 'rp-c1' };
const camC2 = { id: 'c2', name: 'Cam 2', state: 'online', profile_ids: ['p-c2'], recording_profile_id: 'rp-c2' };
const timeline = vi.fn();
const api = { base: 'b', token: 't', cameras: [camC1, camC2], groups: [], timeline,
  exportRange: vi.fn(async () => ({ id: 'j1', state: 'queued' as const, from_ts: 0, to_ts: 600 })) };

const renderView = (ui: React.ReactElement) => render(ui, { wrapper: LanguageProvider });

beforeEach(() => {
  clearArchiveSnapshot();
  // spec 2026-10-27 (sheet-expandido-default): os testes antigos foram escritos com o sheet
  // nascendo fechado; o seed preserva o que eles exercitam. Os casos novos cobrem a regra nova.
  localStorage.setItem('openvms.sheet', 'false');
  spy.props.length = 0;
  for (const k of Object.keys(spy.samples)) delete spy.samples[k];
  clockCtl.setSkipGaps = null;
  timeline.mockReset();
  timeline.mockResolvedValue({ buckets: [{ t: MIDNIGHT + 3600, fraction: 1 }], bucket_seconds: 60, gravando: false });
});

describe('ArchiveView (playback stage + Bottom Sheet)', () => {
  it('keeps the same player DOM across multiple 120-second boundaries and explicit seeks', async () => {
    const { container } = renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    await waitFor(() => expect(container.querySelector('.player-fake')).not.toBeNull());
    const player = container.querySelector('.player-fake');
    for (let i = 0; i < 55; i++) fireEvent.keyDown(window, { code: 'ArrowRight' });
    expect(container.querySelector('.player-fake')).toBe(player);
    expect(spy.props.at(-1)?.seekRequest).toEqual(expect.objectContaining({ id: expect.any(Number) }));
  });
  // correction 2026-10-26: the playback cell menu has the same three actions as the live cell.
  it('the cell menu has settings, rename and remove, and forwards the two actions', async () => {
    const onConfig = vi.fn();
    const onRename = vi.fn();
    const { container } = renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }}
      onRequestConsumed={() => {}} onConfig={onConfig} onRename={onRename} />);
    await waitFor(() => expect(container.querySelector('.celula-playback')).not.toBeNull());
    fireEvent.contextMenu(container.querySelector('.celula-playback') as HTMLElement);
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Camera settings', 'Rename', 'Remove from layout']);
    fireEvent.click(screen.getByText('Rename'));
    expect(onRename).toHaveBeenCalledWith('c1', 'Cam 1');
    fireEvent.contextMenu(container.querySelector('.celula-playback') as HTMLElement);
    fireEvent.click(screen.getByText('Camera settings'));
    expect(onConfig).toHaveBeenCalledWith('c1', 'Cam 1');
  });
  // spec 2026-10-19 (video-export): the page OWNS the modal state; the sheet only notifies.
  it('the Export button of the sheet opens the export dialog', async () => {
    renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    const btn = await screen.findByRole('button', { name: 'Export' });
    fireEvent.click(btn);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Export video')).toBeInTheDocument();
    // the dialog dropdown lists the stage camera with the recording profile (recording_profile_id)
    expect(await screen.findByLabelText('Camera')).toHaveValue('rp-c1');
  });

  // defect 2026-10-25: the export created in the dialog has to reach App (right panel).
  it('repassa ao App o aviso de exportacao criada', async () => {
    const notice = vi.fn();
    renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} onExportsChanged={notice} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'Fuga' } });
    // explicit period: the default (30 min until now) becomes invalid when running right after midnight
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '10:00' } });
    fireEvent.change(within(dialog).getByLabelText('End time'), { target: { value: '10:25' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(notice).toHaveBeenCalledTimes(1));
  });

  it('no toolbar: only the stage and the collapsed sheet', () => {
    const { container } = renderView(<ArchiveView api={api as never} />);
    expect(screen.queryByRole('button', { name: /Individual|Wall|today/i })).toBeNull();
    expect(container.querySelector('.stage-grid')).toBeInTheDocument();
    expect(container.querySelector('.sheet')).toBeInTheDocument();
    expect(container.querySelector('.sheet-calendario')).toBeNull();
  });

  // spec 2026-10-27 (sheet-expandido-default): default expanded; collapsing is a choice and persists.
  it('sem chave gravada o sheet nasce expandido', () => {
    localStorage.removeItem('openvms.sheet');
    const { container } = renderView(<ArchiveView api={api as never} />);
    expect(container.querySelector('.sheet-aberto')).not.toBeNull();
  });
  it('chave "false" (usuário recolheu) monta recolhido — sobrevive ao reload', () => {
    localStorage.setItem('openvms.sheet', 'false');
    const { container } = renderView(<ArchiveView api={api as never} />);
    expect(container.querySelector('.sheet-aberto')).toBeNull();
  });
  it('o toggle grava a escolha na chave', async () => {
    localStorage.removeItem('openvms.sheet');
    renderView(<ArchiveView api={api as never} />);
    // plan deviation (adapted here, source untouched): with the key removed the sheet is born
    // expanded, and the open band has aria-label "Close options" (BottomSheet.tsx:41). The first
    // click collapses; the second, with the band as "More options", reopens it.
    fireEvent.click(await screen.findByRole('button', { name: 'Close options' }));
    expect(localStorage.getItem('openvms.sheet')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(localStorage.getItem('openvms.sheet')).toBe('true');
  });
  it('chave corrompida cai no default expandido', () => {
    localStorage.setItem('openvms.sheet', 'x');
    const { container } = renderView(<ArchiveView api={api as never} />);
    expect(container.querySelector('.sheet-aberto')).not.toBeNull();
  });

  it('the cameras request enters the stage without duplicating', async () => {
    const consumed = vi.fn();
    const { container } = renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1', 'c1'] }} onRequestConsumed={consumed} />);
    await waitFor(() => expect(container.querySelectorAll('.stage-cell')).toHaveLength(1));
    expect(consumed).toHaveBeenCalled();
  });

  it('the layout request opens the TAB of the layout with the saved geometry', async () => {
    const { container } = renderView(<ArchiveView api={api as never} onRequestConsumed={() => {}}
      openRequest={{ id: 'L1', name: 'X', cells: [{ id: 'a', col: 0, row: 0, colspan: 2, rowspan: 1, content: { kind: 'live', camera_id: 'c1' } }] }} />);
    await waitFor(() => expect(container.querySelector('.stage-cell')?.getAttribute('style')).toContain('span 2'));
    // spec 2026-10-18 videowall-recording-tabs (revokes D6): the geometry lives in a TAB named after the layout
    expect(container.querySelector('.stage-tab.active')?.textContent).toContain('X');
  });

  it('coverage requested for the whole day, with the recording profile', async () => {
    renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    await waitFor(() => expect(timeline).toHaveBeenCalledWith(expect.objectContaining(
      { from: MIDNIGHT, to: MIDNIGHT + 86400, bucket_seconds: 60, stream_profile_id: 'rp-c1' })));
  });

  it('playhead without coverage: the cell marks covered=false (no playlist request)', async () => {
    timeline.mockResolvedValue({ buckets: [], bucket_seconds: 60, gravando: false });
    const { container } = renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    await waitFor(() => expect(container.querySelector('.player-fake')?.getAttribute('data-coberto')).toBe('false'));
  });

  it('the sheet expands with tracks and a date picker; changing the day refetches the coverage', async () => {
    const { container } = renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    await waitFor(() => expect(timeline).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(container.querySelector('.sheet-calendario')).toBeNull();
    expect(container.querySelector('.timeline-global')).toBeInTheDocument();
    const input = container.querySelector('input[type=date]') as HTMLInputElement;
    expect(input).not.toBeNull();
    // yesterday local, formatted LOCAL (the input is a date: value in YYYY-MM-DD)
    const otherDay = MIDNIGHT - 86400;
    const d = new Date(otherDay * 1000);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    fireEvent.change(input, { target: { value } });
    await waitFor(() => expect(timeline).toHaveBeenCalledWith(expect.objectContaining({ from: otherDay })));
  });

  it('clicking the cell marks the track; clicking the sheet KEEPS the border; the stage background unmarks', async () => {
    const { container } = renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    await waitFor(() => expect(container.querySelector('.stage-cell')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const cell = container.querySelector('.stage-cell') as HTMLElement;
    fireEvent.click(cell);
    expect(container.querySelector('.trilha[data-camera="c1"].selecionada')).not.toBeNull();
    // spec 2026-10-19 (selection-sheet-floating-fullscreen, B1): `.sheet` is the third exception of
    // the document listener — using the sheet does NOT drop the track border (inverted oracle: the
    // old bug behavior was exactly asserting toBeNull here)
    fireEvent.click(container.querySelector('.sheet-relogio') as HTMLElement);
    expect(container.querySelector('.trilha[data-camera="c1"].selecionada')).not.toBeNull();
    // deselection is now proven by clicking the stage background (outside the cell and the sheet)
    fireEvent.click(container.querySelector('.arquivo-stage') as HTMLElement);
    expect(container.querySelector('.trilha[data-camera="c1"].selecionada')).toBeNull();
  });

  it('the snapshot survives unmount; clearing zeroes it', async () => {
    const { container, unmount } = renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c2'] }} onRequestConsumed={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.stage-cell')).toHaveLength(1));
    unmount();
    const r2 = renderView(<ArchiveView api={api as never} />);
    await waitFor(() => expect(r2.container.querySelectorAll('.stage-cell')).toHaveLength(1));
    clearArchiveSnapshot();
    r2.unmount();
    const r3 = renderView(<ArchiveView api={api as never} />);
    expect(r3.container.querySelectorAll('.stage-cell')).toHaveLength(0);
  });

  // spec 2026-10-18-cell-size-1s-wait: the Archive stage now uses the Live hook.
  // Fake timers ONLY between the click and the deadline: the coverage fetch and the request already closed.
  it('cell cycle: border at once, expanded 1 s later; layout drop opens the layout tab', () => {
    const layouts = [{ id: 'LZ', name: 'Z', cells: [{ id: 'z', col: 0, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: 'c2' } }] }];
    const { container } = renderView(<ArchiveView api={api as never} layouts={layouts as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    const cell = container.querySelector('.stage-cell') as HTMLElement;
    expect(cell).not.toBeNull();
    vi.useFakeTimers();
    try {
      fireEvent.click(cell);
      expect(cell.className).toContain('selecionada');
      expect(cell.className).not.toContain('ampliada');
      act(() => { vi.advanceTimersByTime(SIZE_WAIT_MS); });
      expect(cell.className).toContain('ampliada');

      // layout drop (spec videowall-recording-tabs, revokes D6): opens the "Z" tab of the layout; the
      // selection of the previous tab does not contaminate the new one (application/x-ovms-layout contract)
      fireEvent.drop(container.querySelector('.arquivo-stage') as HTMLElement, { dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-layout' ? 'LZ' : ''), setData: () => {} } });
      const next = container.querySelector('.stage-cell') as HTMLElement;
      expect(next.className).not.toContain('selecionada');
      expect(next.className).not.toContain('ampliada');
      expect(container.querySelector('.stage-tab.active')?.textContent).toContain('Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('session without a token: banner at the top', () => {
    renderView(<ArchiveView api={{ ...api, token: null } as never} />);
    expect(screen.getByText('Session has no token — sign in again to view the archive')).toBeInTheDocument();
  });

  // spec 2026-10-18 videowall-parity (D1): the tree writes the id into application/x-ovms-layout
  // (LayoutTree.tsx:102). Rewritten by spec 2026-10-18 videowall-recording-tabs: the drop OPENS THE
  // TAB of the layout (the D6 "replaces the stage" died).
  it('LAYOUT drop (application/x-ovms-layout) opens the layout tab and clears the selection', () => {
    const layouts = [{ id: 'L1', name: 'Saved', cells: [
      { id: 'x1', col: 0, row: 0, colspan: 2, rowspan: 1, content: { kind: 'live', camera_id: 'c2' } }] }];
    const { container } = renderView(<ArchiveView api={api as never} layouts={layouts as never}
      openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    const cell = container.querySelector('.stage-cell') as HTMLElement;
    fireEvent.click(cell); // marks the selection before the drop
    fireEvent.drop(container.querySelector('.arquivo-stage') as HTMLElement, {
      dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-layout' ? 'L1' : ''), setData: () => {} },
    });
    const next = container.querySelector('.stage-cell') as HTMLElement;
    expect(next).not.toBe(cell);
    expect(next.getAttribute('style')).toContain('span 2');
    expect(next.className).not.toContain('selecionada');
    expect(container.querySelector('.stage-tab.active')?.textContent).toContain('Saved');
  });
});

// spec 2026-10-18 videowall-recording-tabs (section 8): layout tabs in Recording — parity with Live.
// The cases below use the same drop helpers as StageGrid (grid without measure in jsdom).
describe('layout tabs in Recording (spec videowall-recording-tabs)', () => {
  const dropCamera = (container: HTMLElement, id = 'c1') => {
    const grid = container.querySelector('.arquivo-stage .stage-grid') as HTMLElement;
    grid.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.drop(grid, { clientX: 10, clientY: 10, dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-camera' ? id : ''), setData: () => {} } });
  };
  const dropLayout = (container: HTMLElement, id: string) => {
    fireEvent.drop(container.querySelector('.arquivo-stage') as HTMLElement, {
      dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-layout' ? id : ''), setData: () => {} } });
  };
  const layoutL1 = { id: 'L1', name: 'Saved', cells: [
    { id: 'x1', col: 0, row: 0, colspan: 2, rowspan: 1, content: { kind: 'live', camera_id: 'c2' } }] };

  it('render creates the "New Layout N" tab; a camera drop dirties the tab (*)', () => {
    const { container } = renderView(<ArchiveView api={api as never} />);
    expect(container.querySelector('.stage-tab')?.textContent).toContain('New Layout');
    dropCamera(container);
    expect(container.querySelector('.stage-tab.active')?.textContent).toContain('*');
  });

  it('Save in the menu calls api.saveLayout with the tab cells and clears the *', async () => {
    const saveLayout = vi.fn(async () => ({ id: 'l9', name: 'Mine' }));
    const { container } = renderView(<ArchiveView api={{ ...api, saveLayout } as never} />);
    dropCamera(container);
    fireEvent.contextMenu(container.querySelector('.stage-tab.active') as HTMLElement);
    fireEvent.click(await screen.findByText('Save'));
    const input = await screen.findByLabelText('Name');
    fireEvent.change(input, { target: { value: 'Mine' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(saveLayout).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Mine', cells: [expect.objectContaining({ content: { kind: 'live', camera_id: 'c1' } })] })));
    expect(container.querySelector('.stage-tab.active')?.textContent).toContain('Mine');
    expect(container.querySelector('.stage-tab.active')?.textContent).not.toContain('*');
  });

  it('a layout already open in a tab gets focus without duplicating the tab', () => {
    const { container } = renderView(<ArchiveView api={api as never} layouts={[layoutL1] as never} />);
    dropLayout(container, 'L1');
    expect(container.querySelectorAll('.stage-tab').length).toBe(2); // New Layout + Saved
    fireEvent.click(container.querySelector('.stage-tab') as HTMLElement); // back to the first
    dropLayout(container, 'L1');
    expect(container.querySelectorAll('.stage-tab').length).toBe(2); // did not create the third
    expect(container.querySelector('.stage-tab.active')?.textContent).toContain('Saved');
  });

  it('closing the last tab creates a new empty one', () => {
    const { container } = renderView(<ArchiveView api={api as never} />);
    const first = container.querySelector('.stage-tab')?.textContent;
    fireEvent.click(container.querySelector('.stage-tab-x') as HTMLElement);
    expect(container.querySelectorAll('.stage-tab').length).toBe(1);
    expect(container.querySelector('.stage-tab')?.textContent).not.toBe(first);
  });

  it('switching tabs does not reset the clock instant (D2: single clock of the page)', async () => {
    const { container } = renderView(<ArchiveView api={api as never} openRequest={{ new: true }} onRequestConsumed={() => {}} />);
    expect(container.querySelectorAll('.stage-tab').length).toBe(2);
    await waitFor(() => expect(container.querySelector('.sheet-relogio')).toBeTruthy());
    const before = container.querySelector('.sheet-relogio')?.textContent;
    fireEvent.click(container.querySelector('.stage-tab') as HTMLElement); // tab 2 -> tab 1
    expect(container.querySelector('.sheet-relogio')?.textContent).toBe(before);
    fireEvent.click(container.querySelectorAll('.stage-tab')[1] as HTMLElement); // and back
    expect(container.querySelector('.sheet-relogio')?.textContent).toBe(before);
  });

  it('saving calls onLayoutsChanged (the App tree refreshes; spec 6.5)', async () => {
    const onLayoutsChanged = vi.fn();
    const saveLayout = vi.fn(async () => ({ id: 'l9', name: 'Panel' }));
    const { container } = renderView(<ArchiveView api={{ ...api, saveLayout } as never}
      onLayoutsChanged={onLayoutsChanged} />);
    dropCamera(container);
    fireEvent.contextMenu(container.querySelector('.stage-tab.active') as HTMLElement);
    fireEvent.click(await screen.findByText('Save'));
    const input = await screen.findByLabelText('Name');
    fireEvent.change(input, { target: { value: 'Panel' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(saveLayout).toHaveBeenCalled());
    expect(onLayoutsChanged).toHaveBeenCalled();
  });

  // defect 19/10: the sheet speed button only accelerated the virtual clock; the video stayed at 1x
  // because the page never forwarded the speed to the cells (same family as the global ▶ defect).
  it('the sheet speed reaches the cell player (initialSpeed)', async () => {
    renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    await waitFor(() => expect(spy.props.at(-1)?.profile).toBe('rp-c1'));
    expect(spy.props.at(-1)?.initialSpeed).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '2×' }));   // direct click on the 2x button (four-buttons spec)
    await waitFor(() => expect(spy.props.at(-1)?.initialSpeed).toBe(2));
  });

  // spec 2026-10-19 (selection-sheet-floating-fullscreen, B2/S3): fullscreen on the CONTAINER.
  it('⛶ requests fullscreen on the container and puts the class on the cell; fullscreenchange without element clears it', async () => {
    const { container } = renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    await waitFor(() => expect(container.querySelector('.stage-cell .celula-playback')).toBeTruthy());
    const root = container.querySelector('.arquivo-stage') as HTMLElement;
    const fs = vi.fn(() => Promise.resolve());
    Object.defineProperty(root, 'requestFullscreen', { value: fs, configurable: true });
    fireEvent.click(container.querySelector('button[title="Fullscreen"]') as HTMLElement);
    await waitFor(() => expect(fs).toHaveBeenCalledTimes(1));
    expect(container.querySelector('.celula-playback.celula-tela-cheia')).not.toBeNull();
    // native ESC / browser gesture: fullscreenElement is gone -> the class has to go with it
    document.dispatchEvent(new Event('fullscreenchange'));
    await waitFor(() => expect(container.querySelector('.celula-tela-cheia')).toBeNull());
  });

  it('✕ on the cell in fullscreen removes the cell and calls exitFullscreen (S4)', async () => {
    const { container } = renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    await waitFor(() => expect(container.querySelector('.stage-cell .celula-playback')).toBeTruthy());
    try {
      const root = container.querySelector('.arquivo-stage') as HTMLElement;
      Object.defineProperty(root, 'requestFullscreen', { value: () => Promise.resolve(), configurable: true });
      Object.defineProperty(document, 'fullscreenElement', { value: root, configurable: true });
      const exit = vi.fn(() => Promise.resolve());
      Object.defineProperty(document, 'exitFullscreen', { value: exit, configurable: true });
      fireEvent.click(container.querySelector('button[title="Fullscreen"]') as HTMLElement);
      await waitFor(() => expect(container.querySelector('.celula-tela-cheia')).not.toBeNull());
      fireEvent.click(container.querySelector('button[title="Remove"]') as HTMLElement);
      await waitFor(() => expect(exit).toHaveBeenCalled());
      expect(container.querySelector('.stage-cell')).toBeNull();
    } finally {
      // document is shared across the cases of the file: the fullscreen lie must NOT leak
      delete (document as unknown as Record<string, unknown>).fullscreenElement;
      delete (document as unknown as Record<string, unknown>).exitFullscreen;
    }
  });

  // regression (measured 2026-10-24): removal on the Archive stage has to RECOMPACT exactly like Live
  // does. Live removes with the shared `remove` (StageGrid.tsx:55 -> center); this page used a bare
  // `filter`, so the bounding rect kept the old extent and the remaining cells stayed in the right
  // half of a 2-column stage. Oracle: the grid becomes 1 column and both cells go to column 1.
  it('removal recompacts the stage (left column gone -> the wall becomes 1 column)', async () => {
    const cams = ['c1', 'c2', 'c3', 'c4'].map((id) => ({ id, name: id, state: 'online',
      profile_ids: [`p-${id}`], recording_profile_id: `rp-${id}` }));
    const cells = [
      { id: 'a', col: 0, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: 'c1' } },
      { id: 'b', col: 1, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: 'c2' } },
      { id: 'c', col: 0, row: 1, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: 'c3' } },
      { id: 'd', col: 1, row: 1, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: 'c4' } },
    ];
    const { container } = renderView(<ArchiveView api={api as never} cameras={cams as never}
      openRequest={{ id: 'L4', name: 'L4', cells } as never} onRequestConsumed={() => {}} />);
    const grid = () => container.querySelector('.stage-grid') as HTMLElement;
    await waitFor(() => expect(container.querySelectorAll('.stage-cell')).toHaveLength(4));
    expect(grid().style.gridTemplateColumns).toBe('repeat(2, 1fr)');
    // remove the two cells of the LEFT column, one at a time (each click re-renders the stage)
    for (let i = 0; i < 2; i += 1) {
      const left = [...container.querySelectorAll('.stage-cell')]
        .map((el) => el as HTMLElement)
        .find((el) => el.style.gridColumn.startsWith('1 /'))!;
      fireEvent.click(left.querySelector('button[title="Remove"]') as HTMLElement);
    }
    await waitFor(() => expect(container.querySelectorAll('.stage-cell')).toHaveLength(2));
    expect(grid().style.gridTemplateColumns).toBe('repeat(1, 1fr)');
    expect([...container.querySelectorAll('.stage-cell')].map((el) => (el as HTMLElement).style.gridColumn))
      .toEqual(['1 / span 1', '1 / span 1']);
  });

  // spec 2026-10-20 (playback edge, D4): on the current day the coverage asks for the tail every 30 s
  it('today: schedules the 30 s tail poll with the clamped window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date((MIDNIGHT + 43200) * 1000)); // noon: the clamps do not touch the window
    try {
      renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(timeline).toHaveBeenCalled();          // the whole day loaded once
      timeline.mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(timeline).toHaveBeenCalledTimes(1);    // one tail request, one camera on the wall
      const q = timeline.mock.calls[0][0] as { from: number; to: number };
      // amendment E7: advanceTimersByTimeAsync(30000) moves the fake Date.now() by exactly 30 s
      expect(q.from).toBe(MIDNIGHT + 43230 - 900);
      expect(q.to).toBe(MIDNIGHT + 43230 + 120);
    } finally { vi.useRealTimers(); }
  });

  it('past day: the tail poll is not scheduled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date((MIDNIGHT + 43200) * 1000));
    try {
      const first = renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      first.unmount();                              // the module snapshot keeps the day
      vi.setSystemTime(new Date((MIDNIGHT + 86400 + 60) * 1000)); // day turned: the snapshot is "yesterday"
      timeline.mockClear();
      renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(timeline).toHaveBeenCalled();          // the whole day still loads
      timeline.mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      expect(timeline).not.toHaveBeenCalled();      // no tail request in a past day
    } finally { vi.useRealTimers(); }
  });

  // spec 2026-10-20 (timeline-unica-tela-cheia): in fullscreen the sheet shows only the track of the
  // expanded camera. Outside it the whole wall comes back. Filter at the call site (dumb sheet).
  it('fullscreen keeps only the enlarged camera track in the sheet; exiting restores the wall', async () => {
    const { container } = renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1', 'c2'] }} onRequestConsumed={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.stage-cell')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(container.querySelector('.trilha[data-camera="c1"]')).not.toBeNull();
    expect(container.querySelector('.trilha[data-camera="c2"]')).not.toBeNull();
    const root = container.querySelector('.arquivo-stage') as HTMLElement;
    Object.defineProperty(root, 'requestFullscreen', { value: () => Promise.resolve(), configurable: true });
    fireEvent.click(container.querySelector('button[title="Fullscreen"]') as HTMLElement); // first cell = c1
    await waitFor(() => expect(container.querySelector('.celula-tela-cheia')).not.toBeNull());
    expect(container.querySelector('.trilha[data-camera="c1"]')).not.toBeNull();
    expect(container.querySelector('.trilha[data-camera="c2"]')).toBeNull();
    // amendment E3: a second click on the same button = toggle off, without doubling exitFullscreen.
    // Measured divergence from the plan: in the expanded cell the SAME ⛶ button now has
    // title="Close options" (CelulaPlayback.tsx), so the selector below is the button of the expanded
    // cell itself. Clicking button[title="Fullscreen"] would hit the other cell and swap the expansion.
    fireEvent.click(container.querySelector('.celula-tela-cheia button[title="Close options"]') as HTMLElement);
    await waitFor(() => expect(container.querySelector('.celula-tela-cheia')).toBeNull());
    expect(container.querySelector('.trilha[data-camera="c1"]')).not.toBeNull();
    expect(container.querySelector('.trilha[data-camera="c2"]')).not.toBeNull();
  });
});

// spec 2026-10-24 (continuous-hour-playback, 4.1): the 250 ms coordinator runs the recovery decision
// with the barrier CLOSED. One proven buffered successor = ONE global seek; no evidence keeps the
// clock still, and a healthy peer never drags the wall forward.
describe('wall coordinator: recovery across hour files (Task 4.1)', () => {
  // the whole first minute is covered, so the playhead (midnight) is sampled by the wall
  const coverFirstMinute = () => timeline.mockResolvedValue({
    buckets: [{ t: MIDNIGHT, fraction: 1 }], bucket_seconds: 60, gravando: false });
  // the 250 ms interval is created in the mount effect: enabling fake timers afterwards would leave a
  // REAL timer behind, so the page is always rendered under the fake clock here.
  const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const staged = () => {
    const props = spy.props.map(p => p.seekRequest as { id: number; target: number } | undefined);
    const byId = new Map<number, number>();
    for (const s of props) if (s) byId.set(s.id, s.target);
    return [...byId.entries()];
  };
  const forwardSeeks = () => staged().filter(([, target]) => target > MIDNIGHT);
  const startPlaying = async (ms: number) => { fireEvent.keyDown(window, { code: 'Space' }); await flush(ms); };
  async function stage(cameras: string[]) {
    const r = renderView(<ArchiveView api={api as never} openRequest={{ cameras }} onRequestConsumed={() => {}} />);
    await flush(); await flush();
    expect(r.container.querySelectorAll('.player-fake')).toHaveLength(cameras.length);
    expect(r.container.querySelector('.player-fake')?.getAttribute('data-coberto')).toBe('true');
    return r;
  }

  it('one stalled camera with a real successor: exactly one seek to that epoch', async () => {
    vi.useFakeTimers();
    try {
      coverFirstMinute();
      spy.samples['rp-c1'] = { epoch: MIDNIGHT, ready: false, presentedAt: 0, nextEpoch: MIDNIGHT + 5 };
      await stage(['c1']);
      await startPlaying(250);
      expect(forwardSeeks().map(([, target]) => target)).toEqual([MIDNIGHT + 5]);
    } finally { vi.useRealTimers(); }
  });

  it('all-stalled wall recovers once and does not loop', async () => {
    vi.useFakeTimers();
    try {
      coverFirstMinute();
      spy.samples['rp-c1'] = { epoch: MIDNIGHT, ready: false, presentedAt: 0, nextEpoch: MIDNIGHT + 5 };
      spy.samples['rp-c2'] = { epoch: MIDNIGHT, ready: false, presentedAt: 0, nextEpoch: MIDNIGHT + 5 };
      await stage(['c1', 'c2']);
      await startPlaying(5000);
      expect(forwardSeeks()).toHaveLength(1);                    // not one per 250 ms tick
      expect(new Set(forwardSeeks().map(([, t]) => t))).toEqual(new Set([MIDNIGHT + 5]));
    } finally { vi.useRealTimers(); }
  });

  it('pending recovery: the successor is not re-issued inside the cooldown', async () => {
    vi.useFakeTimers();
    try {
      coverFirstMinute();
      // the player keeps saying "media 5 s ahead" while the seek is still loading (worst case)
      spy.samples['rp-c1'] = (p: Record<string, unknown>): FakeSample => {
        const t = Number(p.resumeTs);
        return { epoch: t, ready: false, presentedAt: 0, nextEpoch: t + 5 };
      };
      await stage(['c1']);
      await startPlaying(1750);                                  // 7 ticks, 1.5 s < cooldown
      expect(forwardSeeks().map(([, target]) => target)).toEqual([MIDNIGHT + 5]);
    } finally { vi.useRealTimers(); }
  });

  it('healthy peer: the wall is never dragged into a forward seek', async () => {
    vi.useFakeTimers();
    try {
      coverFirstMinute();
      spy.samples['rp-c1'] = { epoch: MIDNIGHT, ready: false, presentedAt: 0, nextEpoch: MIDNIGHT + 5 };
      spy.samples['rp-c2'] = { epoch: MIDNIGHT, ready: true, presentedAt: 1 };
      await stage(['c1', 'c2']);
      await startPlaying(4000);
      expect(forwardSeeks()).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('skipGaps off: a proven successor does not move the clock', async () => {
    vi.useFakeTimers();
    try {
      coverFirstMinute();
      spy.samples['rp-c1'] = { epoch: MIDNIGHT, ready: false, presentedAt: 0, nextEpoch: MIDNIGHT + 5 };
      await stage(['c1']);
      act(() => { clockCtl.setSkipGaps?.(false); });
      await startPlaying(3000);
      expect(forwardSeeks()).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('no successor: the clock stays at the stalled instant', async () => {
    vi.useFakeTimers();
    try {
      coverFirstMinute();
      spy.samples['rp-c1'] = { epoch: MIDNIGHT, ready: false, presentedAt: 0 };
      await stage(['c1']);
      await startPlaying(3000);
      expect(forwardSeeks()).toHaveLength(0);
      expect(spy.props.at(-1)?.resumeTs).toBe(MIDNIGHT);
    } finally { vi.useRealTimers(); }
  });
});

// spec 2026-10-27, section 1 — the pointer rule on camera drop. Oracle: the text of `.sheet-relogio`
// (hms of clock.instant), which the closed sheet already renders in row 1.
describe('pointer on camera drop (spec 2026-10-27)', () => {
  const dropCam = (container: HTMLElement, ids: string) => {
    const grid = container.querySelector('.arquivo-stage .stage-grid') as HTMLElement;
    grid.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.drop(grid, { clientX: 5, clientY: 5,
      dataTransfer: { getData: (k: string) => (k === 'application/x-ovms-camera' ? ids : ''), setData: () => {} } });
  };
  const setDayInput = (container: HTMLElement, epochMidnight: number) => {
    const d = new Date(epochMidnight * 1000);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    fireEvent.change(container.querySelector('input[type=date]') as HTMLInputElement, { target: { value } });
  };
  const relogio = (container: HTMLElement) => container.querySelector('.sheet-relogio')?.textContent;
  const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

  it('drop on the current day sends the pointer to NOW and keeps it paused', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date((MIDNIGHT + 43200) * 1000));   // noon of the displayed day
    try {
      const { container } = renderView(<ArchiveView api={api as never} onRequestConsumed={() => {}} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(relogio(container)).toBe('00:00:00');           // the clock was born at the midnight
      dropCam(container, 'c1');
      expect(relogio(container)).toBe('12:00:00');           // clock.now(), coverage-independent
      expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();  // playing state untouched
      expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('drop on a past day seeks to the oldest first recording of the dropped cameras', async () => {
    const yesterday = MIDNIGHT - 86400;
    // c1 starts at 03:00, c2 at 01:30 -> the group jump must go to the OLDEST first start (01:30)
    timeline.mockImplementation(({ stream_profile_id }: { stream_profile_id: string }) => Promise.resolve(
      stream_profile_id === 'rp-c1'
        ? { buckets: [{ t: yesterday + 3 * 3600, fraction: 1 }], bucket_seconds: 60, gravando: false }
        : { buckets: [{ t: yesterday + 5400, fraction: 1 }], bucket_seconds: 60, gravando: false }));
    const { container } = renderView(<ArchiveView api={api as never} onRequestConsumed={() => {}} />);
    setDayInput(container, yesterday);
    expect(relogio(container)).toBe('00:00:00');
    dropCam(container, 'c1,c2');
    await waitFor(() => expect(container.querySelectorAll('.stage-cell')).toHaveLength(2));
    await waitFor(() => expect(relogio(container)).toBe('01:30:00'));
  });

  it('drop on a past day with no recording does not move the pointer', async () => {
    timeline.mockResolvedValue({ buckets: [], bucket_seconds: 60, gravando: false });
    const yesterday = MIDNIGHT - 86400;
    const { container } = renderView(<ArchiveView api={api as never} onRequestConsumed={() => {}} />);
    setDayInput(container, yesterday);
    dropCam(container, 'c1');
    await waitFor(() => expect(timeline).toHaveBeenCalled());
    await settle();                                          // coverage answered; pending consumed
    expect(container.querySelector('.stage-cell')).not.toBeNull();
    expect(relogio(container)).toBe('00:00:00');             // no candidate: the pointer stays
  });

  it('changing the day between the drop and the coverage answer cancels the jump', async () => {
    const yesterday = MIDNIGHT - 86400;
    const twoDaysAgo = MIDNIGHT - 2 * 86400;
    // deferred timeline: the coverage of the drop day never answers while the day changes under it
    let resolveTimeline!: (v: unknown) => void;
    timeline.mockImplementation(() => new Promise((res) => { resolveTimeline = res; }));
    const { container } = renderView(<ArchiveView api={api as never} onRequestConsumed={() => {}} />);
    setDayInput(container, yesterday);
    dropCam(container, 'c1');
    await waitFor(() => expect(timeline).toHaveBeenCalled());
    setDayInput(container, twoDaysAgo);                      // the pending drop belongs to the old day
    const frozen = relogio(container);                       // changeDay clamped the instant (epoch of the old midnight)
    expect(frozen).not.toBe('01:00:00');                     // the oracle can tell a jump from a freeze
    // the LATE answer (the second fetch, window twoDaysAgo) arrives with a real 01:00 recording
    await act(async () => { resolveTimeline({ buckets: [{ t: twoDaysAgo + 3600, fraction: 1 }], bucket_seconds: 60, gravando: false }); });
    await settle();
    expect(relogio(container)).toBe(frozen);                 // pending consumed empty: no jump
  });
});


// spec 2026-10-27 (hide-actions-without-permission, Task 4.5): the export trigger belongs to
// camera.manage — the App passes can('camera.manage'); false must remove the button from the DOM
// (the dead button would still be a 403 invitation on POST /archive/export).
describe('ArchiveView canExport (Tarefa 4.5)', () => {
  it('canExport={false}: the sheet renders WITHOUT the Export button', async () => {
    renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }}
      onRequestConsumed={() => {}} canExport={false} />);
    await waitFor(() => expect(document.querySelector('input[type="date"]')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });
  it('default (canExport omitted): the Export button is present and opens the dialog', async () => {
    renderView(<ArchiveView api={api as never} openRequest={{ cameras: ['c1'] }} onRequestConsumed={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

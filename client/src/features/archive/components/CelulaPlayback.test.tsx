import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import PlaybackCell from './CelulaPlayback';
import { LanguageProvider } from '@/shared/i18n';
import type { Camera } from '@/shared/utils/api';

// The real player (MSE) does not live in jsdom: the mock records the props the cell passed
// (pattern of MosaicoPlayback.test.tsx, which dies with the wall in Phase 5).
const spy = vi.hoisted(() => ({ props: [] as Record<string, unknown>[], onState: null as null | ((e: unknown) => void) }));
vi.mock('./PlayerGravacao', async () => {
  const React = await import('react');
  const Comp = React.forwardRef((props: Record<string, unknown>, ref) => {
    spy.props.push(props);
    spy.onState = (props.onState ?? null) as (e: unknown) => void;   // test drives the state through the centre of the cell
    React.useImperativeHandle(ref, () => ({ seek: () => {}, toggle: () => {}, now: () => {},
      speed: () => 1, setSpeed: () => {} }));
    return React.createElement('div', { 'data-perfil': String(props.profile), 'data-coberto': String(props.covered),
      'data-ts': String(props.initialTs) });
  });
  return { default: Comp, SPEEDS: [1, 2, 4] };
});

const cam: Camera = { id: 'c1', name: 'Câmera 1', state: 'online', profile_ids: ['p1'], recording_profile_id: 'rp1' } as Camera;
const API = { base: 'b', token: 't' };
const wrapper = ({ children }: { children: React.ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;

beforeEach(() => { spy.props.length = 0; spy.onState = null; });

describe('PlaybackCell', () => {
  it('mounts the player of the recording profile, freezes the ts on mount and shows the name in the footer', () => {
    const { container, rerender } = render(<PlaybackCell cam={cam} covered instant={1000} api={API} speed={1} fullscreen={false} onFullscreen={() => {}}
      handleRef={() => {}} onRemove={() => {}} />, { wrapper });
    expect(spy.props[0].profile).toBe('rp1');
    expect(spy.props[0].initialTs).toBe(1000);
    expect(spy.props[0].shortcuts).toBe(false);
    expect(container.querySelector('.celula-playback-nome')?.textContent).toBe('Câmera 1');
    rerender(<PlaybackCell cam={cam} covered instant={9999} api={API} speed={1} fullscreen={false} onFullscreen={() => {}} handleRef={() => {}} onRemove={() => {}} />);
    // the clock runs on rAF: feeding initialTs would be the seek storm (PlayerGravacao.tsx:172-178)
    expect(spy.props[spy.props.length - 1]['data-ts'] ?? spy.props[spy.props.length - 1].initialTs).toBe(1000);
  });

  it('covered: no warning; without coverage: no-recording warning AND covered=false in the player', () => {
    const { container, rerender } = render(<PlaybackCell cam={cam} covered instant={1} api={API} speed={1} fullscreen={false} onFullscreen={() => {}}
      handleRef={() => {}} onRemove={() => {}} />, { wrapper });
    expect(container.querySelector('.sem-gravacao')).toBeNull();
    expect(spy.props[0].covered).toBe(true);
    rerender(<PlaybackCell cam={cam} covered={false} instant={1} api={API} speed={1} fullscreen={false} onFullscreen={() => {}} handleRef={() => {}} onRemove={() => {}} />);
    expect(container.querySelector('.sem-gravacao')).toBeInTheDocument();
    expect(spy.props[spy.props.length - 1].covered).toBe(false);
  });

  it('a cell without a camera in the catalog says "No camera" like live', () => {
    render(<PlaybackCell cam={undefined} covered instant={1} api={API} speed={1} fullscreen={false} onFullscreen={() => {}}
      handleRef={() => {}} onRemove={() => {}} />, { wrapper });
    expect(screen.getByText('No camera')).toBeInTheDocument();
  });

  it('double click calls onFullscreen (the cell does not request fullscreen itself); right click opens a one-item menu', () => {
    const onRemove = vi.fn();
    const onFullscreen = vi.fn();
    const { container } = render(<PlaybackCell cam={cam} covered instant={1} api={API} speed={1}
      handleRef={() => {}} onRemove={onRemove} fullscreen={false} onFullscreen={onFullscreen} />, { wrapper });
    const cell = container.querySelector('.celula-playback') as HTMLElement;
    const fs = vi.fn(() => Promise.resolve());
    Object.defineProperty(cell, 'requestFullscreen', { value: fs, configurable: true });
    fireEvent.doubleClick(cell);
    // spec 2026-10-19 (selection-sheet-floating-fullscreen, S2/S3): fullscreen is owned by the page
    expect(onFullscreen).toHaveBeenCalledTimes(1);
    expect(fs).not.toHaveBeenCalled();
    fireEvent.contextMenu(cell);
    expect(screen.getByText('Remove from layout')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Remove from layout'));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  // spec 2026-10-18 (videowall-recording-tabs, section 6.4): the cell has the live bar on hover.
  it('overlay: the cell has ⛶ and ✕; ⛶ calls onFullscreen; ✕ calls onRemove', () => {
    const onRemove = vi.fn();
    const onFullscreen = vi.fn();
    const { container } = render(<PlaybackCell cam={cam} covered instant={1} api={API} speed={1}
      handleRef={() => {}} onRemove={onRemove} fullscreen={false} onFullscreen={onFullscreen} />, { wrapper });
    const cell = container.querySelector('.celula-playback') as HTMLElement;
    const bar = cell.querySelector('.cell-overlay .cell-actions');
    expect(bar).not.toBeNull();
    fireEvent.click(bar!.querySelector('button[title="Fullscreen"]') as HTMLElement);
    expect(onFullscreen).toHaveBeenCalledTimes(1);
    fireEvent.click(bar!.querySelector('button[title="Remove"]') as HTMLElement);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  // spec 2026-10-19 (selection-sheet-floating-fullscreen, case 3): no hook inside the cell — the
  // props drive the class and the ⛶ label.
  it('props drive the fullscreen: fullscreen puts the class and the label becomes close options', () => {
    const onFullscreen = vi.fn();
    const { container, rerender } = render(<PlaybackCell cam={cam} covered instant={1} speed={1} api={API}
      handleRef={() => {}} onRemove={() => {}} fullscreen={false} onFullscreen={onFullscreen} />, { wrapper });
    expect(container.querySelector('.celula-playback.celula-tela-cheia')).toBeNull();
    rerender(<PlaybackCell cam={cam} covered instant={1} speed={1} api={API}
      handleRef={() => {}} onRemove={() => {}} fullscreen onFullscreen={onFullscreen} />);
    expect(container.querySelector('.celula-playback.celula-tela-cheia')).not.toBeNull();
    fireEvent.click(container.querySelector('button[title="Close options"]') as HTMLElement);
    expect(onFullscreen).toHaveBeenCalledTimes(1);
  });

  // spec 2026-10-19 (state-feedback): while there is no frame the centre of the cell spins with the
  // state; on error it becomes a still warning; without coverage it is NOT shown (the warning there
  // is "no recording").
  it('centre spins with the player state and stops on "ready"; error becomes a warning', () => {
    const { container } = render(<PlaybackCell cam={cam} covered instant={1} speed={1} api={API}
      handleRef={() => {}} onRemove={() => {}} fullscreen={false} onFullscreen={() => {}} />, { wrapper });
    expect(container.querySelector('.cell-loading')).toBeNull();               // silent until the player speaks
    act(() => { spy.onState!({ kind: 'connecting' }); });
    expect(container.querySelector('.cell-loading')?.textContent).toContain('Connecting');
    expect(container.querySelector('.cell-spinner')).not.toBeNull();           // icon: circular spinner
    act(() => { spy.onState!({ kind: 'transcoding' }); });
    expect(container.querySelector('.cell-loading')?.textContent).toContain('H.264');
    act(() => { spy.onState!({ kind: 'ready' }); });
    expect(container.querySelector('.cell-loading')).toBeNull();               // first frame: gone
    act(() => { spy.onState!({ kind: 'error', message: 'No recording to load at this point' }); });
    expect(container.querySelector('.cell-loading')).toBeNull();
    expect(container.querySelector('.no-signal')?.textContent).toContain('No recording');
  });

  it('without coverage: the centre stays silent (the "No recording" warning speaks)', () => {
    const { container } = render(<PlaybackCell cam={cam} covered={false} instant={1} speed={1} api={API}
      handleRef={() => {}} onRemove={() => {}} fullscreen={false} onFullscreen={() => {}} />, { wrapper });
    act(() => { spy.onState!({ kind: 'loading' }); });
    expect(container.querySelector('.cell-loading')).toBeNull();
    expect(container.querySelector('.sem-gravacao')).toBeInTheDocument();
  });

  // spec 2026-10-21 (4.7): the hole tells the story; the waiting edge says something else
  it('hole mostra "Recording interrupted" com a janela; atEdge mostra a espera', () => {
    const cell = (hole: { from: number; to: number } | null, atEdge: boolean) => (
      <PlaybackCell cam={cam} covered={false} instant={1} api={API} speed={1}
        fullscreen={false} onFullscreen={() => {}} handleRef={() => {}} onRemove={() => {}}
        hole={hole} atEdge={atEdge} />
    );
    const { container, rerender } = render(cell({ from: 1_000_000_000, to: 1_000_000_228 }, false), { wrapper });
    expect(container.querySelector('.sem-gravacao')?.textContent).toMatch(/Recording interrupted/);
    expect(container.querySelector('.sem-gravacao')?.textContent).toMatch(/→/);
    rerender(cell(null, true));
    expect(container.querySelector('.sem-gravacao')?.textContent).toMatch(/waiting for the recording/);
    rerender(cell(null, false));
    expect(container.querySelector('.sem-gravacao')?.textContent).toBe('No recording');
  });

  // correction 2026-10-26: parity with the live cell — settings, rename, remove (destructive last).
  // phase 4.3: no canManageCameras prop here = default = the old menu (this IS the "sem prop" case).
  it('cell menu: settings, rename and remove, in that order', () => {
    const onConfig = vi.fn();
    const onRename = vi.fn();
    const onRemove = vi.fn();
    const { container } = render(<PlaybackCell cam={cam} covered instant={1} api={API} speed={1}
      handleRef={() => {}} onRemove={onRemove} fullscreen={false} onFullscreen={() => {}}
      onConfig={onConfig} onRename={onRename} />, { wrapper });
    fireEvent.contextMenu(container.querySelector('.celula-playback') as HTMLElement);
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Camera settings', 'Rename', 'Remove from layout']);
    fireEvent.click(screen.getByText('Rename'));
    expect(onRename).toHaveBeenCalledWith('c1', 'Câmera 1');
  });

  // phase 4.3 (hide-actions-without-permission): 'rename' PATCHes the camera (POLICY camera.manage).
  // Without the capability the item is GONE; settings/remove (other tasks/local) stay.
  it('4.3: canManageCameras=false hides "Rename" from the cell menu', () => {
    const { container } = render(<PlaybackCell cam={cam} covered instant={1} api={API} speed={1}
      handleRef={() => {}} onRemove={() => {}} fullscreen={false} onFullscreen={() => {}}
      canManageCameras={false} />, { wrapper });
    fireEvent.contextMenu(container.querySelector('.celula-playback') as HTMLElement);
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Camera settings', 'Remove from layout']);
  });
});

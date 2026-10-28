import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import TimelineGlobal from './TimelineGlobal';
import { LanguageProvider } from '@/shared/i18n';

const MIDNIGHT = 1_760_000_000; // midnight of some day (epoch s)

const props = (over = {}) => ({
  midnight: MIDNIGHT,
  cameras: [{ id: 'c1', name: 'Entrada' }],
  coverage: {},
  instant: MIDNIGHT,
  onSeek: vi.fn(),
  ...over,
});

const renderTimeline = (ui: React.ReactElement) => render(ui, { wrapper: LanguageProvider });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function hitArea(container: HTMLElement) {
  const hit = container.querySelector('.tl-hit') as HTMLElement;
  vi.spyOn(hit, 'getBoundingClientRect').mockReturnValue({
    left: 125, width: 1000, top: 0, right: 1125, bottom: 96, height: 96, x: 125, y: 0, toJSON: () => ({}),
  } as DOMRect);
  return hit;
}

function wheel(target: Element, options: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 625, deltaY: -100, ...options });
  fireEvent(target, event);
  return event;
}

function visibleRange(container: HTMLElement) {
  const data = (container.querySelector('.timeline-global') as HTMLElement).dataset;
  return { start: Number(data.visibleStart), end: Number(data.visibleEnd) };
}

describe('TimelineGlobal', () => {
  it('one track per camera of the page', () => {
    const { container } = renderTimeline(
      <TimelineGlobal {...props({
        cameras: [{ id: 'c1', name: 'Entrada' }, { id: 'c2', name: 'Pátio' }],
      })} />,
    );
    expect(container.querySelectorAll('[data-camera]')).toHaveLength(2);
    expect(screen.getByText('Entrada')).toBeInTheDocument();
    expect(screen.getByText('Pátio')).toBeInTheDocument();
  });

  it('each track has a name and a groove; the bar is a child of the groove', () => {
    const { container } = renderTimeline(
      <TimelineGlobal {...props({ coverage: { c1: [{ start_ts: MIDNIGHT, end_ts: MIDNIGHT + 3600 }] } })} />,
    );
    const track = container.querySelector('.trilha') as HTMLElement;
    expect(track.querySelector('.nome')).not.toBeNull();
    const groove = track.querySelector('.trackbar') as HTMLElement;
    expect(groove).not.toBeNull();
    expect(groove.querySelector('.barra')).not.toBeNull();
  });

  it('the bars come from the blocks', () => {
    const { container } = renderTimeline(
      <TimelineGlobal {...props({ coverage: { c1: [{ start_ts: MIDNIGHT, end_ts: MIDNIGHT + 3600 }] } })} />,
    );
    const bar = container.querySelector('.barra') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(parseFloat(bar.style.left)).toBe(0);
    expect(Math.abs(parseFloat(bar.style.width) - (3600 / 86400) * 100)).toBeLessThan(0.01);
  });

  it('the playhead sits on the instant', () => {
    const { container } = renderTimeline(<TimelineGlobal {...props({ instant: MIDNIGHT + 43200 })} />);
    const playhead = container.querySelector('.playhead') as HTMLElement;
    expect(playhead.style.left).toBe('50%');
  });

  it('the ruler has 13 marks from 00:00 to 24:00', () => {
    const { container } = renderTimeline(<TimelineGlobal {...props()} />);
    const marks = [...container.querySelectorAll('.regua .marca')];
    expect(marks).toHaveLength(13);
    expect(marks[0].textContent).toBe('00:00');
    expect(marks[12].textContent).toBe('24:00');
  });

  it('a click in the middle of the bars area writes the instant', () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline(<TimelineGlobal {...props({ onSeek })} />);
    const hit = container.querySelector('.tl-hit') as HTMLElement;
    vi.spyOn(hit, 'getBoundingClientRect').mockReturnValue({
      left: 0, width: 864, top: 0, right: 864, bottom: 0, height: 40, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerDown(hit, { clientX: 432, pointerId: 1 });
    expect(onSeek).toHaveBeenCalledWith(MIDNIGHT + 43200);
  });

  it('the selected prop marks only the track of the matching camera', () => {
    const { container } = renderTimeline(
      <TimelineGlobal {...props({ cameras: [{ id: 'c1', name: 'Entrada' }, { id: 'c2', name: 'Pátio' }], selected: 'c2' })} />,
    );
    expect(container.querySelector('.trilha[data-camera="c2"].selecionada')).not.toBeNull();
    expect(container.querySelector('.trilha[data-camera="c1"].selecionada')).toBeNull();
  });

  it('without the selected prop, no track is marked', () => {
    const { container } = renderTimeline(
      <TimelineGlobal {...props({ cameras: [{ id: 'c1', name: 'Entrada' }, { id: 'c2', name: 'Pátio' }] })} />,
    );
    expect(container.querySelectorAll('.trilha.selecionada')).toHaveLength(0);
  });

  it('zooms around the pointer without seeking, using the same scale for all tracks', () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline(<TimelineGlobal {...props({ onSeek,
      cameras: [{ id: 'c1', name: 'Entrada' }, { id: 'c2', name: 'Pátio' }],
      coverage: { c1: [{ start_ts: MIDNIGHT, end_ts: MIDNIGHT + 86400 }], c2: [{ start_ts: MIDNIGHT, end_ts: MIDNIGHT + 86400 }] },
    })} />);
    expect(wheel(hitArea(container), { clientX: 375 }).defaultPrevented).toBe(true);
    expect(visibleRange(container)).toEqual({ start: MIDNIGHT + 4320, end: MIDNIGHT + 73440 });
    expect([...container.querySelectorAll<HTMLElement>('.barra')].map(b => [b.style.left, b.style.width]))
      .toEqual([['0%', '100%'], ['0%', '100%']]);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('zooms over the ruler and seeks correctly after zooming over the tracks', () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline(<TimelineGlobal {...props({ onSeek })} />);
    const hit = hitArea(container);
    wheel(container.querySelector('.regua')!);
    fireEvent.pointerDown(hit, { clientX: 875, button: 0 });
    expect(onSeek).toHaveBeenCalledOnce();
    expect(onSeek).toHaveBeenCalledWith(MIDNIGHT + 60480);
  });

  it('hides an off-screen playhead and preserves the viewport on clock and coverage updates', () => {
    const p = props({ instant: MIDNIGHT + 100 });
    const { container, rerender } = renderTimeline(<TimelineGlobal {...p} />);
    wheel(hitArea(container), { clientX: 625, deltaY: -10000 });
    const before = visibleRange(container);
    expect(container.querySelector('.playhead')).toBeNull();
    rerender(<TimelineGlobal {...p} instant={MIDNIGHT + 43200} selected="c1"
      coverage={{ c1: [{ start_ts: MIDNIGHT, end_ts: MIDNIGHT + 86400 }] }} />);
    expect(visibleRange(container)).toEqual(before);
    expect((container.querySelector('.playhead') as HTMLElement).style.left).toBe('50%');
    expect(container.querySelector('.trilha.selecionada')).not.toBeNull();
  });

  it('resets to the complete day when the selected day changes', () => {
    const p = props();
    const { container, rerender } = renderTimeline(<TimelineGlobal {...p} />);
    wheel(hitArea(container));
    rerender(<TimelineGlobal {...p} midnight={MIDNIGHT + 86400} />);
    expect(visibleRange(container)).toEqual({ start: MIDNIGHT + 86400, end: MIDNIGHT + 172800 });
    rerender(<TimelineGlobal {...p} />);
    expect(visibleRange(container)).toEqual({ start: MIDNIGHT, end: MIDNIGHT + 86400 });
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { deltaY: 0, deltaX: 100 }])('preserves browser gestures %j', options => {
    const { container } = renderTimeline(<TimelineGlobal {...props()} />);
    expect(wheel(hitArea(container), options).defaultPrevented).toBe(false);
    expect(visibleRange(container)).toEqual({ start: MIDNIGHT, end: MIDNIGHT + 86400 });
  });

  it('preserves vertical scrolling over the camera names and wheel events outside the timeline', () => {
    const { container } = renderTimeline(<TimelineGlobal {...props()} />);
    hitArea(container);
    expect(wheel(container.querySelector('.nome')!).defaultPrevented).toBe(false);
    expect(wheel(document.body).defaultPrevented).toBe(false);
    expect(visibleRange(container)).toEqual({ start: MIDNIGHT, end: MIDNIGHT + 86400 });
  });

  it('keeps the seek transform stable during a drag and releases it on cancellation', () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline(<TimelineGlobal {...props({ onSeek })} />);
    const hit = hitArea(container);
    fireEvent.pointerDown(hit, { clientX: 375, button: 0 });
    wheel(hit);
    expect(visibleRange(container)).toEqual({ start: MIDNIGHT, end: MIDNIGHT + 86400 });
    fireEvent.pointerMove(hit, { clientX: 625 });
    expect(onSeek).toHaveBeenLastCalledWith(MIDNIGHT + 43200);
    fireEvent.pointerCancel(hit);
    expect(wheel(hit).defaultPrevented).toBe(true);
  });

  it('does not seek with the middle or right mouse button', () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline(<TimelineGlobal {...props({ onSeek })} />);
    const hit = hitArea(container);
    fireEvent.pointerDown(hit, { clientX: 625, button: 1 });
    fireEvent.pointerDown(hit, { clientX: 625, button: 2 });
    expect(onSeek).not.toHaveBeenCalled();
    expect(wheel(hit).defaultPrevented).toBe(true);
  });

  it('shows seconds at maximum zoom and restores the full-day ruler on zoom out', () => {
    const { container } = renderTimeline(<TimelineGlobal {...props()} />);
    const hit = hitArea(container);
    wheel(hit, { deltaY: -10000 });
    const view = visibleRange(container);
    expect(view.end - view.start).toBe(30);
    expect([...container.querySelectorAll('.marca')].every(m => /^\d{2}:\d{2}:\d{2}$/.test(m.textContent ?? ''))).toBe(true);
    wheel(hit, { deltaY: 10000 });
    expect(visibleRange(container)).toEqual({ start: MIDNIGHT, end: MIDNIGHT + 86400 });
    expect(container.querySelectorAll('.marca')).toHaveLength(13);
  });

  it('removes its wheel listener on unmount', () => {
    const { container, unmount } = renderTimeline(<TimelineGlobal {...props()} />);
    const hit = hitArea(container);
    unmount();
    expect(wheel(hit).defaultPrevented).toBe(false);
  });

  it('accounts for the vertical scrollbar and disconnects the size observer', () => {
    let measure = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { measure = callback; }
      observe = vi.fn();
      disconnect = disconnect;
    });
    const { container, unmount } = renderTimeline(<TimelineGlobal {...props()} />);
    const tracks = container.querySelector('.trilhas')!;
    Object.defineProperty(tracks, 'offsetWidth', { value: 1000 });
    Object.defineProperty(tracks, 'clientWidth', { value: 980 });
    const hit = hitArea(container);
    fireEvent(window, new Event('resize'));
    expect((container.querySelector('.timeline-global') as HTMLElement).style.getPropertyValue('--tl-scrollbar')).toBe('20px');
    measure();
    expect(wheel(hit).defaultPrevented).toBe(true);
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

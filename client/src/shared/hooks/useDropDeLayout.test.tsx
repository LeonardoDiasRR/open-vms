import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useLayoutDrop } from './useDropDeLayout';

const L1 = { id: 'L1', name: 'Salvo', cells: [{ id: 'x1', col: 0, row: 0, colspan: 1, rowspan: 1 }] };
const dt = (data: Record<string, string> = {}) => ({
  setData: (t: string, v: string) => { data[t] = v; },
  getData: (t: string) => data[t] ?? '',
  effectAllowed: '',
});

// The fake stage imitates the real page: the hook on the WRAPPER (capture) and the camera drop on a
// child GRID — the wrapper's stopPropagation is what this test checks.
function Stage({ layouts, onOpen, onChild }: { layouts: never[]; onOpen: (l: unknown) => void; onChild: () => void }) {
  const onDropCapture = useLayoutDrop(layouts, onOpen);
  return (
    <div className="stage" onDropCapture={onDropCapture}>
      <div className="grid" onDropCapture={onChild} onDrop={onChild} />
    </div>
  );
}

describe('useLayoutDrop (spec 2026-10-18 videowall-paridade, D1/D3)', () => {
  it('layout payload: resolves in the catalog, calls onOpen and the event does NOT reach the grid', () => {
    const onOpen = vi.fn(); const onChild = vi.fn();
    const { container } = render(<Stage layouts={[L1] as never[]} onOpen={onOpen} onChild={onChild} />);
    const ev = fireEvent.drop(container.querySelector('.grid') as HTMLElement,
      { dataTransfer: dt({ 'application/x-ovms-layout': 'L1' }) });
    expect(onOpen).toHaveBeenCalledWith(L1);
    expect(onChild).not.toHaveBeenCalled();
    expect(ev).toBe(false); // preventDefault called (defaultPrevented)
  });

  it('camera payload: nothing is consumed — the event reaches the grid (StagePalco positions)', () => {
    const onOpen = vi.fn(); const onChild = vi.fn();
    const { container } = render(<Stage layouts={[] as never[]} onOpen={onOpen} onChild={onChild} />);
    fireEvent.drop(container.querySelector('.grid') as HTMLElement,
      { dataTransfer: dt({ 'application/x-ovms-camera': 'c1' }) });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onChild).toHaveBeenCalled();
  });

  it('id without a catalog entry: the event is still consumed (same contract as the old LiveView)', () => {
    const onOpen = vi.fn(); const onChild = vi.fn();
    const { container } = render(<Stage layouts={[] as never[]} onOpen={onOpen} onChild={onChild} />);
    const ev = fireEvent.drop(container.querySelector('.grid') as HTMLElement,
      { dataTransfer: dt({ 'application/x-ovms-layout': 'NAO-EXISTE' }) });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onChild).not.toHaveBeenCalled();
    expect(ev).toBe(false);
  });
});

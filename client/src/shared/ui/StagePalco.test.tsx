import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import StagePalco, { type StageCell } from './StagePalco';

const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [], group_id: 'g1' };
const other = { id: 'c2', name: 'Cam 2', state: 'online', profile_ids: [], group_id: 'g2' };
const cell = (id: string, col: number, camera_id?: string): StageCell => ({
  id, col, row: 0, colspan: 1, rowspan: 1, ...(camera_id ? { content: { kind: 'live', camera_id } } : {}),
});

// the stage does not know the cell body: the stub draws the hooks the geometry excludes
const renderStub = (c: StageCell, marked: boolean) => (
  <div className="stub-celula" data-marcao={String(marked)} data-camera={c.content?.camera_id ?? ''}>
    <div className="cell-actions"><button>acoes</button></div>
  </div>
);

const renderStage = (ui: React.ReactElement) => render(<LanguageProvider>{ui}</LanguageProvider>);

describe('StagePalco', () => {
  it('empty stage shows the drop-camera notice', () => {
    const { container } = renderStage(<StagePalco cameras={[]} cells={[]} kind="live" onChange={() => {}} renderCell={renderStub} />);
    expect(container.querySelector('.stage-grid')).toBeInTheDocument();
    expect(screen.getByText('Drag a camera here')).toBeInTheDocument();
  });

  it('a single camera fills the stage: the visual grid is 1x1', () => {
    const { container } = renderStage(<StagePalco cameras={[cam]} cells={[cell('x', 0, 'c1')]} kind="live"
      onChange={() => {}} renderCell={renderStub} />);
    expect((container.querySelector('.stage-grid') as HTMLElement).getAttribute('style')).toContain('repeat(1, 1fr)');
  });

  it('renderCell receives (cell, marked, maximized)', () => {
    const seen: [string, boolean, boolean][] = [];
    renderStage(<StagePalco cameras={[]} cells={[cell('a', 0), cell('b', 1)]} kind="live" onChange={() => {}}
      selected="b" maximized
      renderCell={(c, marked, maximized) => { seen.push([c.id, marked, maximized]); return null; }} />);
    expect(seen).toEqual([['a', false, false], ['b', true, true]]);
  });

  it('the drop target stays 2x2 and the drop writes the kind from the prop', () => {
    let received: StageCell[] = [];
    const { container } = renderStage(<StagePalco cameras={[cam, other]} cells={[cell('x', 0, 'c1')]} kind="live"
      onChange={(c) => { received = c; }} renderCell={renderStub} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    // jsdom returns 0x0 for every element: the rectangle measurement has to be injected
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const dt = { getData: (t: string) => (t === 'application/x-ovms-camera' ? 'c2' : '') };
    fireEvent.drop(grid, { dataTransfer: dt, clientX: 75, clientY: 25 });
    const added = received.find((c) => c.content?.camera_id === 'c2');
    expect(added?.col).toBe(1);
    expect(added?.content?.kind).toBe('live');
  });

  it('the maximized cell receives the WHOLE stage slot', () => {
    const { container } = renderStage(<StagePalco cameras={[]} cells={[cell('a', 0), cell('b', 1)]} kind="live"
      selected="a" maximized onChange={() => {}} renderCell={renderStub} />);
    const [first, second] = [...container.querySelectorAll('.stage-cell')] as HTMLElement[];
    expect(first.getAttribute('style')).toContain('1 / -1');
    expect(second.getAttribute('style')).not.toContain('1 / -1');
  });

  it('click on the body reports; click on the empty area clears; handle and actions do not mark', () => {
    const onSelect = vi.fn(); const onClearSelection = vi.fn();
    const { container } = renderStage(<StagePalco cameras={[cam]} cells={[cell('a', 0, 'c1')]} kind="live"
      onSelect={onSelect} onClearSelection={onClearSelection} onChange={() => {}} renderCell={renderStub} />);
    const el = container.querySelector('.stage-cell') as HTMLElement;
    fireEvent.click(el);
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(onClearSelection).not.toHaveBeenCalled();
    onSelect.mockClear();
    fireEvent.click(el.querySelector('.cell-resize') as HTMLElement);
    fireEvent.click(el.querySelector('.cell-actions button') as HTMLElement);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.stage-grid') as HTMLElement);
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });
});

// spec 2026-10-27: the page needs the drop itself, not only the cell diff — opening a layout also
// diffs cells and must NOT move the pointer. The callback carries exactly the newIds of the drop.
describe('StagePalco onCamerasDropped', () => {
  const cams = [cam, other];
  const dt = (ids: string[], cellId = '') => ({
    getData: (t: string) => (t === 'application/x-ovms-camera' ? ids.join(',') : t === 'application/x-ovms-cell' ? cellId : ''),
  });
  const mockRect = (grid: HTMLElement) => {
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  };

  it('fires once with the NEW camera ids of a drop', () => {
    const dropped: string[][] = [];
    const { container } = renderStage(<StagePalco cameras={cams} groups={[]} cells={[]} kind="live"
      onChange={() => {}} renderCell={renderStub} onCamerasDropped={(ids) => dropped.push(ids)} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    mockRect(grid);
    fireEvent.drop(grid, { dataTransfer: dt(['c1', 'c2']), clientX: 5, clientY: 5 });
    expect(dropped).toEqual([['c1', 'c2']]);
  });

  it('does not fire for a duplicate drop or for cell moves', () => {
    const dropped: string[][] = [];
    const { container } = renderStage(<StagePalco cameras={cams} groups={[]} cells={[cell('x1', 0, 'c1')]} kind="live"
      onChange={() => {}} renderCell={renderStub} onCamerasDropped={(ids) => dropped.push(ids)} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    mockRect(grid);
    fireEvent.drop(grid, { dataTransfer: dt(['c1']), clientX: 5, clientY: 5 }); // already on stage
    expect(dropped).toEqual([]);
    fireEvent.drop(grid, { dataTransfer: dt([], 'x1'), clientX: 5, clientY: 5 }); // cell move, not a camera drop
    expect(dropped).toEqual([]);
  });

  // spec 2026-10-27: the tree payload marks N folders as one CSV in application/x-ovms-group.
  // Before: the whole "g1,g2" string went to subtreeCameras as a single id and NOTHING entered.
  it('a folder drop enters its level-direct cameras', () => {
    let received: StageCell[] = [];
    const { container } = renderStage(<StagePalco cameras={[cam, other]} cells={[]} kind="live"
      onChange={(c) => { received = c; }} renderCell={renderStub} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    fireEvent.drop(grid, { dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-group' ? 'g1' : '') }, clientX: 50, clientY: 50 });
    expect(received.map((c) => c.content?.camera_id).sort()).toEqual(['c1']);
  });

  it('multi-folder drop unions the direct cameras; empty and unknown folders are harmless', () => {
    let received: StageCell[] = [];
    const { container } = renderStage(<StagePalco cameras={[cam, other]} cells={[]} kind="live"
      onChange={(c) => { received = c; }} renderCell={renderStub} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    // g1 direct = c1, g2 direct = c2, g3 marks nothing, 'nope' matches no folder: union is exactly
    // [c1, c2] and the unknown id must not throw (CA-07 + CA-05)
    fireEvent.drop(grid, { dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-group' ? 'g1,g2,g3,nope' : '') }, clientX: 50, clientY: 50 });
    expect(received.map((c) => c.content?.camera_id).sort()).toEqual(['c1', 'c2']);
  });
});

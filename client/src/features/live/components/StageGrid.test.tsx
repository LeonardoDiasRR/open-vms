import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LanguageProvider } from '@/shared/i18n';
import StageGrid from './StageGrid';

// the stage does not touch the api with zero/one cell without a camera: a minimal object is enough
const api = { liveToken: async () => ({ whep_url: 'http://127.0.0.1:8890/uuid/whep', token: 'tk', expires_in: 60 }) };
const wrapper = ({ children }: { children: ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;
const mount = (ui: React.ReactElement) => render(ui, { wrapper });

describe('StageGrid', () => {
  it('shows the stage with the drop warning when there are no cells', () => {
    const { container } = mount(<StageGrid api={api} cameras={[]} cells={[]} onChange={() => {}} />);
    expect(container.querySelector('.stage-grid')).toBeInTheDocument();
    // the empty message belongs to shared/ui/StagePalco (its own wording wave): pin the slot, not the copy
    expect(container.querySelector('.stage-vazio')).toBeInTheDocument();
  });

  it('renders a cell without a catalog camera as "No camera"', () => {
    const { container } = mount(
      <StageGrid api={api} cameras={[]} cells={[{ id: 'c1', col: 0, row: 0, colspan: 1, rowspan: 1 }]}
        onChange={() => {}} />,
    );
    expect(container.querySelector('.stage-cell')).toBeInTheDocument();
    expect(screen.getByText('No camera')).toBeInTheDocument();
  });

  it('forwards the PTZ state to the cell (the armed cell gets ptz-ativo)', () => {
    const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [] };
    // the cell only compares the cameraId and disarms on unmount; the rest of the hook is not exercised here
    const ptz = { cameraId: 'c1', disarm: () => {} } as never;
    const { container } = mount(
      <StageGrid api={api} cameras={[cam]} ptz={ptz} onChange={() => {}}
        cells={[{ id: 'x', col: 0, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: 'c1' } }]} />,
    );
    expect(container.querySelector('.stream-cell')?.className).toContain('ptz-ativo');
  });

  it('a single camera fills the stage: the visual grid is 1x1', () => {
    const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [] };
    const { container } = mount(<StageGrid api={api} cameras={[cam]} onChange={() => {}}
      cells={[{ id: 'x', col: 0, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: 'c1' } }]} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    expect(grid.getAttribute('style')).toContain('repeat(1, 1fr)');
  });

  it('the drop target stays 2x2: the new camera falls in the pointed quadrant', () => {
    const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [] };
    const other = { id: 'c2', name: 'Cam 2', state: 'online', profile_ids: [] };
    let received: { col: number; row: number; content?: { camera_id: string } | null }[] = [];
    const { container } = mount(<StageGrid api={api} cameras={[cam, other]} onChange={(c) => { received = c; }}
      cells={[{ id: 'x', col: 0, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: 'c1' } }]} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    // jsdom returns 0x0 for every element: the rectangle measure has to be injected
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const dt = { getData: (t: string) => (t === 'application/x-ovms-camera' ? 'c2' : '') };
    fireEvent.drop(grid, { dataTransfer: dt, clientX: 75, clientY: 25 });
    const added = received.find((c) => c.content?.camera_id === 'c2');
    expect(added).toBeTruthy();
    expect(added?.col).toBe(1);
  });
});

// spec 2026-10-18: the stage PAINTS the selection (props) and ANNOUNCES the click; the state lives in
// LiveView. The mark/shrink cycle and the snapshot are proved in src/selecao.test.ts, through LiveView
// (amendment E2).
describe('marked and expanded cell (spec 2026-10-18)', () => {
  const two = [
    { id: 'a', col: 0, row: 0, colspan: 1, rowspan: 1 },
    { id: 'b', col: 1, row: 0, colspan: 1, rowspan: 1 },
  ];
  const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [] };
  const withCamera = [{ id: 'a', col: 0, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: 'c1' } }];

  it('paints marked and expanded only on the marked cell', () => {
    const { container } = mount(<StageGrid api={api} cameras={[]} cells={two}
      selected="a" expanded onChange={() => {}} />);
    const [first, second] = [...container.querySelectorAll('.stage-cell')] as HTMLElement[];
    expect(first.className).toContain('selecionada');
    expect(first.className).toContain('ampliada');
    expect(second.className).not.toContain('selecionada');
    expect(second.className).not.toContain('ampliada');
  });

  it('marked and not expanded keeps the border and loses the gap', () => {
    const { container } = mount(<StageGrid api={api} cameras={[]} cells={two}
      selected="a" expanded={false} onChange={() => {}} />);
    const [first] = [...container.querySelectorAll('.stage-cell')] as HTMLElement[];
    expect(first.className).toContain('selecionada');
    expect(first.className).not.toContain('ampliada');
  });

  it('the expanded cell receives the WHOLE STAGE slot, so the inset resolves against the stage', () => {
    const { container } = mount(<StageGrid api={api} cameras={[]} cells={two}
      selected="a" expanded onChange={() => {}} />);
    const [first, second] = [...container.querySelectorAll('.stage-cell')] as HTMLElement[];
    // without this swap the CSS `inset` resolves against the CELL SLOT (measured in the spec, 3.1:
    // 637x449 instead of 880x621)
    expect(first.getAttribute('style')).toContain('1 / -1');
    // the unmarked cell stays in its slot
    expect(second.getAttribute('style')).toContain('span 1');
    expect(second.getAttribute('style')).not.toContain('1 / -1');
  });

  it('a click on the cell body announces which one was marked', () => {
    const onSelect = vi.fn();
    const { container } = mount(<StageGrid api={api} cameras={[]} cells={two}
      onSelect={onSelect} onChange={() => {}} />);
    fireEvent.click(container.querySelectorAll('.stage-cell')[0]);
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('a click on the empty stage area asks for the clear', () => {
    const onSelect = vi.fn();
    const onClearSelection = vi.fn();
    const { container } = mount(<StageGrid api={api} cameras={[]} cells={two}
      selected="a" expanded onSelect={onSelect} onClearSelection={onClearSelection} onChange={() => {}} />);
    fireEvent.click(container.querySelector('.stage-grid') as HTMLElement);
    expect(onClearSelection).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('the click on the cell climbs to the stage and does NOT clear what it just marked', () => {
    const onSelect = vi.fn();
    const onClearSelection = vi.fn();
    const { container } = mount(<StageGrid api={api} cameras={[]} cells={two}
      onSelect={onSelect} onClearSelection={onClearSelection} onChange={() => {}} />);
    fireEvent.click(container.querySelectorAll('.stage-cell')[0]);
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(onClearSelection).not.toHaveBeenCalled();
  });

  it('the resize handle and the action bar do not touch the selection', () => {
    const onSelect = vi.fn();
    const { container } = mount(<StageGrid api={api} cameras={[cam]} cells={withCamera}
      onSelect={onSelect} onChange={() => {}} />);
    const cell = container.querySelector('.stage-cell') as HTMLElement;
    // the body announces; and ONLY it: without this first line the case would pass green with no handler at all
    fireEvent.click(cell);
    expect(onSelect).toHaveBeenCalledWith('a');
    onSelect.mockClear();
    fireEvent.click(cell.querySelector('.cell-resize') as HTMLElement);
    fireEvent.click(cell.querySelector('.cell-actions button') as HTMLElement);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a click on a camera menu item does not mark nor expand the cell', () => {
    const onSelect = vi.fn();
    const { container } = mount(<StageGrid api={api} cameras={[cam]} cells={withCamera}
      onSelect={onSelect} onChange={() => {}} />);
    fireEvent.contextMenu(container.querySelector('.stream-cell') as HTMLElement);
    // the menu lives INSIDE .stream-cell (CameraMenu.tsx:43, class .cam-menu) and does not stopPropagation:
    // a left click on the item climbs to the cell onClick and would mark what the right click just left alone
    fireEvent.click(screen.getByText('Remove from layout'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('the right click opens the cell menu and does not touch the selection', () => {
    const onSelect = vi.fn();
    const { container } = mount(<StageGrid api={api} cameras={[cam]} cells={withCamera}
      onSelect={onSelect} onChange={() => {}} />);
    fireEvent.contextMenu(container.querySelector('.stream-cell') as HTMLElement);
    expect(screen.getByText('Remove from layout')).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    // the left click on the same place announces: what does not touch the selection is the right one
    fireEvent.click(container.querySelector('.stage-cell') as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  // spec 2026-10-19 (destructive item always last): the live 'remove' gained danger:true and CameraMenu
  // partitions; the guard proves both sides in the real cell menu.
  it('cell menu: "Remove from layout" is the last item and is marked as dangerous', () => {
    const { container } = mount(<StageGrid api={api} cameras={[cam]} cells={withCamera}
      onChange={() => {}} />);
    fireEvent.contextMenu(container.querySelector('.stream-cell') as HTMLElement);
    const items = screen.getAllByRole('menuitem');
    const last = items[items.length - 1];
    expect(last.textContent).toBe('Remove from layout');
    expect(last.className).toContain('danger');
  });

  // correction 2026-10-26: the cell menu order is settings, rename, remove (destructive last by rule).
  // phase 4.5: with camera.manage the menu also carries 'toggle-active' (Deactivate camera for an
  // active camera) between settings and rename — pinned in full above.
  it('cell menu: settings, toggle, rename and remove, in that order', () => {
    const onRename = vi.fn();
    const { container } = mount(<StageGrid api={api} cameras={[cam]} cells={withCamera}
      onChange={() => {}} onRename={onRename} />);
    fireEvent.contextMenu(container.querySelector('.stream-cell') as HTMLElement);
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Camera settings', 'Deactivate camera', 'Rename', 'Remove from layout']);
    fireEvent.click(screen.getByText('Rename'));
    expect(onRename).toHaveBeenCalledWith('c1', 'Cam');
  });

  // phase 4.5 (camera ativa): the cell menu offers the SAME 'toggle-active' as the tree menu (task 4.2):
  // the label follows the TARGET camera (`ativa` absent = active) and the item only exists with
  // canManageCameras. CameraMenu does not render the id in the DOM (key only), so the id contract is
  // pinned by the label (i18n key) + gating + the non-aliasing click below.
  it('4.5: active camera (ativa absent) offers "Deactivate camera" between settings and rename', () => {
    const { container } = mount(<StageGrid api={api} cameras={[cam]} cells={withCamera}
      onChange={() => {}} />);
    fireEvent.contextMenu(container.querySelector('.stream-cell') as HTMLElement);
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Camera settings', 'Deactivate camera', 'Rename', 'Remove from layout']);
  });

  it('4.5: inactive camera offers "Activate camera" instead', () => {
    const { container } = mount(<StageGrid api={api} cameras={[{ ...cam, ativa: false }]}
      cells={withCamera} onChange={() => {}} />);
    fireEvent.contextMenu(container.querySelector('.stream-cell') as HTMLElement);
    expect(screen.getByText('Activate camera')).toBeInTheDocument();
    expect(screen.queryByText('Deactivate camera')).not.toBeInTheDocument();
  });

  it('4.5: canManageCameras=false hides the toggle item (it is a camera mutation)', () => {
    const { container } = mount(<StageGrid api={api} cameras={[cam]} cells={withCamera}
      onChange={() => {}} canManageCameras={false} />);
    fireEvent.contextMenu(container.querySelector('.stream-cell') as HTMLElement);
    expect(screen.queryByText('Deactivate camera')).not.toBeInTheDocument();
    expect(screen.queryByText('Activate camera')).not.toBeInTheDocument();
    // settings/remove stay (other tasks/local)
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent))
      .toEqual(['Camera settings', 'Remove from layout']);
  });

  it('4.5: clicking the toggle does NOT alias settings, rename or remove', () => {
    const onConfig = vi.fn();
    const onRename = vi.fn();
    const onChange = vi.fn();
    const { container } = mount(<StageGrid api={api} cameras={[cam]} cells={withCamera}
      onChange={onChange} onConfig={onConfig} onRename={onRename} />);
    fireEvent.contextMenu(container.querySelector('.stream-cell') as HTMLElement);
    // actOnCell only knows remove/settings/rename: 'toggle-active' is wired to the PATCH in phase 5
    // (App wiring); until then the click must be inert, never a side-effect of another id.
    fireEvent.click(screen.getByText('Deactivate camera'));
    expect(onConfig).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  // phase 4.3 (hide-actions-without-permission): 'rename' PATCHes the camera (POLICY camera.manage).
  // Without the capability the item is GONE; settings/remove (other tasks/local) stay.
  it('4.3: canManageCameras=false hides "Rename" from the cell menu', () => {
    const { container } = mount(<StageGrid api={api} cameras={[cam]} cells={withCamera}
      onChange={() => {}} canManageCameras={false} />);
    fireEvent.contextMenu(container.querySelector('.stream-cell') as HTMLElement);
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Camera settings', 'Remove from layout']);
  });
});

// plan 2026-10-30 (spec 5.6): a api da célula é a do servidor da câmera. A capability PTZ é lida do
// api da célula no mount (StreamCell.tsx:106-112) — é a costura que prova qual api entrou.
describe('api per camera server (apiFor)', () => {
  const taggedApi = (cap: ReturnType<typeof vi.fn>) => ({
    liveToken: async () => ({ whep_url: '', token: '', expires_in: 60 }),
    ptzCapability: cap,
  });

  it('each cell receives the api of its own camera server', async () => {
    const capA = vi.fn(async () => ({ supported: false }));
    const capB = vi.fn(async () => ({ supported: false }));
    const apiA = taggedApi(capA); const apiB = taggedApi(capB); // IDENTIDADES ESTÁVEIS: apiFor é chamado a cada render
    const cams = [
      { id: 'c1', name: 'A', state: 'online', profile_ids: [], server_id: 'http://a' },
      { id: 'c2', name: 'B', state: 'online', profile_ids: [], server_id: 'http://b' },
    ];
    const cells = [
      { id: 'x1', col: 0, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live' as const, camera_id: 'c1' } },
      { id: 'x2', col: 1, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live' as const, camera_id: 'c2' } },
    ];
    mount(<StageGrid api={api as never} cameras={cams as never} cells={cells} onChange={() => {}}
      apiFor={(sid: string) => (sid === 'http://a' ? apiA : apiB) as never} />);
    await waitFor(() => expect(capA).toHaveBeenCalledWith('c1'));
    expect(capB).toHaveBeenCalledWith('c2');
    expect(capA).not.toHaveBeenCalledWith('c2');
    expect(capB).not.toHaveBeenCalledWith('c1');
  });

  it('without apiFor every cell uses the single api (fallback da compatibilidade)', async () => {
    const cap = vi.fn(async () => ({ supported: false }));
    mount(<StageGrid api={taggedApi(cap) as never}
      cameras={[{ id: 'c1', name: 'A', state: 'online', profile_ids: [] }] as never}
      cells={[{ id: 'x1', col: 0, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live' as const, camera_id: 'c1' } }]}
      onChange={() => {}} />);
    await waitFor(() => expect(cap).toHaveBeenCalledWith('c1'));
  });
});

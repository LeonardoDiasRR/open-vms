import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LanguageProvider } from '@/shared/i18n';
import LiveView, { clearLiveViewSnapshot } from './LiveView';

// spec 2026-10-17 (tab state): the view snapshot lives in the MODULE — without clearing between cases, one
// case's state leaks into the next (the previous dirty tab would come back instead of the initial one).
beforeEach(() => { clearLiveViewSnapshot(); });

// LiveView only calls api.profiles() in the effect; a minimal object avoids the network. With zero cells no
// StreamCell mounts, so WebRTC never enters the scene.
const api = {
  token: null,
  liveToken: async () => ({ whep_url: 'http://127.0.0.1:8890/uuid/whep', token: 'tk', expires_in: 60 }),
  profiles: () => Promise.resolve([]),
  saveLayout: () => Promise.resolve({ id: 'l1', name: 'Name' }),
};
const wrapper = ({ children }: { children: ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;
const mount = (ui: React.ReactElement) => render(ui, { wrapper });

describe('LiveView', () => {
  it('opens a new tab and shows the empty stage', () => {
    const { container } = mount(<LiveView api={api} cameras={[]} />);
    expect(container.querySelector('.mode-view')).toBeInTheDocument();
    expect(screen.getByText(/New Layout 1/)).toBeInTheDocument();
    // the empty message belongs to shared/ui/StagePalco: pin the slot, not its copy
    expect(container.querySelector('.stage-vazio')).toBeInTheDocument();
  });
});

// Regression of spec 2026-10-16 (close-layout-without-confirm): closing a dirty tab NEVER asks.
// The WebRTC stub is the same as StreamCell.test.tsx: with 1 cell the StreamCell mounts in jsdom.
describe('closing a tab (spec 2026-10-16)', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', class {
      addTransceiver() {} ontrack = null; onconnectionstatechange = null; connectionState = 'connecting';
      async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
      async setLocalDescription() {} async setRemoteDescription() {} close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0' })));
  });

  it('closing a dirty tab does not ask', () => {
    const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [] };
    const { container } = mount(<LiveView api={api} cameras={[cam]} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    grid.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.drop(grid, { clientX: 10, clientY: 10, dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-camera' ? 'c1' : '') } });
    expect(screen.getByText(/New Layout \d+ \*/)).toBeInTheDocument(); // dirty tab (live asterisk)
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(container.querySelector('.stage-tab-x') as HTMLElement); // the TAB X (the cell has its own)
    expect(spy).not.toHaveBeenCalled(); // the confirm was removed from closeTab
    expect(screen.queryByText(/New Layout \d+ \*/)).toBeNull(); // the dirty tab closed on its own
    vi.unstubAllGlobals();
  });
});

// (promptdialog spec) save/rename through the nx-dialog, not through the native window
describe('save and rename through the dialog', () => {
  it('Save asks for the name in the dialog; Rename pre-selects the saved name', async () => {
    vi.stubGlobal('RTCPeerConnection', class {
      addTransceiver() {} ontrack = null; onconnectionstatechange = null; connectionState = 'connecting';
      async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
      async setLocalDescription() {} async setRemoteDescription() {} close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0' })));
    const saveLayout = vi.fn(async () => ({ id: 'l1', name: 'Mine' }));
    const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [] };
    const { container } = mount(<LiveView api={{ ...api, saveLayout }} cameras={[cam]} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    grid.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.drop(grid, { clientX: 10, clientY: 10, dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-camera' ? 'c1' : '') } });
    fireEvent.contextMenu(screen.getByText(/New Layout \d+ \*/));
    fireEvent.click(await screen.findByText('Save'));
    const input = await screen.findByLabelText('Name');
    fireEvent.change(input, { target: { value: 'Mine' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(saveLayout).toHaveBeenCalledWith(expect.objectContaining({ name: 'Mine' })));
    fireEvent.contextMenu(screen.getByText('Mine'));
    fireEvent.click(await screen.findByText('Rename'));
    const input2 = await screen.findByLabelText('Name');
    expect((input2 as HTMLInputElement).value).toBe('Mine');
    fireEvent.change(input2, { target: { value: 'Other' } });
    fireEvent.keyDown(input2, { key: 'Enter' });
    await waitFor(() => expect(saveLayout).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Other' })));
    vi.unstubAllGlobals();
  });
});

// spec 2026-10-17: LiveView only forwards the PTZ state to the stage (the cell is what arms it).
describe('PTZ state forwarding', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', class {
      addTransceiver() {} ontrack = null; onconnectionstatechange = null; connectionState = 'connecting';
      async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
      async setLocalDescription() {} async setRemoteDescription() {} close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0' })));
  });

  it('the stage cell receives the PTZ state', async () => {
    const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [] };
    const { container } = mount(<LiveView api={api} cameras={[cam]} ptz={{ cameraId: 'c1', disarm: () => {} } as never} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    grid.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.drop(grid, { clientX: 10, clientY: 10, dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-camera' ? 'c1' : '') } });
    await waitFor(() => expect(container.querySelector('.stream-cell')?.className).toContain('ptz-ativo'));
  });
});

// spec 2026-10-17 (tab state): switching Live/Archive unmounts the stage; the second mount has to come back
// with the tabs, the active tab, the cells and `dirty`. Measured in today's code: the stage would come back
// empty, which is why these two cases are the discriminator of the change.
describe('tab state on return (spec 2026-10-17)', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', class {
      addTransceiver() {} ontrack = null; onconnectionstatechange = null; connectionState = 'connecting';
      async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
      async setLocalDescription() {} async setRemoteDescription() {} close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0' })));
  });

  const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [] };
  // the REAL path of the camera to the stage is the drop (StageGrid only reacts to it): same pattern as the
  // cases above, with the grid measure injected because jsdom returns a 0x0 rectangle
  const drop = (container: HTMLElement) => {
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    grid.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.drop(grid, { clientX: 10, clientY: 10, dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-camera' ? 'c1' : '') } });
  };

  it('the second mount restores the tabs, the active tab, the cell and the dirty flag', () => {
    // the {new: true} request creates the SECOND tab (which becomes active) — and the camera enters there
    const first = mount(<LiveView api={api} cameras={[cam]} openRequest={{ new: true }} />);
    drop(first.container);
    expect(first.container.querySelectorAll('.stage-tab').length).toBe(2);
    expect(first.container.querySelectorAll('.stage-grid .cell-name').length).toBe(1);
    expect(first.container.querySelector('.stage-tab.active')?.textContent).toContain('*');
    first.unmount();

    // second mount WITHOUT the request (the App already consumed it): what comes back is only from the snapshot
    const second = mount(<LiveView api={api} cameras={[cam]} />);
    expect(second.container.querySelectorAll('.stage-tab').length).toBe(2);
    expect(second.container.querySelectorAll('.stage-grid .cell-name').length).toBe(1);
    expect(second.container.querySelector('.stage-tab.active')?.textContent).toContain('*');
    expect(second.container.querySelector('.stage-vazio')).toBeNull();
  });

  it('clearLiveViewSnapshot() returns the initial stage on the next mount', () => {
    const first = mount(<LiveView api={api} cameras={[cam]} openRequest={{ new: true }} />);
    drop(first.container);
    first.unmount();
    clearLiveViewSnapshot();

    const second = mount(<LiveView api={api} cameras={[cam]} />);
    expect(second.container.querySelectorAll('.stage-tab').length).toBe(1);
    expect(second.container.querySelector('.stage-vazio')).toBeInTheDocument();
  });
});

// spec 2026-10-18 videowall-parity (D3): the layout drop moved to the shared hook.
describe('layout drop from the tree (parity spec D3)', () => {
  it('dragging a layout opens the tab with the saved name', () => {
    const { container } = mount(<LiveView api={api} cameras={[]}
      layouts={[{ id: 'L9', name: 'Guarda', cells: [{ id: 'x', col: 0, row: 0, colspan: 1, rowspan: 1 }] }]} />);
    fireEvent.drop(container.querySelector('.mode-view') as HTMLElement, {
      dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-layout' ? 'L9' : ''), setData: () => {} },
    });
    expect(screen.getByText('Guarda')).toBeInTheDocument();
  });
});

// correction 2026-10-26: the live cell menu forwards Rename to the page callback.
describe('cell menu rename', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', class {
      addTransceiver() {} ontrack = null; onconnectionstatechange = null; connectionState = 'connecting';
      async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
      async setLocalDescription() {} async setRemoteDescription() {} close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0' })));
  });

  it('right click on the cell offers settings, rename and remove; rename calls onRename', async () => {
    const onRename = vi.fn();
    const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [] };
    const { container } = mount(<LiveView api={api} cameras={[cam]} onRename={onRename} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    grid.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.drop(grid, { clientX: 10, clientY: 10, dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-camera' ? 'c1' : '') } });
    const cell = container.querySelector('.stream-cell') as HTMLElement;
    fireEvent.contextMenu(cell);
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Camera settings', 'Deactivate camera', 'Rename', 'Remove from layout']);
    fireEvent.click(screen.getByText('Rename'));
    expect(onRename).toHaveBeenCalledWith('c1', 'Cam');
    vi.unstubAllGlobals();
  });
});

// fixup task 5.2 (2026-10-27): 'Deactivate camera' in the cell menu was inert — the PATCH lives in the
// App (act), the page only forwards, exactly like onRename above.
describe('cell menu toggle-active', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', class {
      addTransceiver() {} ontrack = null; onconnectionstatechange = null; connectionState = 'connecting';
      async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
      async setLocalDescription() {} async setRemoteDescription() {} close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0' })));
  });

  it('clicking "Deactivate camera" in the cell menu calls onToggleActive with the camera id', async () => {
    const onToggleActive = vi.fn();
    const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [] };
    const { container } = mount(<LiveView api={api} cameras={[cam]} onToggleActive={onToggleActive} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    grid.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.drop(grid, { clientX: 10, clientY: 10, dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-camera' ? 'c1' : '') } });
    const cell = container.querySelector('.stream-cell') as HTMLElement;
    fireEvent.contextMenu(cell);
    fireEvent.click(await screen.findByText('Deactivate camera'));
    expect(onToggleActive).toHaveBeenCalledWith('c1');
    vi.unstubAllGlobals();
  });
});

// plan 2026-10-30: LiveView repassa apiFor ao palco (a célula da câmera etiquetada pergunta ao
// servidor dela). O stub de WebRTC é o da suíte 'closing a tab'.
describe('apiFor forwarding (plan 2026-10-30)', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', class {
      addTransceiver() {} ontrack = null; onconnectionstatechange = null; connectionState = 'connecting';
      async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
      async setLocalDescription() {} async setRemoteDescription() {} close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0' })));
  });
  it('the cell of a tagged camera asks the api of its server', async () => {
    const cam = { id: 'c1', name: 'Cam', state: 'online', profile_ids: [], server_id: 'http://srv2' };
    const apiFor = vi.fn(() => api as never);
    const { container } = mount(<LiveView api={api} cameras={[cam] as never} apiFor={apiFor} />);
    const grid = container.querySelector('.stage-grid') as HTMLElement;
    grid.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.drop(grid, { clientX: 10, clientY: 10, dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-camera' ? 'c1' : '') } });
    await waitFor(() => expect(apiFor).toHaveBeenCalledWith('http://srv2'));
  });
});

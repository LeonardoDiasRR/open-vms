import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  renameCamera: vi.fn(async () => ({})),
  deleteCamera: vi.fn(async () => ({})),
  // spec 2026-10-17 (item 1.3): the three DVR operations + the folder creation of the group actions
  renameDevice: vi.fn(async () => ({})),
  moveDevice: vi.fn(async () => ({})),
  deleteDevice: vi.fn(async () => ({ deleted: 'd1', cameras: [] as string[] })),
  createGroup: vi.fn(async () => ({ id: 'g9', name: 'New folder' })),
  // spec 2026-10-18 (videowall recording tabs, sec 8): saving a layout from Archive (T8)
  saveLayout: vi.fn(async (d: { id?: string; name: string; cells?: unknown[] }) => ({ id: d.id || 'l-novo', name: d.name })),
  moveCamera: vi.fn(async () => ({})),
  // plan 2026-10-27 (camera ativa, task 5.1): the liga/desliga PATCH seam (setCameraOptions {ativa})
  setCameraOptions: vi.fn(async (_id: string, _body: { ativa?: boolean }) => ({})),
  ptzGoToPosition: vi.fn(async () => ({ ok: true })),
  ptzSavePosition: vi.fn(async () => ({ id: 31, name: 'Position 2' })),
  // the catalog is mutable per case: each test chooses the cameras, the DVR and the folders it wants to measure
  cameras: [] as { id: string; name: string; state: string; profile_ids: string[]; device_id?: string | null; group_id?: string | null; can_control?: boolean; ativa?: boolean }[],
  devices: [] as { id: string; name: string; group_id?: string | null }[],
  groups: [] as { id: string; name: string; parent_id?: string | null }[],
  layouts: [] as { id: string; name: string; cells?: unknown[] }[],
  // plan 2026-10-25 (Task 2.2): the double answers with one more export after the POST goes through,
  // which is how the case below proves the panel refetched without a reload.
  exportRangeChamado: false,
  // phase 4: the EFFECTIVE capabilities the fake login/me answer with; the gate cases narrow them.
  // The default is the full set so every pre-existing case keeps seeing what it saw with the old
  // profile-based gate.
  meCaps: ['camera.view', 'camera.control', 'camera.manage', 'camera.manage.global',
    'settings.manage', 'users.manage', 'profiles.manage', 'retention.manage'] as string[],
}));

vi.mock('@/shared/utils/api', () => ({
  ApiClient: class {
    token: string | null = null;
    constructor(_server: string) {}
    cameras = async () => fakes.cameras;
    base = 'http://x';
    // ponytail: the Archive tab mounts ArchiveView and the exports section; the double answers the minimum
    // both screens read (empty timeline + one finished export).
    timeline = async () => ({ buckets: [], bucket_seconds: 60, segments: 0, segmentos: [] });
    exports = async () => (fakes.exportRangeChamado
      ? [{ id: 'e2', from_ts: 0, to_ts: 600, state: 'queued' }, { id: 'e1', from_ts: 0, to_ts: 3600, state: 'done' }]
      : [{ id: 'e1', from_ts: 0, to_ts: 3600, state: 'done' }]);
    exportRange = async () => { fakes.exportRangeChamado = true; return { id: 'e2', from_ts: 0, to_ts: 600, state: 'queued' }; };
    devices = async () => fakes.devices;
    groups = async () => fakes.groups;
    health = async () => 'ok';
    rtsp = async () => null;
    layouts = async () => fakes.layouts;
    profiles = async () => [{ id: 'p1', camera_id: 'c1', name: 'Main', width: 1920, height: 1080 }];
    liveToken = async () => ({ whep_url: '', token: '', expires_in: 60 });
    renameCamera = fakes.renameCamera;
    deleteCamera = fakes.deleteCamera;
    renameDevice = fakes.renameDevice;
    moveDevice = fakes.moveDevice;
    deleteDevice = fakes.deleteDevice;
    createGroup = fakes.createGroup;
    saveLayout = fakes.saveLayout;
    moveCamera = fakes.moveCamera;
    setCameraOptions = fakes.setCameraOptions;
    ptzCapability = async () => ({ supported: true, panTilt: true, zoom: true });
    ptzMove = async () => ({ ok: true });
    ptzStop = async () => ({ ok: true });
    ptzPositions = async () => ({ positions: [{ id: 30, name: 'Position 1' }], error: null });
    ptzGoToPosition = fakes.ptzGoToPosition;
    ptzSavePosition = fakes.ptzSavePosition;
    ptzDeletePosition = async () => ({ ok: true });
    // measured seam (Task 3.1): `login` used to be a class FIELD (an instance property, invisible to the
    // prototype that the wizard cases' spyOn uses — same rule as the block below). The three recording
    // methods are here because case 3 spies on the prototype before Finish calls them.
    async login() { return { token: 'tk', capabilities: fakes.meCaps }; }
    async settings() {
      return { archive_dir_effective: '/srv/grav',
        retention_days: 3, disk_max_percent: 80,
        disk: { path: '/srv/grav', used_percent: 0, total_bytes: 0, free_bytes: 0, limited: false, error: null } };
    }
    async settingsPatch(_p: unknown) { return {}; }
    logout = () => {};
    // F4: the App reads the identity from the SERVER at boot (`me`) and administration sits behind a
    // button — the double needs both or the first render explodes. Both below are METHODS (not class
    // fields): that is what makes `vi.spyOn(ApiClient.prototype, ...)` work in the new cases — a class
    // field becomes an INSTANCE property and does not exist on the prototype.
    async me() { return { username: 'admin', profile_id: 'admin', status: 'active', must_change_password: false,
      capabilities: fakes.meCaps }; }
    async changePassword() { return { token: 'novo', expires_at: 1, username: 'admin', must_change_password: false }; }
    // spec 2026-10-20 §5: the administration tabs read the paged envelope
    users = async () => ({ items: [], total: 0, limit: 10, offset: 0 });
    accessProfiles = async () => ({ items: [], total: 0, limit: 10, offset: 0 });
    accessProfileGrants = async () => [];
  },
}));

import App from './App';
import { LanguageProvider } from '@/shared/i18n';
// only the TYPE (erased at compile): the real module is the `vi.mock` above — the new cases' cast needs the
// method signature names, not the value.
import type { ApiClient } from '@/shared/utils/api';
import { clearLiveViewSnapshot } from '@/features/live/pages/LiveView';
import { clearArchiveSnapshot } from '@/features/archive/pages/ArchiveView';

// spec 2026-10-19: the App reads the language from the context — the cases mount inside the provider, like main.tsx.
const renderApp = () => render(<LanguageProvider><App /></LanguageProvider>);

// phase 4: the eight capabilities of server/lib/rbac.js (the parity test pins the union).
const ALL_CAPS = ['camera.view', 'camera.control', 'camera.manage', 'camera.manage.global',
    'settings.manage', 'users.manage', 'profiles.manage', 'retention.manage'];

// jsdom does not implement DragEvent: the dataTransfer goes in the event init (StageGrid.test pattern)
const dtFake = (dados: Record<string, string> = {}) => ({
  setData: (t: string, v: string) => { dados[t] = v; },
  getData: (t: string) => dados[t] ?? '',
  effectAllowed: '',
});

beforeEach(() => {
  localStorage.setItem('openvms.server', 'http://x');
  localStorage.removeItem('openvms.panels'); // each case chooses the preference it wants to measure
  localStorage.setItem('openvms.lang', 'en'); // product default is pt-BR; this suite asserts English; each language case chooses its own
  sessionStorage.setItem('openvms.token', 'tk');
  vi.clearAllMocks();
  fakes.cameras = [{ id: 'c1', name: 'Cam 1', state: 'online', profile_ids: [], can_control: true }];
  fakes.exportRangeChamado = false;
  fakes.meCaps = ALL_CAPS; // each gate case narrows them; everyone else keeps the full set
  fakes.devices = [];
  fakes.groups = [];
  fakes.layouts = [];
  // spec 2026-10-17 (E6): the view snapshots are MODULE state — without clearing, one case's stage comes
  // back in the next one (the handle test would mount the cells of a fixture that is not its own)
  clearLiveViewSnapshot();
  clearArchiveSnapshot();
});

describe('tree actions through PromptDialog (spec promptdialog)', () => {
  it('Rename opens the dialog with the current name and Enter calls renameCamera', async () => {
    renderApp();
    fireEvent.contextMenu(await screen.findByText('Cam 1'));
    fireEvent.click(await screen.findByText('Rename'));
    const input = await screen.findByLabelText('Name');
    expect((input as HTMLInputElement).value).toBe('Cam 1');
    fireEvent.change(input, { target: { value: 'Nova' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fakes.renameCamera).toHaveBeenCalledWith('c1', 'Nova'));
  });
  it('Cancel in the Delete dialog deletes nothing', async () => {
    renderApp();
    fireEvent.contextMenu(await screen.findByText('Cam 1'));
    fireEvent.click(await screen.findByText('Delete camera'));
    expect(await screen.findByText('Delete camera "Cam 1"? Its profiles and credentials will be removed too.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fakes.deleteCamera).not.toHaveBeenCalled();
  });
});

// spec 2026-10-17: the cell joystick opens the panel in the right sidebar and the panel stays open while the
// mode is on, even with the saved preference saying "closed".
describe('PTZ panel in the right sidebar', () => {
  const pcs: { ontrack: ((ev: unknown) => void) | null }[] = [];

  beforeEach(() => {
    localStorage.setItem('openvms.panels', JSON.stringify({ left: false, right: true }));
    pcs.length = 0;
    vi.stubGlobal('RTCPeerConnection', class {
      ontrack: ((ev: unknown) => void) | null = null;
      onconnectionstatechange = null; connectionState = 'connecting';
      constructor() { pcs.push(this as { ontrack: ((ev: unknown) => void) | null }); }
      addTransceiver() {}
      async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
      async setLocalDescription() {} async setRemoteDescription() {} close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0' })));
  });

  it('the cell joystick opens the panel in the right bar and keeps the bar open', async () => {
    const { container } = renderApp();

    // the camera enters the stage through the real tree path (double click)
    fireEvent.doubleClick(await screen.findByText('Cam 1'));
    // the saved preference is "right closed": the bar starts collapsed
    expect(container.querySelector('.shell')?.className).toContain('rec-dir');

    // the button only shows with the first frame: the stub's ontrack plays the video
    await waitFor(() => expect(pcs.length).toBeGreaterThan(0));
    act(() => { pcs[0].ontrack?.({ streams: [{ id: 's1' }], track: null }); });
    const button = await screen.findByRole('button', { name: 'PTZ' });
    fireEvent.click(button);

    // the panel opens by opening the bar, even with the saved preference saying "closed"
    await waitFor(() => expect(container.querySelector('.painel-ptz')).not.toBeNull());
    expect(container.querySelector('.shell')?.className).not.toContain('rec-dir');
    expect(container.querySelector('.rightpanel')?.className).toContain('ptz');
    expect(screen.queryByLabelText('Collapse panel')).toBeNull();  // no collapse button with the mode on
    expect(screen.getByText('Saved positions')).toBeInTheDocument();

    // the second click turns it off and the bar goes back to the saved state
    fireEvent.click(button);
    await waitFor(() => expect(container.querySelector('.painel-ptz')).toBeNull());
    expect(container.querySelector('.shell')?.className).toContain('rec-dir');
  });
});

// spec 2026-10-17 (M4): the /design route is derived from the path — no react-router and no new backend.
// The case is the LAST of the file and restores the path in afterEach: the three cases above run on `/`.
describe('/design route', () => {
  afterEach(() => { window.history.replaceState({}, '', '/'); });

  it('the design system catalog takes the screen in place of the shell', async () => {
    window.history.replaceState({}, '', '/design');
    const { container } = renderApp();
    expect(await screen.findByText('Design system catalog')).toBeInTheDocument();
    expect(container.querySelector('.shell')).toBeNull();
    expect(container.querySelector('[data-design]')).not.toBeNull();
  });
});

// spec 2026-10-17 (item 1.2): the draggable divider. The App keeps the width (usePanels writes to
// `openvms.panels`) and the handle writes the grid variable straight into the shell style during the gesture.
describe('draggable panel divider (item 1.2)', () => {
  // jsdom returns a 0x0 rectangle for every element (same pads as StageGrid.test): without injecting the
  // shell measure the drag would have no coordinate to compute the width from
  const box = { left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  const pref = (dados: Record<string, unknown>) => localStorage.setItem('openvms.panels', JSON.stringify(dados));

  // the shell only exists AFTER the effect that restores the session (the App mounts LoginPage first):
  // the case waits for the shell to appear before measuring — without that the spy has no object to measure
  async function mountShell() {
    const { container } = renderApp();
    const shell = await waitFor(() => {
      const el = container.querySelector('.shell') as HTMLElement | null;
      if (!el) throw new Error('the shell has not mounted yet');
      return el;
    });
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue(box);
    return shell;
  }

  it('both handles exist, are focusable separators and announce today\'s width', async () => {
    pref({ left: false, right: false });   // both panels OPEN: 220 and 260 are the CSS defaults
    renderApp();
    const left = await screen.findByLabelText('Panel width (left)');
    const right = screen.getByLabelText('Panel width (right)');
    expect([left, right].map((el) => el.getAttribute('role'))).toEqual(['separator', 'separator']);
    for (const [el, value] of [[left, '220'], [right, '260']] as [HTMLElement, string][]) {
      expect(el).toHaveAttribute('aria-orientation', 'vertical');
      expect(el).toHaveAttribute('aria-valuenow', value);
      expect(el).toHaveAttribute('aria-valuemin', '160');
      expect(el).toHaveAttribute('aria-valuemax', '410');   // 40% of the jsdom 1024 window
      expect(el).toHaveAttribute('tabindex', '0');
    }
  });

  it('dragging the handle writes the width INTO THE SHELL and stores the new key', async () => {
    pref({ left: false, right: false });
    const shell = await mountShell();
    const handle = await screen.findByLabelText('Panel width (left)');
    fireEvent.pointerDown(handle, { button: 0, clientX: 220 });
    // the gesture writes DIRECTLY into the style (no setState per pointermove): the value already holds before the end.
    // 318 = 320 from the pointer - 2 of half track (1 of gap + 1 of the 2px half track, spec 2026-10-18/trilha-2px).
    fireEvent.pointerMove(handle, { clientX: 320 });
    expect(shell.style.getPropertyValue('--col-esq')).toBe('318px');
    fireEvent.pointerUp(handle, { clientX: 320 });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('openvms.panels') as string).leftWidth).toBe(318));
    expect(shell.style.getPropertyValue('--col-esq')).toBe('318px');
    expect(handle).toHaveAttribute('aria-valuenow', '318');   // the handle announces the width that stuck
  });

  // spec 2026-10-18 (section 6.1, item 2): the drag is a WINDOW session — the pointer leaves the 6px of the
  // track on the first movement, and the gesture has to continue. This case is what the operator's bug asked
  // for: hold the handle and drag without depending on where the pointer is. And a click without movement stores nothing.
  it('the drag session lives on window: move/release outside the handle and a click without drag stores nothing', async () => {
    pref({ left: false, right: false });
    const shell = await mountShell();
    const handle = await screen.findByLabelText('Panel width (left)');
    // the pointer lands in the track strip with the panel at 220 (220 + gap 1 + track 2 + gap 1)
    fireEvent.pointerDown(handle, { button: 0, clientX: 224 });
    fireEvent.pointerMove(window, { clientX: 324 });
    expect(shell.style.getPropertyValue('--col-esq')).toBe('322px');   // 324 - 2 of half track
    fireEvent.pointerUp(window, { clientX: 324 });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('openvms.panels') as string).leftWidth).toBe(322));

    // a click without dragging does not become an explicit width: the key stays as it was (no `leftWidth`)
    localStorage.setItem('openvms.panels', JSON.stringify({ left: false, right: false }));
    fireEvent.pointerDown(handle, { button: 0, clientX: 224 });
    fireEvent.pointerUp(window, { clientX: 224 });
    expect(JSON.parse(localStorage.getItem('openvms.panels') as string).leftWidth).toBeUndefined();
    expect(shell.style.getPropertyValue('--col-esq')).toBe('322px');   // the previous gesture still holds
  });

  it('the drag respects the minimum and EXPANDS the collapsed panel (spec 1.2)', async () => {
    pref({ left: true, right: true });     // left collapsed: the 32px strip
    const shell = await mountShell();
    expect(shell.className).toContain('rec-esq');
    const handle = await screen.findByLabelText('Panel width (left)');
    expect(handle).toHaveAttribute('aria-valuenow', '32');
    fireEvent.pointerDown(handle, { button: 0, clientX: 32 });
    fireEvent.pointerMove(handle, { clientX: 40 });   // far below the 160 minimum
    fireEvent.pointerUp(handle, { clientX: 40 });
    await waitFor(() => expect(shell.className).not.toContain('rec-esq'));
    expect(shell.style.getPropertyValue('--col-esq')).toBe('160px');
  });

  it('double click goes back to the default, deletes the key, and collapsing still works', async () => {
    pref({ left: false, right: true });
    const shell = await mountShell();
    const handle = await screen.findByLabelText('Panel width (left)');
    fireEvent.pointerDown(handle, { button: 0, clientX: 220 });
    // 298 = 300 from the pointer - 2 of half track, the SAME compensation as the previous case
    fireEvent.pointerMove(handle, { clientX: 300 });
    fireEvent.pointerUp(handle, { clientX: 300 });
    await waitFor(() => expect(shell.style.getPropertyValue('--col-esq')).toBe('298px'));

    fireEvent.doubleClick(handle);
    await waitFor(() => expect(shell.style.getPropertyValue('--col-esq')).toBe(''));
    expect(JSON.parse(localStorage.getItem('openvms.panels') as string).leftWidth).toBeUndefined();

    // the collapse button still collapses: without inline, the width is decided by `.shell.rec-esq`
    fireEvent.click(screen.getByLabelText('Collapse menu'));
    await waitFor(() => expect(shell.className).toContain('rec-esq'));
    expect(shell.style.getPropertyValue('--col-esq')).toBe('');
  });

  it('the arrows move in 8px steps', async () => {
    pref({ left: false, right: true });
    const shell = await mountShell();
    const handle = await screen.findByLabelText('Panel width (left)');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await waitFor(() => expect(shell.style.getPropertyValue('--col-esq')).toBe('228px'));
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    await waitFor(() => expect(shell.style.getPropertyValue('--col-esq')).toBe('220px'));
    // the other arrow does not move this handle
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(shell.style.getPropertyValue('--col-esq')).toBe('220px');
  });
});

// spec 2026-10-17 (item 1.3): the DVR as a folder in the App — opening the children on the stage, the menu
// with the three actions, the drop that moves the recorder and the label of a camera inside a folder.
describe('the DVR as a folder (item 1.3)', () => {
  // the measured DVR: 2 channels, the children linked by device_id, and the recorder at the tree root
  const withDvr = () => {
    fakes.devices = [{ id: 'd1', name: 'DVR', group_id: null }];
    fakes.cameras = [
      { id: 'd1c1', name: 'Channel 1', state: 'online', profile_ids: [], device_id: 'd1' },
      { id: 'd1c2', name: 'Channel 2', state: 'online', profile_ids: [], device_id: 'd1' },
    ];
  };

  it('double click on the DVR puts its CHILDREN on the stage (1.3a)', async () => {
    withDvr();
    const { container } = renderApp();
    fireEvent.doubleClick(await screen.findByText('DVR'));
    await waitFor(() => expect(container.querySelectorAll('.stage-grid .cell-name').length).toBe(2));
    expect([...container.querySelectorAll('.stage-grid .cell-name')].map((e) => e.textContent)).toEqual(['Channel 1', 'Channel 2']);
  });

  it('the DVR menu renames through the device PATCH (1.3f)', async () => {
    withDvr();
    renderApp();
    fireEvent.contextMenu(await screen.findByText('DVR'));
    fireEvent.click(await screen.findByText('Rename'));
    const input = await screen.findByLabelText('Name');
    expect((input as HTMLInputElement).value).toBe('DVR');
    fireEvent.change(input, { target: { value: 'DVR Central' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fakes.renameDevice).toHaveBeenCalledWith('d1', 'DVR Central'));
    expect(fakes.renameCamera).not.toHaveBeenCalled();
  });

  it('Delete recorder says the camera count and deletes the device (1.3g)', async () => {
    withDvr();
    renderApp();
    fireEvent.contextMenu(await screen.findByText('DVR'));
    fireEvent.click(await screen.findByText('Delete recorder'));
    expect(await screen.findByText('Delete recorder "DVR" and its 2 cameras? Their profiles, recordings and credentials will be removed too.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(fakes.deleteDevice).toHaveBeenCalledWith('d1'));
    // the cascade on the children belongs to the SERVER: the client does not delete camera by camera
    expect(fakes.deleteCamera).not.toHaveBeenCalled();
  });

  it('dropping the DVR on a folder moves the DEVICE, not the children (1.3b/d)', async () => {
    withDvr();
    fakes.groups = [{ id: 'g1', name: 'HQ', parent_id: null }];
    renderApp();
    const folder = (await screen.findByText('HQ')).closest('.tree-cabeca') as HTMLElement;
    // the same drop carries both payloads (the DVR drags its children as cameras AND its own id)
    fireEvent.drop(folder, { dataTransfer: dtFake({ 'application/x-ovms-camera': 'd1c1,d1c2', 'application/x-ovms-device': 'd1' }) });
    await waitFor(() => expect(fakes.moveDevice).toHaveBeenCalledWith('d1', 'g1'));
    expect(fakes.moveCamera).not.toHaveBeenCalled();
  });

  it('a camera inside a folder says "Create subgroup" and creates its subfolder (1.3e)', async () => {
    fakes.groups = [{ id: 'g1', name: 'HQ', parent_id: null }];
    fakes.cameras = [{ id: 'c1', name: 'Gate 1', state: 'online', profile_ids: [], group_id: 'g1' }];
    renderApp();
    fireEvent.contextMenu(await screen.findByText('Gate 1'));
    fireEvent.click(await screen.findByText('Create subgroup'));
    const input = await screen.findByLabelText('Name');
    fireEvent.change(input, { target: { value: 'Back' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // the destination of the new folder is the folder WHERE the camera is (not the root)
    await waitFor(() => expect(fakes.createGroup).toHaveBeenCalledWith({ name: 'Back', parent_id: 'g1' }));
    // and the camera still enters the new folder, as "Create group" always did
    await waitFor(() => expect(fakes.moveCamera).toHaveBeenCalledWith('c1', 'g9'));
  });
});

// spec 2026-10-17 (header search): the sidebar's first row is search + toggle.
describe('sidebar header (spec busca-cabecalho)', () => {
  it('shows the search and the toggle in the row; there is no "Server" and no counts anymore', async () => {
    renderApp();
    // explicit timeout: the 1s default is tight when the 58 suites run in parallel (jsdom per file)
    await screen.findByText('Cam 1', {}, { timeout: 5000 });
    const search = screen.getByLabelText('Search cameras and layouts');
    const head = search.closest('.sidebar-head');
    expect(head).not.toBeNull();
    expect(head!.querySelector('.painel-toggle')).not.toBeNull();
    expect(screen.queryByText('Server')).toBeNull();
    // the counts row: the App wrote it as `${n} cameras` (always plural). A `queryByText('1 camera')` here
    // would be a TAUTOLOGY — nothing in the document has that string, not even before the change. The whole
    // header text is the discriminating predicate: restoring the span fails this case.
    expect(head!.textContent).not.toMatch(/cameras|folders/);
  });
});

// spec 2026-10-17: the export list left the Archive stage and moved into the BODY of the right panel,
// visible only with it expanded (the collapse is CSS: `.shell.rec-dir .rightpanel > *:not(.rightpanel-head)`)
// and only on the Archive tab. jsdom does not compute CSS, so what this case proves is the DOM POSITION.
describe('exports in the right panel (spec 2026-10-17)', () => {
  it('on the Archive tab the list sits INSIDE the right panel; on Live it does not exist', async () => {
    localStorage.setItem('openvms.panels', JSON.stringify({ left: false, right: false }));
    const { container } = renderApp();
    const panel = await waitFor(() => {
      const el = container.querySelector('.rightpanel') as HTMLElement | null;
      if (!el) throw new Error('the right panel has not mounted yet');
      return el;
    });

    // Live tab (the App default): the section does not exist anywhere
    expect(panel.querySelector('.painel-exports')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(panel.querySelector('.painel-exports')).not.toBeNull());
    expect(panel.querySelector('.painel-exports h2')?.textContent).toBe('Recent exports');
    // spec 2026-10-23: the per-item download link is GONE. A finished item has a checkbox and the
    // batch action appears in the panel footer as soon as there is a selection.
    expect(panel.querySelector('.painel-exports li a')).toBeNull();
    expect(panel.querySelectorAll('.painel-exports input[type="checkbox"]').length).toBe(2);
    expect(panel.querySelector('.painel-exports-acoes')).toBeNull();
    // the section is a child of the PANEL: the stage has no strip anymore
    expect(container.querySelector('.archive-body .painel-exports')).toBeNull();
    expect(container.querySelector('.archive-body .exports')).toBeNull();
  });

  // defective 2026-10-25, measured in production: the export created by the dialog only showed up after F5.
  // The panel refetches when the App bumps `exportTick`; this case walks the real flow (dialog -> POST ->
  // panel) and the double answers with the new job once `exportRange` was called.
  it('a exportacao criada aparece no painel direito SEM recarregar', async () => {
    fakes.exportRangeChamado = false;
    fakes.cameras = [{ id: 'c1', name: 'BONFIM ENTRADA', state: 'online', profile_ids: ['p1'] }];
    const { container } = renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(container.querySelector('.arquivo-stage')).toBeTruthy());
    // the dialog only offers the cameras ON THE STAGE (they are the ones with a recording profile)
    const tree = await waitFor(() => {
      const el = container.querySelector('ul.tree') as HTMLElement | null;
      if (!el) throw new Error('the camera tree has not mounted yet');
      return within(el);
    });
    fireEvent.doubleClick(await tree.findByText('BONFIM ENTRADA'));
    await waitFor(() => expect(container.querySelectorAll('.arquivo-stage .stage-cell').length).toBe(1));
    await waitFor(() => expect(container.querySelectorAll('.painel-exports li').length).toBe(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'Fuga' } });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(container.querySelectorAll('.painel-exports li').length).toBe(2));
  });
});

// spec 2026-10-17 (tab state): the view snapshot is MODULE state, so logout has to clear it. Without the
// clearing, whoever logs in next opens with the previous operator's stage. The case is the discriminator of
// `App.tsx`: with the Phase 1 snapshot and no logout clearing, it goes RED.
describe('logging out clears the view state (spec 2026-10-17)', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', class {
      addTransceiver() {} ontrack = null; onconnectionstatechange = null; connectionState = 'connecting';
      async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
      async setLocalDescription() {} async setRemoteDescription() {} close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0' })));
  });

  it('after leaving and coming back, the stage is empty again', async () => {
    const { container } = renderApp();
    // the camera enters the stage through the real tree path (double click), as in the PTZ case
    fireEvent.doubleClick(await screen.findByText('Cam 1'));
    await waitFor(() => expect(container.querySelectorAll('.stage-grid .cell-name').length).toBe(1));

    fireEvent.click(screen.getByLabelText('User menu'));
    fireEvent.click(screen.getByText('Log out'));
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByText('Sign in'));

    await screen.findByText('Cam 1', {}, { timeout: 5000 });
    expect(container.querySelectorAll('.stage-grid .cell-name').length).toBe(0);
    expect(screen.getByText('Drag a camera here')).toBeInTheDocument();
  });
});

// spec 2026-10-18 videowall-paridade: the T1-T7 table of section 5. The active tab is Archive;
// the Live control closes the table.
describe('videowall parity on the Archive tab (spec 2026-10-18)', () => {
  const savedLayout = { id: 'L1', name: 'Saved', cells: [
    { id: 'x1', col: 0, row: 0, colspan: 2, rowspan: 1, content: { kind: 'live', camera_id: 'c1' } }] };

  beforeEach(() => {
    fakes.layouts = [savedLayout];
    // spec 2026-10-27: g2 is a SUBFOLDER with its own camera — T2/T4 must NOT open Cam 3
    fakes.groups = [
      { id: 'g1', name: 'Folder', parent_id: null },
      { id: 'g2', name: 'Sub', parent_id: 'g1' },
    ];
    fakes.cameras = [
      { id: 'c1', name: 'Cam 1', state: 'online', profile_ids: [], group_id: 'g1' },
      { id: 'c2', name: 'Cam 2', state: 'online', profile_ids: [], group_id: 'g1' },
      { id: 'c3', name: 'Cam 3', state: 'online', profile_ids: [], group_id: 'g2' },
    ];
  });

  // LayoutTree expands the saved layout and shows Cam 1 also as a child; the target is always the camera
  // tree row (ul.tree), not the loose getByText that would match two.
  const cameraTree = (container: HTMLElement) => within(container.querySelector('ul.tree') as HTMLElement);
  const onArchive = async (container: HTMLElement) => {
    // ul.tree only exists after the catalog loads (within is immediate, it does not wait by itself)
    await waitFor(() => expect(container.querySelector('ul.tree')).toBeTruthy());
    await cameraTree(container).findByText('Cam 1');
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(container.querySelector('.arquivo-stage')).toBeTruthy());
  };

  it('T1: double click on the camera puts the camera on the Archive stage', async () => {
    const { container } = renderApp();
    await onArchive(container);
    fireEvent.doubleClick(cameraTree(container).getByText('Cam 1'));
    await waitFor(() => expect(container.querySelectorAll('.arquivo-stage .stage-cell')).toHaveLength(1));
  });

  it('T2: double click on the folder puts its DIRECT cameras on the Archive stage', async () => {
    const { container } = renderApp();
    await onArchive(container);
    fireEvent.doubleClick(screen.getByText('Folder'));
    await waitFor(() => expect(container.querySelectorAll('.arquivo-stage .stage-cell')).toHaveLength(2));
  });

  it('T3: camera drop on the Archive stage; a duplicate does not enter', async () => {
    const { container } = renderApp();
    await onArchive(container);
    const grid = container.querySelector('.arquivo-stage .stage-grid') as HTMLElement;
    fireEvent.drop(grid, { dataTransfer: dtFake({ 'application/x-ovms-camera': 'c1' }), clientX: 10, clientY: 10 });
    await waitFor(() => expect(container.querySelectorAll('.arquivo-stage .stage-cell')).toHaveLength(1));
    fireEvent.drop(grid, { dataTransfer: dtFake({ 'application/x-ovms-camera': 'c1' }), clientX: 10, clientY: 10 });
    expect(container.querySelectorAll('.arquivo-stage .stage-cell')).toHaveLength(1);
  });

  it('T4: folder drop enters the batch in cascade', async () => {
    const { container } = renderApp();
    await onArchive(container);
    const grid = container.querySelector('.arquivo-stage .stage-grid') as HTMLElement;
    fireEvent.drop(grid, { dataTransfer: dtFake({ 'application/x-ovms-group': 'g1' }), clientX: 10, clientY: 10 });
    await waitFor(() => expect(container.querySelectorAll('.arquivo-stage .stage-cell')).toHaveLength(2));
  });

  it('T5: layout drop (tree payload) opens the layout tab on Archive', async () => {
    const { container } = renderApp();
    await onArchive(container);
    fireEvent.drop(container.querySelector('.arquivo-stage') as HTMLElement, {
      dataTransfer: dtFake({ 'application/x-ovms-layout': 'L1' }),
    });
    await waitFor(() => expect(container.querySelector('.arquivo-stage .stage-cell')?.getAttribute('style')).toContain('span 2'));
    // spec 2026-10-18 (videowall recording tabs, revokes D6): the layout opens in a NAMED tab, as on Live
    expect(container.querySelector('.arquivo-stage .stage-tab.active')?.textContent).toContain('Saved');
  });

  it('T6: double click on the layout opens the layout tab on Archive', async () => {
    const { container } = renderApp();
    await onArchive(container);
    fireEvent.doubleClick(within(container.querySelector('.layout-tree') as HTMLElement).getByText('Saved'));
    await waitFor(() => expect(container.querySelector('.arquivo-stage .stage-cell')?.getAttribute('style')).toContain('span 2'));
    expect(container.querySelector('.arquivo-stage .stage-tab.active')?.textContent).toContain('Saved');
  });

  // spec 2026-10-18 (videowall recording tabs, sec 8): saving a layout on Archive refreshes the tree through
  // `onLayoutsChanged` — the same contract LiveView already had.
  it('T8: saving a layout on Archive refreshes the tree (onLayoutsChanged)', async () => {
    fakes.saveLayout.mockImplementation(async (d: { id?: string; name: string; cells?: unknown[] }) => {
      const saved = { id: d.id || 'l-novo', name: d.name, cells: d.cells ?? [] };
      fakes.layouts = [...fakes.layouts, saved];
      return saved;
    });
    const { container } = renderApp();
    await onArchive(container);
    const grid = container.querySelector('.arquivo-stage .stage-grid') as HTMLElement;
    fireEvent.drop(grid, { dataTransfer: dtFake({ 'application/x-ovms-camera': 'c1' }), clientX: 10, clientY: 10 });
    await waitFor(() => expect(container.querySelector('.arquivo-stage .stage-tab.active')?.textContent).toContain('*'));
    fireEvent.contextMenu(container.querySelector('.arquivo-stage .stage-tab.active') as HTMLElement);
    fireEvent.click(await screen.findByText('Save'));
    const input = await screen.findByLabelText('Name');
    fireEvent.change(input, { target: { value: 'Mural' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fakes.saveLayout).toHaveBeenCalledWith(expect.objectContaining({ name: 'Mural' })));
    await within(container.querySelector('.layout-tree') as HTMLElement).findByText('Mural');
  });

  it('T7: Live control — layout drop opens the tab and the camera enters by double click', async () => {
    const { container } = renderApp();
    await waitFor(() => expect(container.querySelector('ul.tree')).toBeTruthy());
    await cameraTree(container).findByText('Cam 1');
    fireEvent.doubleClick(cameraTree(container).getByText('Cam 1'));
    await waitFor(() => expect(container.querySelector('.mode-view .stage-cell')).toBeTruthy());
    fireEvent.drop(container.querySelector('.mode-view') as HTMLElement, {
      dataTransfer: dtFake({ 'application/x-ovms-layout': 'L1' }),
    });
    // the 'Saved' of the Live control is the stage tab title (the saved name); the drop opens the tab
    await waitFor(() => expect(within(container.querySelector('.stage-tabs') as HTMLElement)
      .getByText('Saved')).toBeInTheDocument());
  });
});


// spec §7.1.4/§12-F4: with the change pending the App does NOT mount the shell — the mandatory modal takes
// the screen until the password is changed. The discriminator is `me()` (the server's truth, not a cache).
describe('forced password change (spec §7.1.4)', () => {
  it('shows only the modal and then releases the shell with the new token', async () => {
    const changed: string[] = [];
    const api = await import('@/shared/utils/api');
    // the double is the vi.mock class: changing its behavior requires remaking the mock per case. The cast
    // tells TS the prototype METHODS (a class field is not there — `as never` would become `never` in the
    // spyOn return and `.mockImplementation` would not compile).
    const proto = api.ApiClient.prototype as unknown as Pick<ApiClient, 'me' | 'changePassword'>;
    vi.spyOn(proto, 'me').mockImplementation(async () => ({
      username: 'ana', profile_id: 'viewer', status: 'active', must_change_password: true,
      capabilities: [],
    }));
    vi.spyOn(proto, 'changePassword').mockImplementation(async () => {
      changed.push('ok');
      return { token: 'tk2', expires_at: 1, username: 'ana', must_change_password: false };
    });
    const { container } = renderApp();
    expect(await screen.findByText('Password change required')).toBeInTheDocument();
    expect(container.querySelector('.shell')).toBeNull();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'Temp-1' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'senha-nova-longa' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'senha-nova-longa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(changed).toEqual(['ok']));
    await waitFor(() => expect(container.querySelector('.shell')).not.toBeNull());
    expect(sessionStorage.getItem('openvms.token')).toBe('tk2');
  });

  it('leaving the change screen (the X) goes back to login', async () => {
    const api = await import('@/shared/utils/api');
    const proto = api.ApiClient.prototype as unknown as Pick<ApiClient, 'me'>;
    vi.spyOn(proto, 'me').mockImplementation(async () => ({
      username: 'ana', profile_id: 'viewer', status: 'active', must_change_password: true,
      capabilities: [],
    }));
    renderApp();
    const modal = await screen.findByText('Password change required');
    fireEvent.click(modal.closest('.nx-dialog')!.querySelector('.nx-close')!);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();   // back to the login form
  });
});

// spec 2026-10-18 (topbar user menu and statusbar): the topbar items became a dropdown; the statusbar
// became a row of three items.
describe('topbar user menu and statusbar (spec 2026-10-18)', () => {
  // plan divergence (reported): the "forced password change" cases (describe above) spy on `me` on the
  // ApiClient prototype and never restore it — the global beforeEach only runs clearAllMocks, which does
  // not undo mockImplementation. This describe was appended AT THE END OF THE FILE, so it would inherit the
  // last spy (must_change_password: true / operator) and the mandatory modal would swallow the shell.
  // restoreAllMocks gives the double's original method back; the vi.fn fakes (rename etc.) are not affected
  // by it in vitest 5.
  beforeEach(() => { vi.restoreAllMocks(); });
  it('the topbar no longer shows URL, Events, Settings or Log out (closed)', async () => {
    renderApp();
    await screen.findByLabelText('User menu');
    expect(screen.queryByText('Events')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.queryByText('Log out')).toBeNull();
    expect(screen.queryByText('http://x')).toBeNull();
  });

  it('the admin dropdown shows name, profile, Settings and Log out (in this order)', async () => {
    renderApp();
    fireEvent.click(await screen.findByLabelText('User menu'));
    expect(document.querySelector('.user-menu-head')!.textContent).toContain('admin');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((b) => b.textContent)).toEqual(['Settings', 'Log out']);
  });

  it('non-admin: no Settings; Log out present', async () => {
    // pattern of the forced change cases (lines 543-551): VALUE import + cast
    const api = await import('@/shared/utils/api');
    const proto = api.ApiClient.prototype as unknown as Pick<ApiClient, 'me'>;
    vi.spyOn(proto, 'me').mockImplementation(async () => ({
      username: 'operador', profile_id: 'operator', status: 'active', must_change_password: false,
      capabilities: [],
    }));
    renderApp();
    fireEvent.click(await screen.findByLabelText('User menu'));
    expect(screen.queryByRole('menuitem', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
  });

  it('Settings opens the AdminModal and closes the dropdown', async () => {
    renderApp();
    fireEvent.click(await screen.findByLabelText('User menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    await screen.findByText('Access profiles');
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('statusbar: status, Server and Cameras in one row, in this order', async () => {
    const { container } = renderApp();
    await screen.findByText('● online', {}, { timeout: 8000 });
    const spans = Array.from(container.querySelectorAll('.statusbar span')).map((s) => s.textContent);
    expect(spans).toEqual(['● online', 'Server: http://x', 'Cameras: 1 / 1 online']);
    expect(screen.queryByText(/server v/)).toBeNull();
    expect(screen.queryByText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)).toBeNull();
  });
});

// spec 2026-10-19 (onboarding D1/D2): the gate picks the modal by the SERVER's first_run. The password
// typed at login goes to the App in memory (never sessionStorage) and becomes step 1's `current`.
// The old change fixtures (ana, me without first_run) stay intact — oracle of the live flow.
describe('onboarding wizard on first use (spec 2026-10-19)', () => {
  const loginForm = async () => {
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Temp-1' } });
    fireEvent.click(screen.getByText('Sign in'));
  };
  const recordingCfg = {
    archive_dir_effective: '/srv/grav',
    retention_days: 3, disk_max_percent: 80,
    disk: { path: '/srv/grav', used_percent: 12, total_bytes: 100, free_bytes: 88, limited: false, error: null },
  };

  it('login first_run true + pending change: opens the WIZARD, not ForcedPasswordChange', async () => {
    sessionStorage.removeItem('openvms.token');
    const api = await import('@/shared/utils/api');
    const proto = api.ApiClient.prototype as unknown as Pick<ApiClient, 'login'>;
    vi.spyOn(proto, 'login').mockImplementation(async () => ({
      token: 'tk1', expires_at: 1, username: 'admin', profile_id: 'admin',
      must_change_password: true, first_run: true, capabilities: ALL_CAPS,
    }));
    renderApp();
    await loginForm();
    expect(await screen.findByText('Initial setup')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 2 · Administrator password')).toBeInTheDocument();
    expect(screen.queryByText('Password change required')).toBeNull();
  });

  it('login with a pending change and first_run false (reset): keeps ForcedPasswordChange', async () => {
    sessionStorage.removeItem('openvms.token');
    const api = await import('@/shared/utils/api');
    const proto = api.ApiClient.prototype as unknown as Pick<ApiClient, 'login'>;
    vi.spyOn(proto, 'login').mockImplementation(async () => ({
      token: 'tk1', expires_at: 1, username: 'admin', profile_id: 'admin',
      must_change_password: true, first_run: false, capabilities: ALL_CAPS,
    }));
    renderApp();
    await loginForm();
    expect(await screen.findByText('Password change required')).toBeInTheDocument();
    expect(screen.queryByText('Initial setup')).toBeNull();
  });

  it('wizard finished: the shell mounts with the new token from change-password', async () => {
    sessionStorage.removeItem('openvms.token');
    const api = await import('@/shared/utils/api');
    const proto = api.ApiClient.prototype as unknown as
      Pick<ApiClient, 'login' | 'changePassword' | 'settings' | 'settingsPatch'>;
    vi.spyOn(proto, 'login').mockImplementation(async () => ({
      token: 'tk1', expires_at: 1, username: 'admin', profile_id: 'admin',
      must_change_password: true, first_run: true, capabilities: ALL_CAPS,
    }));
    vi.spyOn(proto, 'changePassword').mockImplementation(async () => ({
      token: 'tk2', expires_at: 1, username: 'admin', must_change_password: false }));
    vi.spyOn(proto, 'settings').mockImplementation(async () => recordingCfg);
    vi.spyOn(proto, 'settingsPatch').mockImplementation(async () => recordingCfg);
    const { container } = renderApp();
    await loginForm();
    await screen.findByText('Step 1 of 2 · Administrator password');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'senha-nova-longa' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'senha-nova-longa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Step 2 of 2 · Recordings');
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(container.querySelector('.shell')).not.toBeNull());
    expect(sessionStorage.getItem('openvms.token')).toBe('tk2');
  });
});

// spec 2026-10-19 (Task 2.3): the language combobox lives in the right corner of the topbar, to the left of
// the user menu, and it is what decides the UI language (dictionaries, localStorage and <html lang>).
describe('language combobox in the topbar (spec 2026-10-19)', () => {
  // the previous describes spy on `me`/`login` on the prototype and do not restore; here the App has to
  // mount with the default double (admin, no pending change), as in the topbar describe.
  beforeEach(() => { vi.restoreAllMocks(); });

  const mount = async () => {
    const { container } = renderApp();
    await screen.findByText('Cam 1', {}, { timeout: 5000 });
    return container;
  };

  it('English default: Live/Archive in the modes and Language in the combobox', async () => {
    await mount();
    expect(screen.getByRole('button', { name: 'Live' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByLabelText('Language')).toHaveValue('en');
    expect(screen.getByLabelText('User menu')).toBeInTheDocument();
    expect(localStorage.getItem('openvms.lang')).toBe('en'); // harness pin; the app itself never persists the default
  });

  it('the combobox is the FIRST child of the right corner, before the user button in the DOM', async () => {
    const container = await mount();
    const right = container.querySelector('.topbar-right') as HTMLElement;
    expect(right.firstElementChild?.tagName).toBe('SELECT');
    expect(right.querySelector('.lang-select')).toBe(right.firstElementChild);
    const select = screen.getByLabelText('Language');
    const button = screen.getByLabelText('User menu');
    expect(select.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('switching to pt-BR translates Live -> Ao vivo, stores the choice and follows <html lang>', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'pt-BR' } });
    expect(await screen.findByRole('button', { name: 'Ao vivo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Live' })).toBeNull();
    expect(localStorage.getItem('openvms.lang')).toBe('pt-BR');
    expect(document.documentElement.lang).toBe('pt-BR');
    // the user menu items also come from the dictionary
    expect(screen.getByLabelText('Menu do usuário')).toBeInTheDocument();
  });

  it('an invalid value in storage falls back to pt-BR', async () => {
    localStorage.setItem('openvms.lang', 'fr');
    await mount();
    expect(screen.getByRole('button', { name: 'Ao vivo' })).toBeInTheDocument();
    expect(screen.getByLabelText('Idioma')).toHaveValue('pt-BR');
    expect(document.documentElement.lang).toBe('pt-BR');
  });
});

// correction 2026-10-26: the live cell menu renames through the SAME dialog as the sidebar.
describe('cell menu rename (correction 2026-10-26)', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', class {
      ontrack: ((ev: unknown) => void) | null = null;
      onconnectionstatechange = null; connectionState = 'connecting';
      addTransceiver() {}
      async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
      async setLocalDescription() {} async setRemoteDescription() {} close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0' })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('the cell menu offers settings, rename and remove, and rename calls the API', async () => {
    const { container } = renderApp();
    fireEvent.doubleClick(await screen.findByText('Cam 1'));   // the camera enters the stage
    await waitFor(() => expect(container.querySelector('.stream-cell')).not.toBeNull());
    fireEvent.contextMenu(container.querySelector('.stream-cell') as HTMLElement);
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Camera settings', 'Deactivate camera', 'Rename', 'Remove from layout']);
    fireEvent.click(screen.getByText('Rename'));
    const input = await screen.findByLabelText('Name');
    fireEvent.change(input, { target: { value: 'Nova' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fakes.renameCamera).toHaveBeenCalledWith('c1', 'Nova'));
  });
});

// spec 2026-10-27 section 6: Live and Archive SHARE the same videowall (the modes only differ in
// operations). These are tests 9-12 of §6.4 — the end-to-end oracles of the shared registry.
describe('shared videowall between Live and Archive (spec 2026-10-27 §6.4)', () => {
  // the describes above spy on the ApiClient prototype (me/login) and do not restore; this one needs
  // the default double (admin, no pending change) for the login/logout flows (same pattern as the
  // topbar/language describes).
  beforeEach(() => {
    vi.restoreAllMocks();
    fakes.cameras = [
      { id: 'c1', name: 'Cam 1', state: 'online', profile_ids: [] },
      { id: 'c2', name: 'Cam 2', state: 'online', profile_ids: [] },
    ];
  });

  const cameraTree = (container: HTMLElement) => within(container.querySelector('ul.tree') as HTMLElement);
  const liveOnStage = async (container: HTMLElement, ...names: string[]) => {
    await waitFor(() => expect(container.querySelector('ul.tree')).toBeTruthy());
    await cameraTree(container).findByText('Cam 1');
    for (const n of names) fireEvent.doubleClick(cameraTree(container).getByText(n));
    await waitFor(() => expect(container.querySelectorAll('.mode-view .stage-cell')).toHaveLength(names.length));
  };
  const onArchive = async (container: HTMLElement) => {
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(container.querySelector('.arquivo-stage')).toBeTruthy());
  };
  const onLive = async (container: HTMLElement) => {
    fireEvent.click(screen.getByRole('button', { name: 'Live' }));
    await waitFor(() => expect(container.querySelector('.mode-view')).toBeTruthy());
  };
  const archiveCells = (container: HTMLElement) => container.querySelectorAll('.arquivo-stage .stage-cell');
  const liveCells = (container: HTMLElement) => container.querySelectorAll('.mode-view .stage-cell');
  const activeTabText = (container: HTMLElement, root: string) =>
    container.querySelector(`${root} .stage-tab.active`)?.textContent;

  // §6.4 test 9: the camera placed on the Live stage is on the Archive stage after the switch
  it('camera on the Live stage is on the Archive stage after switching modes', async () => {
    const { container } = renderApp();
    await liveOnStage(container, 'Cam 1');
    const liveTab = activeTabText(container, '.mode-view');
    await onArchive(container);
    await waitFor(() => expect(archiveCells(container)).toHaveLength(1));
    // same camera, same tab: the Archive page mounted the SHARED registry, not its own empty stage
    expect(archiveCells(container)[0].textContent).toContain('Cam 1');
    expect(activeTabText(container, '.arquivo-stage')).toBe(liveTab);
  });

  // §6.4 test 10: cells and the tab dirty flag survive the Archive -> Live round trip
  it('the stage survives Archive -> Live and the tab keeps its dirty state', async () => {
    const { container } = renderApp();
    await liveOnStage(container, 'Cam 1', 'Cam 2');
    await onArchive(container);
    await waitFor(() => expect(archiveCells(container)).toHaveLength(2));
    // removing one cell on Archive dirties the tab; the flag must come back on Live with the cells
    fireEvent.click(within(archiveCells(container)[0] as HTMLElement).getByTitle('Remove'));
    await waitFor(() => expect(archiveCells(container)).toHaveLength(1));
    expect(activeTabText(container, '.arquivo-stage')).toContain('*');
    await onLive(container);
    await waitFor(() => expect(liveCells(container)).toHaveLength(1));
    expect(activeTabText(container, '.mode-view')).toContain('*');
    expect(liveCells(container)[0].textContent).toContain('Cam 2');
    // and the other way again: the round trip is stable, not a one-time restore
    await onArchive(container);
    await waitFor(() => expect(archiveCells(container)).toHaveLength(1));
  });

  // §6.4 test 11: logout clears the shared registry — the next login opens an empty stage
  it('logout clears the shared stage', async () => {
    const { container } = renderApp();
    await liveOnStage(container, 'Cam 1');
    fireEvent.click(await screen.findByLabelText('User menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    // back to the login form; signing in again must NOT see the previous operator's stage
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Temp-1' } });
    fireEvent.click(screen.getByText('Sign in'));
    await waitFor(() => expect(container.querySelector('.shell')).not.toBeNull());
    await cameraTree(container).findByText('Cam 1');
    expect(liveCells(container)).toHaveLength(0);
    await onArchive(container);
    await waitFor(() => expect(container.querySelector('input[type=date]')).toBeTruthy());
    expect(archiveCells(container)).toHaveLength(0);
  });

  // §6.4 test 12: entering a mode is a MOUNT, not a drop — the pointer rule (§1) must not fire
  it('switching modes does NOT move the Archive pointer', async () => {
    const { container } = renderApp();
    await liveOnStage(container, 'Cam 1');
    await onArchive(container);
    await waitFor(() => expect(container.querySelector('.sheet-relogio')).toBeTruthy());
    await waitFor(() => expect(archiveCells(container)).toHaveLength(1));
    // seek 5 s off the midnight (window shortcut of the page) so T is not a resting default value;
    // the clock is paused, so any change of `.sheet-relogio` here could only come from the mode switch
    fireEvent.keyDown(window, { code: 'ArrowRight' });
    const t = container.querySelector('.sheet-relogio')?.textContent;
    expect(t).toBe('00:00:05');
    await onLive(container);
    expect(liveCells(container)).toHaveLength(1); // the camera crossed to Live untouched
    await onArchive(container);
    await waitFor(() => expect(container.querySelector('.sheet-relogio')).toBeTruthy());
    expect(container.querySelector('.sheet-relogio')?.textContent).toBe(t);
  });
});

// phase 4 (Task 4.1): the global gates read the capabilities of login/me, not the profile name.
describe('capability gates in the App shell (phase 4)', () => {
  it('camera.view only: no add-camera button, no exports panel', async () => {
    fakes.meCaps = ['camera.view'];
    const { container } = renderApp();
    await waitFor(() => expect(container.querySelector('ul.tree')).toBeTruthy());
    await within(container.querySelector('ul.tree') as HTMLElement).findByText('Cam 1');
    expect(screen.queryByText('+ Add camera')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(container.querySelector('.arquivo-stage')).toBeTruthy());
    expect(container.querySelector('.painel-exports')).toBeNull();
  });

  it('the eight capabilities: the add-camera button and the exports panel are there', async () => {
    fakes.meCaps = ALL_CAPS;
    const { container } = renderApp();
    await waitFor(() => expect(container.querySelector('ul.tree')).toBeTruthy());
    await within(container.querySelector('ul.tree') as HTMLElement).findByText('Cam 1');
    expect(screen.getByText('+ Add camera')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(container.querySelector('.painel-exports h2')).toBeTruthy());
    expect(container.querySelector('.painel-exports h2')?.textContent).toBe('Recent exports');
  });
});

// plan 2026-10-27 (camera ativa, task 5.1): the menu liga/desliga actions wired to ONE PATCH per camera
// (same batch pattern as the move loop).
describe('camera ativa actions (plan 2026-10-27, task 5.1)', () => {
  // the double plays the SERVER here: the PATCH writes the flag into the catalog (a NEW array, like a
  // fresh GET) so the refresh that closes act() is what shows the new state in the tree (the pattern
  // after delete).
  const patchNoCatalogo = () => fakes.setCameraOptions.mockImplementation(async (id: string, body: { ativa?: boolean }) => {
    fakes.cameras = fakes.cameras.map((c) => (c.id === id ? { ...c, ativa: body.ativa } : c));
    return {};
  });

  it('toggle-active PATCHES {ativa: !atual} once and the tree reflects the new state', async () => {
    patchNoCatalogo();
    renderApp();
    fireEvent.contextMenu(await screen.findByText('Cam 1'));
    fireEvent.click(await screen.findByText('Deactivate camera'));
    await waitFor(() => expect(fakes.setCameraOptions).toHaveBeenCalledWith('c1', { ativa: false }));
    expect(fakes.setCameraOptions).toHaveBeenCalledTimes(1);
    // the tree goes gray through the `inativa` class (task 4.3) after the refresh of act()
    await waitFor(() => expect(screen.getByText('Cam 1')).toHaveClass('inativa'));
    // MenuTarget carries `ativa`: the reopened menu says "Activate camera" and the click PATCHES true
    fireEvent.contextMenu(screen.getByText('Cam 1'));
    fireEvent.click(await screen.findByText('Activate camera'));
    await waitFor(() => expect(fakes.setCameraOptions).toHaveBeenCalledWith('c1', { ativa: true }));
    expect(fakes.setCameraOptions).toHaveBeenCalledTimes(2);
  });

  it('deactivate-all and activate-all send one PATCH per marked camera (batch, move pattern)', async () => {
    fakes.cameras = [
      { id: 'c1', name: 'Cam 1', state: 'online', profile_ids: [] },
      { id: 'c2', name: 'Cam 2', state: 'online', profile_ids: [] },
      { id: 'c3', name: 'Cam 3', state: 'online', profile_ids: [] },
    ];
    patchNoCatalogo();
    renderApp();
    for (const n of ['Cam 1', 'Cam 2', 'Cam 3']) fireEvent.click(await screen.findByText(n), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByText('Cam 1'));
    fireEvent.click(await screen.findByText('Deactivate all'));
    await waitFor(() => expect(fakes.setCameraOptions).toHaveBeenCalledTimes(3));
    expect(fakes.setCameraOptions.mock.calls.map((c) => c[0]).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(fakes.setCameraOptions.mock.calls.every((c) => c[1].ativa === false)).toBe(true);
    // the selection survives the flag change: the batch menu reopens on the same marked row
    fireEvent.contextMenu(screen.getByText('Cam 1'));
    fireEvent.click(await screen.findByText('Activate all'));
    await waitFor(() => expect(fakes.setCameraOptions).toHaveBeenCalledTimes(6));
    expect(fakes.setCameraOptions.mock.calls.slice(3).map((c) => c[0]).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(fakes.setCameraOptions.mock.calls.slice(3).every((c) => c[1].ativa === true)).toBe(true);
  });

  it('the single menu of an INACTIVE camera says "Activate camera" (MenuTarget carries ativa)', async () => {
    fakes.cameras = [{ id: 'c1', name: 'Cam 1', state: 'online', profile_ids: [], ativa: false }];
    renderApp();
    fireEvent.contextMenu(await screen.findByText('Cam 1'));
    expect(await screen.findByText('Activate camera')).toBeInTheDocument();
    expect(screen.queryByText('Deactivate camera')).toBeNull();
  });
});

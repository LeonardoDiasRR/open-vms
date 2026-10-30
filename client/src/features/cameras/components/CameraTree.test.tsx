import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import CameraTree from './CameraTree';
import SearchField from '@/shared/ui/SearchField';

const noop = () => {};
// spec 2026-10-19: the labels come from the dictionary — the provider mounts with the default (en).
const withProvider = (ui: React.ReactElement) => <LanguageProvider>{ui}</LanguageProvider>;
const renderTree = (ui: React.ReactElement) => render(withProvider(ui));
// `rerender` replaces the root: it must be re-wrapped or the tree loses the provider


describe('CameraTree', () => {
  it('renders the camera of the tree by name', () => {
    renderTree(
      <CameraTree
        groups={[]}
        cameras={[{ id: 'c1', name: 'Portaria', state: 'online' }]}
        selected={null}
        onSelect={noop}
        onAction={noop}
        onDrop={noop}
      />,
    );
    expect(screen.getByText('Portaria')).toBeInTheDocument();
    // plan 2026-10-30: a seção passou a ser a lista de servidores
    expect(screen.getByText('Servers')).toBeInTheDocument();
  });

  it('shows the empty state without cameras', () => {
    renderTree(
      <CameraTree
        groups={[]}
        cameras={[]}
        selected={null}
        onSelect={noop}
        onAction={noop}
        onDrop={noop}
      />,
    );
    expect(screen.getByText('No cameras')).toBeInTheDocument();
  });

  it('the section header has the "+" that opens the server connection (no gate — D4)', () => {
    let clicked = 0;
    renderTree(
      <CameraTree
        groups={[]}
        cameras={[{ id: 'c1', name: 'Portaria', state: 'online' }]}
        selected={null}
        onSelect={noop}
        onAction={noop}
        onDrop={noop}
        onConnectServer={() => { clicked += 1; }}
      />,
    );
    fireEvent.click(screen.getByTitle('Connect server'));
    expect(clicked).toBe(1);
  });

  it('the header "+" is ALWAYS visible (connect server is not a capability — spec 5.3/D4)', () => {
    renderTree(
      <CameraTree
        groups={[]}
        cameras={[]}
        selected={null}
        onSelect={noop}
        onAction={noop}
        onDrop={noop}
      />,
    );
    expect(screen.getByTitle('Connect server')).toBeInTheDocument();
  });

  // spec 2026-10-16: the dot is full only with recording ON; without it, only the outline
  it('full dot with recording on and empty without it', () => {
    const base = { groups: [], selected: null, onSelect: noop, onAction: noop, onDrop: noop };
    const { container, unmount } = renderTree(<CameraTree {...base} cameras={[{ id: 'c1', name: 'Portaria', state: 'online', recording: true }]} />);
    expect(container.querySelector('.badge')?.className).toContain('cheia');
    unmount();
    const { container: c2 } = renderTree(<CameraTree {...base} cameras={[{ id: 'c1', name: 'Portaria', state: 'online' }]} />);
    expect(c2.querySelector('.badge')?.className).not.toContain('cheia');
  });

  // spec 2026-10-17 (section 4.3): the filter prunes the tree — the FOLDER only enters as an ancestor
  // of a camera that matched (the folder name does not match on its own).
  const twoFolders = {
    groups: [
      { id: 'g1', name: 'Gates' },
      { id: 'g2', name: 'Backyard' },
    ],
    cameras: [
      { id: 'c1', name: 'Gate 1', state: 'online', group_id: 'g1' },
      { id: 'c2', name: 'Yard', state: 'online', group_id: 'g2' },
    ],
    selected: null,
    onSelect: noop,
    onAction: noop,
    onDrop: noop,
  };

  // the search became the sidebar header (spec 2026-10-17-busca-cabecalho-sidebar): the wrapper
  // composes SearchField + CameraTree with shared state, like the App
  function WithFilter(props: Parameters<typeof CameraTree>[0]) {
    const [f, setF] = useState('');
    return (
      <LanguageProvider>
        <SearchField value={f} onChange={setF} label="Search cameras and layouts" />
        <CameraTree {...props} filter={f} />
      </LanguageProvider>
    );
  }

  it('the filter hides the camera that does not match and the folder left without a match', () => {
    renderTree(<CameraTree {...twoFolders} filter="Gate" />);
    expect(screen.getByText('Gate 1')).toBeInTheDocument();
    expect(screen.getByText('Gates')).toBeInTheDocument(); // ancestor of the camera that matched
    expect(screen.queryByText('Yard')).toBeNull();
    expect(screen.queryByText('Backyard')).toBeNull(); // folder without a match leaves the tree
  });

  it('the ancestor folder appears OPEN even when it is in the closed list', () => {
    render(<WithFilter {...twoFolders} />);
    // closes the folder by clicking the handle (without a filter, everything is visible)
    fireEvent.click(screen.getByLabelText('Collapse Gates'));
    expect(screen.getByLabelText('Expand Gates')).toHaveAttribute('aria-expanded', 'false');
    // types the filter: the match lives INSIDE the closed folder
    fireEvent.change(screen.getByLabelText('Search cameras and layouts'), { target: { value: 'Gate' } });
    expect(screen.getByLabelText('Collapse Gates')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Gate 1')).toBeInTheDocument(); // the children <ul> is in the document
  });

  it('under a filter the folder handle is inactive and so is the all-folders button (spec alca-inativa 3.1-3.2)', () => {
    renderTree(<CameraTree {...twoFolders} filter="Gate" onToggleFolders={noop} />);
    const handle = screen.getByLabelText('Collapse Gates');
    expect(handle).toHaveAttribute('aria-disabled', 'true');
    expect(handle).toHaveClass('inativa');
    expect(handle).toHaveAttribute('aria-expanded', 'true');   // 3.4: reports the visible state
    expect(screen.getByTitle('Expand or collapse all folders')).toBeDisabled();
  });

  it('a click on the handle under a filter writes nothing: with the filter cleared the folder stays open (inversion of rule 3.2)', () => {
    render(<WithFilter {...twoFolders} />);
    fireEvent.change(screen.getByLabelText('Search cameras and layouts'), { target: { value: 'Gate' } });
    fireEvent.click(screen.getByLabelText('Collapse Gates'));
    fireEvent.change(screen.getByLabelText('Search cameras and layouts'), { target: { value: '' } });
    expect(screen.getByLabelText('Collapse Gates')).toHaveAttribute('aria-expanded', 'true');
  });

  it('under a filter the DVR handle is inactive too', () => {
    renderTree(<CameraTree {...withDevice} filter="Channel" />);
    const handle = screen.getByLabelText('Collapse DVR');
    expect(handle).toHaveAttribute('aria-disabled', 'true');
    expect(handle).toHaveClass('inativa');
  });

  it('without a filter the handle stays active and the click closes (non-regression 3.5)', () => {
    renderTree(<CameraTree {...twoFolders} filter="" />);
    const handle = screen.getByLabelText('Collapse Gates');
    expect(handle).not.toHaveAttribute('aria-disabled');
    expect(handle).not.toHaveClass('inativa');
    fireEvent.click(handle);
    expect(screen.getByLabelText('Expand Gates')).toBeInTheDocument();
  });

  it('without a filter the tree comes out as it always did', () => {
    renderTree(<CameraTree {...twoFolders} filter="" />);
    for (const name of ['Gates', 'Backyard', 'Gate 1', 'Yard']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  // spec 2026-10-17 (decision 5 + amendment E8): the device is a CONTAINER node — recorder icon,
  // children indented by .tree-filhos and no selection (the link is device_id, not group_id).
  const withDevice = {
    groups: [{ id: 'g1', name: 'Gates' }],
    cameras: [
      { id: 'c1', name: 'Channel 1', state: 'online', device_id: 'd1' },
      { id: 'c2', name: 'Channel 2', state: 'online', device_id: 'd1' },
      { id: 'c3', name: 'Gate 1', state: 'online', group_id: 'g1' },
    ],
    devices: [{ id: 'd1', name: 'DVR' }],
    selected: null,
    onSelect: noop,
    onAction: noop,
    onDrop: noop,
  };

  // jsdom does not implement DragEvent: the dataTransfer goes in the event init (same pattern as
  // StageGrid.test.tsx). One data object per drag, to read what the node published.
  const fakeDt = (data: Record<string, string> = {}) => ({
    setData: (t: string, v: string) => { data[t] = v; },
    getData: (t: string) => data[t] ?? '',
    effectAllowed: '',
  });

  it('the device node draws the recorder icon and the indented children', () => {
    const { container } = renderTree(<CameraTree {...withDevice} filter="" />);
    expect(screen.getByText('DVR')).toBeInTheDocument();
    expect(container.querySelector('.nx-device')).not.toBeNull(); // the spec's contract class
    const dvr = screen.getByText('DVR').closest('li.tree-device');
    expect(dvr).not.toBeNull();
    for (const name of ['Channel 1', 'Channel 2']) {
      const child = screen.getByText(name);
      expect(child).toBeInTheDocument();
      expect(child.closest('li.tree-device')).toBe(dvr);       // each child lives inside the device
      expect(child.closest('ul.tree-filhos')).not.toBeNull();  // ... in the <ul> that indents children
    }
  });

  it('without devices the tree comes out as it always did', () => {
    const { container } = renderTree(
      <CameraTree
        {...twoFolders}
        cameras={[{ id: 'c1', name: 'Gate 1', state: 'online', group_id: 'g1', device_id: 'dx' }]}
        filter=""
      />,
    );
    // a device_id that is not in the list creates no node: the child goes back to its usual folder
    expect(container.querySelector('.tree-device')).toBeNull();
    expect(screen.getByText('Gates')).toBeInTheDocument();
    expect(screen.getByText('Gate 1')).toBeInTheDocument();
  });

  it('the filter hides the device without a visible child and it comes back with the filter cleared', () => {
    const { rerender } = renderTree(<CameraTree {...withDevice} filter="Gate" />);
    expect(screen.getByText('Gate 1')).toBeInTheDocument(); // matched, and it is in the folder (not the device)
    expect(screen.queryByText('DVR')).toBeNull();             // without a visible child, the device leaves
    rerender(withProvider(<CameraTree {...withDevice} filter="" />));
    expect(screen.getByText('DVR')).toBeInTheDocument();      // filter cleared: the device is back
  });

  // spec 2026-10-17 (Responsividade operacional): the name truncates by the column width and the title
  // gives the whole name back — without that a cut name has no way of being read.
  it('the truncated camera name carries the full name in the title', () => {
    renderTree(
      <CameraTree
        groups={[]}
        cameras={[{ id: 'c1', name: 'Main gate of block B', state: 'online' }]}
        selected={null}
        onSelect={noop}
        onAction={noop}
        onDrop={noop}
      />,
    );
    expect(screen.getByText('Main gate of block B')).toHaveAttribute('title', 'Main gate of block B');
  });

  // ---- spec 2026-10-17: item 1.3a-c (the DVR as a folder); the search left for the header ----

  it('double click on the DVR opens the DEVICE on the wall (item 1.3a)', () => {
    const opened: { kind: string; id: string }[] = [];
    renderTree(<CameraTree {...withDevice} onOpen={(n) => opened.push(n)} filter="" />);
    fireEvent.doubleClick(screen.getByText('DVR'));
    expect(opened).toEqual([{ kind: 'device', id: 'd1' }]);
  });

  it('the DVR drag publishes BOTH payloads: the children as camera and the device (1.3b)', () => {
    const { container } = renderTree(<CameraTree {...withDevice} filter="" />);
    const data: Record<string, string> = {};
    fireEvent.dragStart(container.querySelector('li.tree-device') as HTMLElement, { dataTransfer: fakeDt(data) });
    // the stage reads this one first (StageGrid:81) and releases the channels as cameras: the video wall does not change
    expect(data['application/x-ovms-camera']).toBe('c1,c2');
    // ... and this is the one the FOLDER reads before the camera one, to move the recorder
    expect(data['application/x-ovms-device']).toBe('d1');
  });

  it('dropping the device payload on a folder raises ONE node (the DVR), not the children (1.3b/d)', () => {
    const drops: unknown[] = [];
    renderTree(<CameraTree {...withDevice} onDrop={(d) => drops.push(d)} filter="" />);
    const folder = screen.getByText('Gates').closest('.tree-cabeca') as HTMLElement;
    // the SAME drop carries both types: the device payload is the one that decides
    fireEvent.drop(folder, { dataTransfer: fakeDt({ 'application/x-ovms-camera': 'c1,c2', 'application/x-ovms-device': 'd1' }) });
    expect(drops).toEqual([{ cameraIds: ['c1', 'c2'], groupIds: [], target: 'g1', device_id: 'd1' }]);
  });

  // spec 2026-10-18 (header filters): folder = open/close everything in BOTH trees;
  // dot = recording cycle in the Cameras section (all -> with -> without -> all).
  describe('header filters (spec 2026-10-18)', () => {
    const groups = [{ id: 'g1', name: 'Gates' }];
    const cams = [
      { id: 'c1', name: 'With Recording', state: 'online', group_id: 'g1', recording: true },
      { id: 'c2', name: 'Without Recording', state: 'online', group_id: 'g1' },
    ];
    const base = { groups, cameras: cams, selected: null, onSelect: noop, onAction: noop, onDrop: noop };

    it('the header has the folder and the dot that fire the callbacks', () => {
      let folders = 0; let rec = 0;
      renderTree(<CameraTree {...base} onToggleFolders={() => { folders += 1; }} onCycleRecording={() => { rec += 1; }} />);
      fireEvent.click(screen.getByTitle('Expand or collapse all folders'));
      fireEvent.click(screen.getByTitle('Filter by recording'));
      expect([folders, rec]).toEqual([1, 1]);
    });

    it('without the callbacks both filter buttons do not appear', () => {
      renderTree(<CameraTree {...base} />);
      expect(screen.queryByTitle('Expand or collapse all folders')).toBeNull();
      expect(screen.queryByTitle('Filter by recording')).toBeNull();
    });

    it('recordingFilter "with" hides the camera without recording; "without" does the opposite; null shows all', () => {
      const { rerender } = renderTree(<CameraTree {...base} recordingFilter="with" />);
      expect(screen.getByText('With Recording')).toBeInTheDocument();
      expect(screen.queryByText('Without Recording')).toBeNull();
      rerender(withProvider(<CameraTree {...base} recordingFilter="without" />));
      expect(screen.queryByText('With Recording')).toBeNull();
      expect(screen.getByText('Without Recording')).toBeInTheDocument();
      rerender(withProvider(<CameraTree {...base} recordingFilter={null} />));
      expect(screen.getByText('With Recording')).toBeInTheDocument();
      expect(screen.getByText('Without Recording')).toBeInTheDocument();
    });

    it('dot: full on "with", empty on "without", neutral without a filter; pressed only with a filter', () => {
      // the callback must be in EVERY rerender: without it the button leaves the DOM and `btn` goes stale
      const { rerender } = renderTree(<CameraTree {...base} onCycleRecording={noop} recordingFilter="with" />);
      const btn = screen.getByTitle('Filter by recording');
      expect(btn).toHaveAttribute('aria-pressed', 'true');
      expect(btn.querySelector('.badge.online.cheia')).not.toBeNull();
      rerender(withProvider(<CameraTree {...base} onCycleRecording={noop} recordingFilter="without" />));
      expect(btn.querySelector('.badge.online.cheia')).toBeNull();
      expect(btn.querySelector('.badge.online')).not.toBeNull();
      rerender(withProvider(<CameraTree {...base} onCycleRecording={noop} recordingFilter={null} />));
      expect(btn).toHaveAttribute('aria-pressed', 'false');
      expect(btn.querySelector('.badge.online')).toBeNull();
      expect(btn.classList.contains('ativo')).toBe(false);
    });

    it('folderSignal closes all folders on the close signal and opens all on the open signal', () => {
      const { rerender } = renderTree(<CameraTree {...base} folderSignal={{ open: false, n: 0 }} />);
      expect(screen.getByText('With Recording')).toBeInTheDocument(); // open by default
      rerender(withProvider(<CameraTree {...base} folderSignal={{ open: false, n: 1 }} />));
      expect(screen.queryByText('With Recording')).toBeNull();        // folder closed
      rerender(withProvider(<CameraTree {...base} folderSignal={{ open: true, n: 2 }} />));
      expect(screen.getByText('With Recording')).toBeInTheDocument(); // reopened
    });

    // fix 2026-10-19: the button is an ACTION (toggles), not a switch — without aria-pressed, which
    // announced a state the fixed drawing never represented.
    it('the folder button announces no aria-pressed on any signal', () => {
      const { rerender } = renderTree(<CameraTree {...base} onToggleFolders={noop} />);
      const btn = screen.getByTitle('Expand or collapse all folders');
      expect(btn).not.toHaveAttribute('aria-pressed');
      rerender(withProvider(<CameraTree {...base} onToggleFolders={noop} folderSignal={{ open: true, n: 1 }} />));
      expect(screen.getByTitle('Expand or collapse all folders')).not.toHaveAttribute('aria-pressed');
    });

    // spec 2026-10-18 (item 1.1): the button keeps the active look ALWAYS; the click still toggles
    it('the folder button has the ativo class already in the initial state (no signal)', () => {
      renderTree(<CameraTree {...base} onToggleFolders={noop} />);
      expect(screen.getByTitle('Expand or collapse all folders')).toHaveClass('ativo');
    });

    // spec 2026-10-18 (item 2): the create "+" becomes a mini CTA
    it('the connect-server + carries the mini-cta class', () => {
      renderTree(<CameraTree {...base} onConnectServer={noop} />);
      expect(screen.getByTitle('Connect server')).toHaveClass('mini-cta');
    });

    // spec 2026-10-19 (folders opened under filter): guards of the camera tree — CameraTree.tsx does NOT
    // change; the three cases below must already pass in today's code.
    it('GUARD: under the "with" dot, the close signal keeps the folder with a recording camera open (case 5)', () => {
      const props = { groups, cameras: cams, selected: null, onSelect: noop, onAction: noop, onDrop: noop, recordingFilter: 'with' as const };
      const { rerender } = renderTree(<CameraTree {...props} folderSignal={{ open: false, n: 0 }} />);
      expect(screen.getByText('With Recording')).toBeInTheDocument();
      rerender(withProvider(<CameraTree {...props} folderSignal={{ open: false, n: 1 }} />));
      expect(screen.getByText('With Recording')).toBeInTheDocument();
    });

    it('GUARD: under a text filter, the close signal keeps the matching child visible (case 6)', () => {
      const props = { groups, cameras: cams, selected: null, onSelect: noop, onAction: noop, onDrop: noop, filter: 'With Rec' };
      const { rerender } = renderTree(<CameraTree {...props} folderSignal={{ open: false, n: 0 }} />);
      expect(screen.getByText('With Recording')).toBeInTheDocument();
      rerender(withProvider(<CameraTree {...props} folderSignal={{ open: false, n: 1 }} />));
      expect(screen.getByText('With Recording')).toBeInTheDocument();
    });

    it('GUARD: under the "with" dot, the close signal keeps the DVR channels visible (case 7)', () => {
      const props = { ...withDevice, cameras: withDevice.cameras.map((c) => ({ ...c, recording: true })), recordingFilter: 'with' as const };
      const { rerender } = renderTree(<CameraTree {...props} folderSignal={{ open: false, n: 0 }} />);
      expect(screen.getByText('Channel 2')).toBeInTheDocument();
      rerender(withProvider(<CameraTree {...props} folderSignal={{ open: false, n: 1 }} />));
      expect(screen.getByText('Channel 2')).toBeInTheDocument();
    });
  });

  // spec 2026-10-27 (camera-ativa 4.3): an inactive camera (ativa === false, the ONLY form) turns
  // the dot and the name gray through the `inativa` class; active or absent prop = today's look.
  describe('inactive camera gray in the tree (spec camera-ativa 4.3)', () => {
    const base = { groups: [], selected: null, onSelect: noop, onAction: noop, onDrop: noop };

    it('camera with ativa=false: the badge and the name span carry the inativa class', () => {
      const { container } = renderTree(<CameraTree {...base} cameras={[{ id: 'c1', name: 'Portaria', state: 'online', ativa: false }]} />);
      expect(container.querySelector('.badge')?.classList.contains('inativa')).toBe(true);
      expect(screen.getByText('Portaria')).toHaveClass('inativa');
    });

    it('camera with ativa=true: no new class on the badge or on the name', () => {
      const { container } = renderTree(<CameraTree {...base} cameras={[{ id: 'c1', name: 'Portaria', state: 'online', ativa: true }]} />);
      expect(container.querySelector('.badge')?.classList.contains('inativa')).toBe(false);
      expect(screen.getByText('Portaria')).not.toHaveClass('inativa');
    });

    it('camera without the prop behaves as active (default true by absence)', () => {
      const { container } = renderTree(<CameraTree {...base} cameras={[{ id: 'c1', name: 'Portaria', state: 'online' }]} />);
      expect(container.querySelector('.badge')?.classList.contains('inativa')).toBe(false);
      expect(screen.getByText('Portaria')).not.toHaveClass('inativa');
    });
  });

  it('the DVR gets the "..." and the right button opens its menu (item 1.3c)', () => {
    const actions: { type: string; kind: string; id: string }[] = [];
    const { container } = renderTree(<CameraTree {...withDevice} onAction={(a) => actions.push(a)} filter="" />);
    expect(container.querySelector('li.tree-device .cam-dots')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Options for DVR'));
    fireEvent.contextMenu(screen.getByText('DVR'));
    expect(actions.map((a) => `${a.type}:${a.kind}:${a.id}`)).toEqual(['menu-toggle:device:d1', 'menu:device:d1']);
  });

  // spec 2026-10-27: the nested <li> chain bubbled dblclick to every ancestor folder, which threw
  // ITS cameras on the wall (measured in production: BOA VISTA opened the 144 cells of SESP-RR).
  const nestedGroups = [
    { id: 'gA', name: 'Alfa', parent_id: null },
    { id: 'gB', name: 'Alfa1', parent_id: 'gA' },
    { id: 'gC', name: 'Alfa1a', parent_id: 'gB' },
    { id: 'gR', name: 'Raiz2', parent_id: null },
  ];
  const renderNested = (opened: { kind: string; id: string }[]) =>
    renderTree(<CameraTree groups={nestedGroups} cameras={[]} selected={null} onSelect={noop}
      onAction={noop} onDrop={noop} onOpen={(n) => opened.push(n)} filter="" />);

  it('double click on a subfolder opens ONLY the subfolder (spec 2026-10-27)', () => {
    const opened: { kind: string; id: string }[] = [];
    renderNested(opened);
    fireEvent.doubleClick(screen.getByText('Alfa1'));
    expect(opened).toEqual([{ kind: 'group', id: 'gB' }]);
  });

  it('three levels deep: dblclick on the innermost fires once, with its own id', () => {
    const opened: { kind: string; id: string }[] = [];
    renderNested(opened);
    fireEvent.doubleClick(screen.getByText('Alfa1a'));
    expect(opened).toEqual([{ kind: 'group', id: 'gC' }]);
  });

  it('double click on a root folder still fires once (CA-09 guard)', () => {
    const opened: { kind: string; id: string }[] = [];
    renderNested(opened);
    fireEvent.doubleClick(screen.getByText('Raiz2'));
    expect(opened).toEqual([{ kind: 'group', id: 'gR' }]);
  });
});

// plan 2026-10-30 (multi-server): o nó servidor da árvore (spec 5.3).
describe('server roots', () => {
  const noop2 = () => {};
  const servers = [
    { id: 'http://a', label: 'Primário', online: true },
    { id: 'http://b', label: 'Secundário', online: false },
  ];
  const cams = [
    { id: 'c1', name: 'Alpha', state: 'online', server_id: 'http://a' },
    { id: 'c2', name: 'Beta', state: 'online', server_id: 'http://b' },
  ];
  const props = { groups: [], cameras: cams, devices: [], selected: null, onSelect: noop2, onAction: noop2, onDrop: noop2, servers };

  it('draws one server row per server with label and status dot, cameras under their server', () => {
    const { container } = renderTree(<CameraTree {...props} />);
    const rows = container.querySelectorAll('.tree-servidor');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Primário')).toBeInTheDocument();
    expect(screen.getByText('Secundário')).toBeInTheDocument();
    expect(rows[0].querySelector('.badge')?.className).toContain('online');
    expect(rows[1].querySelector('.badge')?.className).toContain('error');
    // cada câmera dentro do UL do próprio servidor
    expect(rows[0].querySelector('.tree-filhos')?.textContent).toContain('Alpha');
    expect(rows[0].querySelector('.tree-filhos')?.textContent).not.toContain('Beta');
    expect(rows[1].querySelector('.tree-filhos')?.textContent).toContain('Beta');
  });

  it('right click and the dots button emit kind server with the base as id', () => {
    const onAction = vi.fn();
    const { container } = renderTree(<CameraTree {...props} onAction={onAction} />);
    fireEvent.contextMenu(container.querySelectorAll('.tree-servidor')[0]);
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'menu', kind: 'server', id: 'http://a', name: 'Primário' }));
    onAction.mockClear();
    fireEvent.click(container.querySelectorAll('.tree-servidor .cam-dots')[0]);
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'menu-toggle', kind: 'server', id: 'http://a' }));
  });

  it('the server row is neither draggable nor a drop target (spec 5.3)', () => {
    const { container } = renderTree(<CameraTree {...props} />);
    const row = container.querySelectorAll('.tree-servidor')[0];
    expect(row.getAttribute('draggable')).toBeNull();
  });

  it('text filter hides the server with no match; without filter an empty server stays', () => {
    const { container, unmount } = renderTree(<CameraTree {...props} filter="Alpha" />);
    expect(screen.getByText('Primário')).toBeInTheDocument();
    expect(screen.queryByText('Secundário')).toBeNull();
    unmount();
    const withEmpty = renderTree(<CameraTree {...props} servers={[...servers, { id: 'http://vazio', label: 'Vazio', online: true }]} />);
    expect(withEmpty.container.querySelectorAll('.tree-servidor')).toHaveLength(3);
    expect(screen.getByText('Vazio')).toBeInTheDocument();
  });

  it('double click toggles the server subtree (never opens the stage)', () => {
    const onOpen = vi.fn();
    const { container } = renderTree(<CameraTree {...props} onOpen={onOpen} />);
    const row = container.querySelectorAll('.tree-servidor')[0];
    fireEvent.doubleClick(row);
    expect(onOpen).not.toHaveBeenCalled();
    expect(row.querySelector('.tree-filhos')).toBeNull();
    fireEvent.doubleClick(row);
    expect(row.querySelector('.tree-filhos')).not.toBeNull();
  });
});

import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import LayoutTree from './LayoutTree';

const noop = () => {};
const wrapper = ({ children }: { children: React.ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;
const renderTree = (ui: ReactElement) => render(ui, { wrapper });

describe('LayoutTree', () => {
  it('shows the empty state without layouts', () => {
    renderTree(<LayoutTree layouts={[]} onMark={noop} onAction={noop} onOpen={noop} />);
    expect(screen.getByText('Layouts')).toBeInTheDocument();
    expect(screen.getByText('No saved layouts')).toBeInTheDocument();
  });

  it('renders the layout and the cameras of its cells by name', () => {
    renderTree(
      <LayoutTree
        layouts={[{ id: 'l1', name: 'Mural da entrada', cells: [{ content: { kind: 'live', camera_id: 'c1' } }] }]}
        cameras={[{ id: 'c1', name: 'Portaria', state: 'online', profile_ids: [] }]}
        onMark={noop}
        onAction={noop}
        onOpen={noop}
      />,
    );
    expect(screen.getByText('Mural da entrada')).toBeInTheDocument();
    expect(screen.getByText('Portaria')).toBeInTheDocument();
  });

  it('the header has the "+" that creates a new layout', () => {
    let clicked = 0;
    renderTree(
      <LayoutTree layouts={[]} onMark={noop} onAction={noop} onOpen={noop}
        onCreate={() => { clicked += 1; }} />,
    );
    fireEvent.click(screen.getByTitle('New layout'));
    expect(clicked).toBe(1);
  });

  it('without onCreate the header has no button', () => {
    renderTree(<LayoutTree layouts={[]} onMark={noop} onAction={noop} onOpen={noop} />);
    expect(screen.queryByTitle('New layout')).toBeNull();
  });

  // spec 2026-10-16: the layout dot follows the camera recording state
  it('dot filled with recording on and empty without it', () => {
    const layouts = [{ id: 'l1', name: 'Mural', cells: [{ content: { kind: 'live', camera_id: 'c1' } }] }];
    const { container, unmount } = renderTree(<LayoutTree layouts={layouts} cameras={[{ id: 'c1', name: 'Portaria', state: 'online', profile_ids: [], recording: true }]} onMark={noop} onAction={noop} onOpen={noop} />);
    expect(container.querySelector('.badge')?.className).toContain('cheia');
    unmount();
    const { container: c2 } = renderTree(<LayoutTree layouts={layouts} cameras={[{ id: 'c1', name: 'Portaria', state: 'online', profile_ids: [] }]} onMark={noop} onAction={noop} onOpen={noop} />);
    expect(c2.querySelector('.badge')?.className).not.toContain('cheia');
  });

  // spec 2026-10-17 (4.4): the filter matches the layout name OR a child camera name
  it('a layout that matches by NAME shows with all its children', () => {
    renderTree(
      <LayoutTree
        layouts={[{ id: 'l1', name: 'Mural da entrada', cells: [{ content: { kind: 'live', camera_id: 'c1' } }, { content: { kind: 'live', camera_id: 'c2' } }] }]}
        cameras={[{ id: 'c1', name: 'Portaria', state: 'online', profile_ids: [] }, { id: 'c2', name: 'Garagem', state: 'online', profile_ids: [] }]}
        filter="mural"
        onMark={noop}
        onAction={noop}
        onOpen={noop}
      />,
    );
    expect(screen.getByText('Portaria')).toBeInTheDocument();
    expect(screen.getByText('Garagem')).toBeInTheDocument();
  });

  it('a layout that matches by CHILD CAMERA shows only the matching children', () => {
    renderTree(
      <LayoutTree
        layouts={[{ id: 'l1', name: 'Mural da entrada', cells: [{ content: { kind: 'live', camera_id: 'c1' } }, { content: { kind: 'live', camera_id: 'c2' } }] }]}
        cameras={[{ id: 'c1', name: 'Portaria', state: 'online', profile_ids: [] }, { id: 'c2', name: 'Garagem', state: 'online', profile_ids: [] }]}
        filter="portaria"
        onMark={noop}
        onAction={noop}
        onOpen={noop}
      />,
    );
    expect(screen.getByText('Mural da entrada')).toBeInTheDocument();
    expect(screen.getByText('Portaria')).toBeInTheDocument();
    expect(screen.queryByText('Garagem')).toBeNull();
  });

  it('a layout with no match does not render', () => {
    renderTree(
      <LayoutTree
        layouts={[{ id: 'l1', name: 'Mural da entrada', cells: [{ content: { kind: 'live', camera_id: 'c1' } }] }]}
        cameras={[{ id: 'c1', name: 'Portaria', state: 'online', profile_ids: [] }]}
        filter="zzz"
        onMark={noop}
        onAction={noop}
        onOpen={noop}
      />,
    );
    expect(screen.queryByText('Mural da entrada')).toBeNull();
  });

  it('under the recording filter the layout handle is inactive and the click does not save (spec alca-inativa)', () => {
    const layouts = [{ id: 'l1', name: 'Mural', cells: [{ content: { kind: 'live', camera_id: 'c1' } }] }];
    const cameras = [{ id: 'c1', name: 'Portaria', state: 'online', profile_ids: [], recording: true }];
    const under = (g: 'with' | null) => (
      <LayoutTree layouts={layouts} cameras={cameras as never} onMark={noop} onAction={noop} onOpen={noop} recordingFilter={g} />
    );
    const { rerender } = renderTree(under('with'));
    const handle = screen.getByLabelText('Collapse Mural');
    expect(handle).toHaveAttribute('aria-disabled', 'true');
    expect(handle).toHaveClass('inativa');
    expect(handle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(handle);                     // must not write into `collapsed`
    rerender(under(null));                       // filter cleared: the click must have had no effect
    expect(screen.getByLabelText('Collapse Mural')).toHaveAttribute('aria-expanded', 'true');
  });

  it('without a filter the layout handle collapses on click (non-regression)', () => {
    renderTree(
      <LayoutTree layouts={[{ id: 'l1', name: 'Mural', cells: [] }]} cameras={[]}
        onMark={noop} onAction={noop} onOpen={noop} />,
    );
    const handle = screen.getByLabelText('Collapse Mural');
    expect(handle).not.toHaveAttribute('aria-disabled');
    fireEvent.click(handle);
    expect(screen.getByLabelText('Expand Mural')).toBeInTheDocument();
  });

  it('without a filter everything renders as it always did', () => {
    renderTree(
      <LayoutTree
        layouts={[{ id: 'l1', name: 'Mural da entrada', cells: [{ content: { kind: 'live', camera_id: 'c1' } }, { content: { kind: 'live', camera_id: 'c2' } }] }]}
        cameras={[{ id: 'c1', name: 'Portaria', state: 'online', profile_ids: [] }, { id: 'c2', name: 'Garagem', state: 'online', profile_ids: [] }]}
        onMark={noop}
        onAction={noop}
        onOpen={noop}
      />,
    );
    expect(screen.getByText('Mural da entrada')).toBeInTheDocument();
    expect(screen.getByText('Portaria')).toBeInTheDocument();
    expect(screen.getByText('Garagem')).toBeInTheDocument();
  });

  // spec 2026-10-18 (header filters): the folder signal applies to BOTH trees.
  it('folderSignal collapses the layout on the close signal and reopens it on the open signal', () => {
    const props = {
      layouts: [{ id: 'l1', name: 'Mural', cells: [{ content: { kind: 'live', camera_id: 'c1' } }] }],
      cameras: [{ id: 'c1', name: 'Portaria', state: 'online', profile_ids: [] }],
      onMark: noop, onAction: noop, onOpen: noop,
    };
    const { rerender } = renderTree(<LayoutTree {...props} folderSignal={{ open: false, n: 0 }} />);
    expect(screen.getByText('Portaria')).toBeInTheDocument(); // open by default
    rerender(<LayoutTree {...props} folderSignal={{ open: false, n: 1 }} />);
    expect(screen.queryByText('Portaria')).toBeNull();
    rerender(<LayoutTree {...props} folderSignal={{ open: true, n: 2 }} />);
    expect(screen.getByText('Portaria')).toBeInTheDocument();
  });

  // spec 2026-10-17 (operational responsiveness): same rule as the camera tree, on the layout child.
  it('the truncated child camera name carries the full name in title', () => {
    renderTree(
      <LayoutTree
        layouts={[{ id: 'l1', name: 'Mural', cells: [{ content: { kind: 'live', camera_id: 'c1' } }] }]}
        cameras={[{ id: 'c1', name: 'Portaria principal do bloco B', state: 'online', profile_ids: [] }]}
        onMark={noop}
        onAction={noop}
        onOpen={noop}
      />,
    );
    expect(screen.getByText('Portaria principal do bloco B')).toHaveAttribute('title', 'Portaria principal do bloco B');
  });

  // spec 2026-10-18 (item 1.2): the Cameras header dot also filters the Layouts.
  const recLayouts = [{ id: 'l1', name: 'Mural', cells: [{ content: { kind: 'live', camera_id: 'c1' } }, { content: { kind: 'live', camera_id: 'c2' } }, { content: { kind: 'live', camera_id: 'c5' } }] },
    { id: 'l2', name: 'Só sem gravação', cells: [{ content: { kind: 'live', camera_id: 'c3' } }] }];
  // deviation from the pinned block: c2 in both layouts duplicated the text and broke getByText;
  // l2 got its own child.
  // c5 (review caveat 7): passes the recording sieve but is cut by the text — which makes the
  // composition test discriminant.
  const recCameras = [
    { id: 'c1', name: 'Com Gravacao', state: 'online', profile_ids: [], recording: true },
    { id: 'c2', name: 'Sem Gravacao', state: 'online', profile_ids: [] },
    { id: 'c3', name: 'Sem Gravacao 2', state: 'online', profile_ids: [] },
    { id: 'c5', name: 'Camera Mute', state: 'online', profile_ids: [], recording: true },
  ];

  it('recordingFilter with/without lets only the matching child through and hides the layout without a match', () => {
    const { rerender } = renderTree(<LayoutTree layouts={recLayouts} cameras={recCameras} recordingFilter="with" onMark={noop} onAction={noop} onOpen={noop} />);
    expect(screen.getByText('Com Gravacao')).toBeInTheDocument();
    expect(screen.queryByText('Sem Gravacao')).toBeNull();
    expect(screen.getByText('Mural')).toBeInTheDocument();
    expect(screen.queryByText('Só sem gravação')).toBeNull();   // l2 has no recording child: it disappears
    rerender(<LayoutTree layouts={recLayouts} cameras={recCameras} recordingFilter="without" onMark={noop} onAction={noop} onOpen={noop} />);
    expect(screen.queryByText('Com Gravacao')).toBeNull();
    expect(screen.getByText('Sem Gravacao')).toBeInTheDocument();
    expect(screen.getByText('Só sem gravação')).toBeInTheDocument();
  });

  it('GUARD: recordingFilter null shows everything (off state; already passes before the change)', () => {
    renderTree(<LayoutTree layouts={recLayouts} cameras={recCameras} recordingFilter={null} onMark={noop} onAction={noop} onOpen={noop} />);
    expect(screen.getByText('Com Gravacao')).toBeInTheDocument();
    expect(screen.getByText('Sem Gravacao')).toBeInTheDocument();
    expect(screen.getByText('Sem Gravacao 2')).toBeInTheDocument();
    expect(screen.getByText('Camera Mute')).toBeInTheDocument();
    expect(screen.getByText('Mural')).toBeInTheDocument();
    expect(screen.getByText('Só sem gravação')).toBeInTheDocument();
  });

  it('text search still applies under recordingFilter (composition)', () => {
    // 'Com Grav' matches child c1 (recording) but NOT 'Camera Mute' (recording) nor the name 'Mural':
    // without the text cut Camera Mute would show — and without the recording cut layout l2 would show.
    renderTree(<LayoutTree layouts={recLayouts} cameras={recCameras} recordingFilter="with" filter="Com Grav" onMark={noop} onAction={noop} onOpen={noop} />);
    expect(screen.getByText('Mural')).toBeInTheDocument();
    expect(screen.getByText('Com Gravacao')).toBeInTheDocument();
    expect(screen.queryByText('Camera Mute')).toBeNull();     // passed recording, cut by the text
    expect(screen.queryByText('Só sem gravação')).toBeNull(); // no recording child: it disappears
    expect(screen.queryByText('Sem Gravacao 2')).toBeNull();
  });

  // spec 2026-10-19 (folders open under a filter): with an active filter the layout opens FORCED,
  // same as CameraTree — the 📁 click saves the signal but it only shows once the filter clears.
  it('close signal + with dot: the layout stays FORCED open (case 1)', () => {
    const props = { layouts: recLayouts, cameras: recCameras, recordingFilter: 'with' as const, onMark: noop, onAction: noop, onOpen: noop };
    const { rerender } = renderTree(<LayoutTree {...props} folderSignal={{ open: false, n: 0 }} />);
    expect(screen.getByText('Com Gravacao')).toBeInTheDocument();      // open by default
    rerender(<LayoutTree {...props} folderSignal={{ open: false, n: 1 }} />);
    expect(screen.getByText('Com Gravacao')).toBeInTheDocument();      // under a filter the close does not hide
    expect(document.querySelector('.layout-cabeca .tree-alca')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('close signal + text matching a child: child visible and layout open (case 2)', () => {
    const props = { layouts: recLayouts, cameras: recCameras, filter: 'Grav', onMark: noop, onAction: noop, onOpen: noop };
    const { rerender } = renderTree(<LayoutTree {...props} folderSignal={{ open: false, n: 0 }} />);
    expect(screen.getByText('Com Gravacao')).toBeInTheDocument();
    rerender(<LayoutTree {...props} folderSignal={{ open: false, n: 1 }} />);
    expect(screen.getByText('Com Gravacao')).toBeInTheDocument();
    expect(screen.queryByText('Camera Mute')).toBeNull();              // the text keeps cutting
  });

  it('close signal under a filter, then filter cleared: the child disappears — the saved signal applies (case 4)', () => {
    const { rerender } = renderTree(<LayoutTree layouts={recLayouts} cameras={recCameras} recordingFilter="with" folderSignal={{ open: false, n: 0 }} onMark={noop} onAction={noop} onOpen={noop} />);
    rerender(<LayoutTree layouts={recLayouts} cameras={recCameras} recordingFilter="with" folderSignal={{ open: false, n: 1 }} onMark={noop} onAction={noop} onOpen={noop} />);
    expect(screen.getByText('Com Gravacao')).toBeInTheDocument();      // under a filter: forced open
    rerender(<LayoutTree layouts={recLayouts} cameras={recCameras} folderSignal={{ open: false, n: 1 }} onMark={noop} onAction={noop} onOpen={noop} />);
    expect(screen.queryByText('Com Gravacao')).toBeNull();             // filter cleared: the close applies
  });
});

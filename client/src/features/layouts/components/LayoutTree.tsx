import { useEffect, useState, type MouseEvent } from 'react';
import CameraStatus, { type CameraState } from '@/shared/components/CameraStatus';
import { layoutCameras } from '@/shared/domain/stage';
import { normalize } from '@/shared/domain/groups';
import type { Camera } from '@/shared/utils/api';
import { useT } from '@/shared/i18n';

// Slice of the layout the tree reads: id/name and, from the cells, the content (layoutCameras reads
// content.kind/content.camera_id); the other cell fields belong to StageGrid.
// The layout is a TYPE PARAMETER (LayoutNode is the minimum): whoever passes the API Layout (full
// id/name/cells) gets the SAME type in onOpen — which is what saves the cast in the App.
export type LayoutNode = {
  id: string;
  name: string;
  cells?: { content?: { kind?: string; camera_id?: string | null } | null }[];
};
export type Marked = { kind: 'camera' | 'group' | 'layout'; id: string };
// The row sends id and name. (The root has no menu anymore: the header "+" creates directly.)
type MenuAction = { type: 'menu'; kind: 'layout'; id: string; name?: string; x: number; y: number };

type Props<L extends LayoutNode> = {
  layouts: L[];
  cameras?: Camera[];
  marked?: Marked[];
  filter?: string;
  onMark: (m: Marked[]) => void;
  onAction: (a: MenuAction) => void;
  onCreate?: () => void;
  onOpen: (l: L) => void;
  onOpenCamera?: (id: string) => void;
  // spec 2026-10-18 (Cameras header filters): the same signal opens/closes the folders of this
  // tree together with the camera ones. n=0 is the initial state; only a new click acts.
  folderSignal?: { open: boolean; n: number };
  // spec 2026-10-18 (item 1.2): the Cameras header dot also filters the child cameras of this
  // tree; a layout without a matching child does not render.
  recordingFilter?: 'with' | 'without' | null;
};

// "Layouts" tree of the sidebar (below the cameras), same pattern as the group tree:
// selection with Ctrl, double click opens on the stage, "..." opens the App menu.
// The dragged row carries the id in dataTransfer: dropping it on the stage opens the tab.
// Each layout is an EXPANDABLE node and its children are the CAMERAS of its cells — a single
// level, no subfolders. The list comes from layoutCameras (cell order, no repetition, only the
// ones in the catalog). The children never enter `marked`: marking there would enable "Delete N
// cameras" from the layouts section, which the request does not ask for (spec §6.2).
export default function LayoutTree<L extends LayoutNode>({ layouts, cameras = [], marked = [], filter = '', onMark, onAction, onCreate, onOpen, onOpenCamera = () => {}, folderSignal, recordingFilter = null }: Props<L>) {
  const { t } = useT();
  const [collapsed, setCollapsed] = useState<string[]>([]);
  // spec 2026-10-18: the 📁 of the Cameras header sends the signal to BOTH trees. n=0 = initial.
  const signalCount = folderSignal?.n ?? 0;
  useEffect(() => {
    if (!signalCount) return;
    setCollapsed(folderSignal?.open ? [] : layouts.map((l) => l.id));
    // eslint-disable-line react-hooks/exhaustive-deps -- only the new signal may act here
  }, [signalCount]);
  const isMarked = (id: string) => marked.some((m) => m.kind === 'layout' && m.id === id);
  const toggle = (id: string) => setCollapsed((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  const byId = new Map(cameras.map((c): [string, Camera] => [c.id, c]));

  // Matches the LAYOUT name OR the name of any child camera (spec 4.4). The two paths behave
  // differently on purpose: a layout-name match shows ALL children; a child match shows only the
  // ones that match. A layout with neither does not render.
  const query = normalize(String(filter || '').trim());
  const matches = (name: string) => !!query && normalize(name).includes(query);
  // spec 2026-10-19 (parity with CameraTree): with any active filter the node opens FORCED —
  // otherwise the filtered result would stay hidden. `collapsed` is not erased: it applies on clear.
  const forceOpen = !!query || recordingFilter !== null;

  function handleClick(e: MouseEvent, l: L) {
    if (e.ctrlKey || e.metaKey) {
      onMark(isMarked(l.id) ? marked.filter((m) => !(m.kind === 'layout' && m.id === l.id)) : [...marked, { kind: 'layout', id: l.id }]);
      return;
    }
    onMark([{ kind: 'layout', id: l.id }]);
  }

  return (
    <div className="layout-tree">
      <div className="layout-cabeca tree-cabeca">
        <span className="tree-nome">{t('layouts.title')}</span>
        {onCreate && (
          <button type="button" className="cam-dots mini-cta" title={t('layouts.new')} aria-label={t('layouts.new')} onClick={onCreate}>+</button>
        )}
      </div>
      {layouts.map((l) => {
        const isOpen = forceOpen || !collapsed.includes(l.id);
        // ponytail: layoutCameras only returns ids that are in the catalog, but the Map does not
        // know that — this guard is what saves the `as`
        const childCameras: Camera[] = [];
        for (const id of layoutCameras(l, cameras)) {
          const c = byId.get(id);
          if (c) childCameras.push(c);
        }
        const layoutMatches = matches(l.name);
        // spec 2026-10-18 (item 1.2): recording before the text — same order as the Cameras section.
        const filteredChildren = recordingFilter ? childCameras.filter((c) => !!c.recording === (recordingFilter === 'with')) : childCameras;
        // A layout with no child passing the sieve disappears from the list (same rule as the
        // folder without a match).
        if (recordingFilter && filteredChildren.length === 0) return null;
        // ponytail: with an empty filter `matches` matches nothing, so today's free pass is explicit here
        const visibleChildren = !query || layoutMatches ? filteredChildren : filteredChildren.filter((c) => matches(c.name));
        if (query && !layoutMatches && visibleChildren.length === 0) return null;   // spec 4.4.5
        return (
          <div
            key={l.id}
            className={`layout-li tree-row${isMarked(l.id) ? ' sel' : ''}`}
            draggable
            onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('application/x-ovms-layout', l.id); e.dataTransfer.effectAllowed = 'copy'; }}
          >
            {/* the row wrapper needs flex-basis 100% (class .tree-cabeca) so the children <ul>
                drops to the line below — same pattern as the folder */}
            <span
              className="layout-cabeca tree-cabeca"
              onClick={(e) => handleClick(e, l)}
              onDoubleClick={() => onOpen(l)}
            >
              <span
                className={`tree-alca${forceOpen ? ' inativa' : ''}`}
                role="button"
                tabIndex={forceOpen ? -1 : 0}
                aria-label={isOpen ? t('layouts.collapse', { name: l.name }) : t('layouts.expand', { name: l.name })}
                aria-expanded={isOpen}
                aria-disabled={forceOpen || undefined}
                onClick={(e) => { e.stopPropagation(); if (!forceOpen) toggle(l.id); }}   // spec alca-inativa 3.2
                onKeyDown={(e) => { if (!forceOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(l.id); } }}
              >
                {isOpen ? '▾' : '▸'}
              </span>
              {/* folder icon: symmetry with the folder row in the Cameras section (same elements
                  in the same order: handle, icon, name) */}
              <span className="tree-icone" aria-hidden="true">📁</span>
              <span className="layout-nome tree-nome">{l.name}</span>
              {/* stopPropagation: without it a click on "..." bubbles to the row, collapses the
                  selection to 1 and the batch menu never shows up */}
              <button className="cam-dots" aria-label={t('layouts.options', { name: l.name })} title={t('layouts.options', { name: l.name })} aria-haspopup="menu" onDoubleClick={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onAction({ type: 'menu', kind: 'layout', id: l.id, name: l.name, x: e.clientX, y: e.clientY }); }}>⋯</button>
            </span>
            {isOpen && (
              <ul className="layout-filhos">
                {visibleChildren.length === 0 && <li className="muted">{t('layouts.empty_layout')}</li>}
                {visibleChildren.map((c) => (
                  <li
                    key={c.id}
                    className="layout-filho tree-row"
                    draggable
                    // ponytail: the child has its own payload; without stopPropagation dragstart
                    // bubbles up and the outer layout would overwrite it (dragging the camera would
                    // open the tab)
                    onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('application/x-ovms-camera', c.id); e.dataTransfer.effectAllowed = 'move'; }}
                    onDoubleClick={() => onOpenCamera(c.id)}
                  >
                    <span className="tree-alca" aria-hidden="true" />
                    {/* SAME dot as the Cameras section: the color comes from the camera STATE
                        (provisioning = amber). It is NOT the green/red indicator of item 1.3,
                        which remains on hold (spec §1.3) */}
                    <CameraStatus state={c.state as CameraState} recording={c.recording} title={c.name} />
                    {/* the name truncates by the column width: title gives the full name on hover */}
                    <span className="tree-nome" title={c.name}>{c.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {layouts.length === 0 && <div className="muted" style={{ padding: '2px 10px' }}>{t('layouts.none_saved')}</div>}
    </div>
  );
}

import { useRef, type DragEvent, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react';
import { directCameras } from '@/shared/domain/groups';
import { closestFreeSlot, autoPlace, move, resize, boundingRect, newCellId } from '@/shared/domain/stage';
import type { Camera, Group } from '@/shared/utils/api';
import { useT } from '@/shared/i18n';

const CAMERA_TYPE = 'application/x-ovms-camera';
const GROUP_TYPE = 'application/x-ovms-group';

// Stage cell: the same shape the server saves in the layout (stage.mjs operates on it).
export type StageCell = {
  id: string;
  col: number;
  row: number;
  colspan: number;
  rowspan: number;
  content?: { kind: string; camera_id: string } | null;
};

type Props = {
  cameras: Camera[];
  groups?: Group[];
  cells: StageCell[];
  // kind of the `content` of cells born from a drop. Playback uses 'live' (amendment E1 of the
  // 2026-10-18 plan: the shape saved in the layout is unique, no consumer reads another value).
  kind: string;
  onChange: (cells: StageCell[]) => void;
  // spec 2026-10-27: reports the camera drop itself (the newIds added), so the page can tell a user
  // drop from a layout opening. Optional — Live does not use it.
  onCamerasDropped?: (cameraIds: string[]) => void;
  // spec 2026-10-18: the selection belongs to the page (the stage only paints and reports the click).
  // `maximized` only applies to the cell with the id — that is why the stage requires
  // `selected === cell.id` to write the class.
  selected?: string | null;
  maximized?: boolean;
  onSelect?: (cellId: string) => void;
  onClearSelection?: () => void;
  // The stage is generic: the page draws the cell body (StreamCell in live, CelulaPlayback in
  // archive). Rendered ALWAYS — even without a camera: whoever has no camera decides the notice
  // inside (amendment E4).
  renderCell: (cell: StageCell, marked: boolean, maximized: boolean) => ReactNode;
};

// Layout stage (unlimited plan, NX UX): a camera falls into the closestFreeSlot of the drop point;
// the rest of the batch cascades (autoPlace over the accumulation); dragging a cell moves it; the
// corner handle resizes; removing recompacts (centralizeItems). The visual grid is the bounding
// rect scaled to the stage.
export default function StagePalco({ cameras, cells, kind, onChange, onCamerasDropped, selected = null, maximized = false, onSelect = () => {}, onClearSelection = () => {}, renderCell }: Props) {
  const { t } = useT();
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const bb = boundingRect(cells);
  // TWO geometries on purpose (spec 2026-10-17, section 7): the VISUAL one (minimum 1 track — a
  // single camera fills the whole stage) and the DROP TARGET (minimum 2, so the operator can still
  // point at the quadrant where the new camera enters).
  const cols = Math.max(bb ? bb.col + bb.w : 1, 1);
  const rows = Math.max(bb ? bb.row + bb.h : 1, 1);
  const targetCols = Math.max(cols, 2);
  const targetRows = Math.max(rows, 2);
  const byId = new Map(cameras.map((c) => [c.id, c]));

  function cellUnder(e: DragEvent<HTMLDivElement>, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    return {
      col: Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * targetCols)),
      row: Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * targetRows)),
    };
  }

  function drop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const target = cellUnder(e, e.currentTarget);
    const moving = e.dataTransfer.getData('application/x-ovms-cell');
    if (moving) {
      const next = move(cellsRef.current, moving, target);
      if (next) onChange(next);
      return;
    }
    // spec 2026-10-27: the tree payload carries EVERY marked folder as CSV; each one resolves to
    // its level-direct cameras. The `new Set` dedup below covers folder+subfolder marked together.
    const cameraIds = (e.dataTransfer.getData(CAMERA_TYPE) || '').split(',').filter(Boolean);
    for (const gid of (e.dataTransfer.getData(GROUP_TYPE) || '').split(',').filter(Boolean)) {
      cameraIds.push(...directCameras(cameras, gid));
    }
    if (!cameraIds.length) return;
    const cs = cellsRef.current;
    const seen = new Set(cs.flatMap((c) => (c.content ? [c.content.camera_id] : [])));
    const newIds = [...new Set(cameraIds)].filter((id) => byId.has(id) && !seen.has(id));
    if (!newIds.length) return;
    const positions = placeCells(cs, target, newIds.length);
    const extras = newIds.map((camera_id, i) => ({
      id: newCellId(), col: positions[i].col, row: positions[i].row, colspan: 1, rowspan: 1,
      content: { kind, camera_id },
    }));
    // spec 2026-10-27: report the drop itself (not the cell diff) so the page can tell a user drop
    // from a layout opening. Lives BEFORE onChange so a consumer sees ids even if onChange opts out.
    onCamerasDropped?.(newIds);
    onChange([...cs, ...extras]);
  }

  function startResize(e: ReactMouseEvent<HTMLDivElement>, cell: StageCell) {
    e.preventDefault();
    e.stopPropagation();
    // ponytail: the .cell-resize handle always lives inside a .stage-cell
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    const cw = box.width / cell.colspan, ch = box.height / cell.rowspan;
    const { clientX: x0, clientY: y0 } = e;
    const mv = (ev: MouseEvent) => {
      const next = resize(cellsRef.current, cell.id,
        Math.max(1, cell.colspan + Math.round((ev.clientX - x0) / cw)),
        Math.max(1, cell.rowspan + Math.round((ev.clientY - y0) / ch)));
      if (next) onChange(next);
    };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  }

  return (
    <div
      className="stage-grid"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={drop}
      // spec 2026-10-18 (4.2): the empty area (gutters, padding and the "drag a camera" notice of a
      // stage without cells) is the exit from the marking. The exception is the target being INSIDE a
      // cell: the click on the body bubbles up here and cannot clear what was just marked. The handle,
      // the action bar and the menu stay at peace because they live inside `.stage-cell`. The old
      // `e.target === e.currentTarget` did not see `.stage-vazio`, which is the REAL target of a click
      // on the stage without cells (defect measured in Chrome).
      onClick={(e) => { if (!(e.target as HTMLElement).closest('.stage-cell')) onClearSelection(); }}
    >
      {cells.length === 0 && <div className="slot-empty stage-vazio">{t('shared.drag_camera')}</div>}
      {cells.map((cell) => {
        const marked = selected === cell.id;
        return (
          <div
            key={cell.id}
            className={`stage-cell${marked ? ' selecionada' : ''}${marked && maximized ? ' ampliada' : ''}`}
            // spec 2026-10-18-celula-maximizada-60 (3.1): the maximized cell fills the WHOLE stage.
            // Without this switch the CSS `inset` resolves against the cell SLOT and not the stage.
            style={marked && maximized
              ? { gridColumn: '1 / -1', gridRow: '1 / -1' }
              : { gridColumn: `${cell.col + 1} / span ${cell.colspan}`, gridRow: `${cell.row + 1} / span ${cell.rowspan}` }}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/x-ovms-cell', cell.id)}
            // spec 2026-10-18 (4.2): the click on the body toggles. The handle, the action bar and the
            // context menu stay out: the handle and `mousedown` stopPropagation, and the following
            // `click` bubbles anyway — without this exception, dragging the handle or arming PTZ would
            // shrink the maximized cell. The menu is included because it renders INSIDE the cell (root
            // `.cam-menu`, no portal) and does not stopPropagation: without this, picking "Remove from
            // layout" would mark and maximize the cell — and the spec forbids a button action that
            // changes state (amendment E8 of the plan).
            onClick={(e) => {
              const el = e.target as HTMLElement;
              if (el.closest('.cell-resize, .cell-actions, .cam-menu')) return;
              onSelect(cell.id);
            }}
          >
            {renderCell(cell, marked, marked && maximized)}
            <div className="cell-resize" onMouseDown={(e) => startResize(e, cell)} title="Resize" />
          </div>
        );
      })}
    </div>
  );
}

// first one at the closestFreeSlot of the point; the rest at autoPlace (centroid) of the accumulation
function placeCells(base: StageCell[], target: { col: number; row: number }, n: number) {
  const out: { col: number; row: number }[] = [];
  const state = base.map((c) => ({ id: c.id, col: c.col, row: c.row, colspan: c.colspan, rowspan: c.rowspan }));
  for (let i = 0; i < n; i += 1) {
    const p = i === 0
      ? closestFreeSlot(state, target, { colspan: 1, rowspan: 1 })
      : autoPlace(state, { colspan: 1, rowspan: 1 });
    state.push({ id: `n${i}`, col: p.col, row: p.row, colspan: 1, rowspan: 1 });
    out.push(p);
  }
  return out;
}

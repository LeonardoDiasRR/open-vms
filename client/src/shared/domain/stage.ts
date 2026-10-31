// Layout stage placement (port of the NX QnWorkbenchLayout, seen through symbols:
// QnMatrixMap::isOccupied, closestFreeSlot + QnDistanceMagnitudeCalculator,
// QnWorkbenchGridWalker.expand, centralizeItems). Unlimited plane, cells with
// col,row >= 0; bigger rectangles are colspan/rowspan.

// Stage plane and cell: the same shape the server stores in the layout and that StageGrid/
// LiveView already pass. The geometry reads only id/col/row/spans; `content` matters to
// layoutCameras and addCameras.
export type Position = { col: number; row: number };
export type Size = { colspan: number; rowspan: number };
export type Rect = Position & Size;
export type Cell = Rect & { id: string; content?: { kind: string; camera_id: string } | null };
// Box occupied by the whole set (boundingRect): corner + width/height, not spans.
export type Box = { col: number; row: number; w: number; h: number };

export function canPlace(cells: Cell[], rect: Rect, ignoreId: string | null = null): boolean {
  if (rect.col < 0 || rect.row < 0) return false;
  return !cells.some((c) => c.id !== ignoreId &&
    rect.col < c.col + c.colspan && c.col < rect.col + rect.colspan &&
    rect.row < c.row + c.rowspan && c.row < rect.row + rect.rowspan);
}

export function boundingRect(cells: Cell[]): Box | null {
  if (!cells.length) return null;
  const minCol = Math.min(...cells.map((c) => c.col));
  const minRow = Math.min(...cells.map((c) => c.row));
  const w = Math.max(...cells.map((c) => c.col + c.colspan)) - minCol;
  const h = Math.max(...cells.map((c) => c.row + c.rowspan)) - minRow;
  return { col: minCol, row: minRow, w, h };
}

// Guaranteed-empty rect scan: the border (col = maxC + sum) and the line (row = maxR + sum)
// never hold a cell, so a candidate always exists.
// Euclidean distance from the CENTER of the candidate rect to the CENTER of the target cell.
// Distance tie: the SMALLER COLUMN wins (explicit rule below) — that is what produces the
// vertical 1x2 stack of the NX screenshot with 2 cameras. Row-major scan.
// ponytail: O(W*H) with W,H ~ #cells*2 — the stage holds dozens of cells, not millions.
export function closestFreeSlot(cells: Cell[], target: Position, size: Size = { colspan: 1, rowspan: 1 }): Position {
  if (!cells.length) return { col: 0, row: 0 };
  const maxC = Math.max(...cells.map((c) => c.col + c.colspan));
  const maxR = Math.max(...cells.map((c) => c.row + c.rowspan));
  const spanSum = cells.reduce((s, c) => s + c.colspan + c.rowspan, 0);
  let best: Position | null = null, bestDistance = Infinity;
  for (let row = 0; row <= maxR + spanSum; row += 1) {
    for (let col = 0; col <= maxC + spanSum; col += 1) {
      if (!canPlace(cells, { col, row, colspan: size.colspan, rowspan: size.rowspan })) continue;
      const dx = col + size.colspan / 2 - (target.col + 0.5);
      const dy = row + size.rowspan / 2 - (target.row + 0.5);
      const d = dx * dx + dy * dy;
      // strict '<' + lower-COLUMN tiebreak: (0,1) beats (1,0) => vertical stack.
      // Do not change it to '>=' and do not remove the column tiebreak.
      if (d < bestDistance || (d === bestDistance && best && col < best.col)) { bestDistance = d; best = { col, row }; }
    }
  }
  return best || { col: maxC, row: 0 };
}

// Next cell for an addition without drop coordinates: the closest free slot to the CENTROID of
// the existing cells (NX's "next free"). The centroid is what makes the 1->4 sequence close the
// 2x2 instead of walking down the column forever.
export function autoPlace(cells: Cell[], size: Size = { colspan: 1, rowspan: 1 }): Position {
  if (!cells.length) return { col: 0, row: 0 };
  const cx = cells.reduce((s, c) => s + c.col + c.colspan / 2, 0) / cells.length - 0.5;
  const cy = cells.reduce((s, c) => s + c.row + c.rowspan / 2, 0) / cells.length - 0.5;
  return closestFreeSlot(cells, { col: cx, row: cy }, size);
}

// Batch addition (folder/multi drop without a point): each 1x1 camera enters the autoPlace
// (centroid) of the accumulated state. Verified: 1->4 produces (0,0),(0,1),(1,0),(1,1).
export function sequenceAutoPlace(cameraIds: string[]): Position[] {
  const state: Cell[] = [];
  const out: Position[] = [];
  for (const _id of cameraIds) {
    const p = autoPlace(state, { colspan: 1, rowspan: 1 });
    state.push({ id: `t${out.length}`, col: p.col, row: p.row, colspan: 1, rowspan: 1 });
    out.push(p);
  }
  return out;
}

// move/resize return the NEW list or null (collision/no-op) — they never throw.
export function move(cells: Cell[], id: string, target: Position): Cell[] | null {
  const cell = cells.find((c) => c.id === id);
  if (!cell) return null;
  const rect = { col: target.col, row: target.row, colspan: cell.colspan, rowspan: cell.rowspan };
  if (cell.col === rect.col && cell.row === rect.row) return null;
  if (!canPlace(cells, rect, id)) return null;
  return cells.map((c) => (c.id === id ? { ...c, col: rect.col, row: rect.row } : c));
}

export function resize(cells: Cell[], id: string, colspan: number, rowspan: number): Cell[] | null {
  const cell = cells.find((c) => c.id === id);
  if (!cell || colspan < 1 || rowspan < 1) return null;
  if (cell.colspan === colspan && cell.rowspan === rowspan) return null;
  const rect = { col: cell.col, row: cell.row, colspan, rowspan };
  if (!canPlace(cells, rect, id)) return null;
  return cells.map((c) => (c.id === id ? { ...c, colspan, rowspan } : c));
}

export function center(cells: Cell[]): Cell[] {
  if (!cells.length) return [];
  // ponytail: non-empty list (guard above) => boundingRect exists; only the type does not know
  const bb = boundingRect(cells)!;
  return cells.map((c) => ({ ...c, col: c.col - bb.col, row: c.row - bb.row }));
}

// NX: removing recompacts the layout (centralizeItems).
export function remove(cells: Cell[], id: string): Cell[] {
  return center(cells.filter((c) => c.id !== id));
}

// New cell id, with a module counter: the SAME generator serves the drop (StageGrid) and the
// open by double click (LiveView) — two independent counters could repeat the id within the same
// millisecond and React keys the cell by id.
let cellSeq = 0;
export function newCellId(): string {
  cellSeq += 1;
  return `c${Date.now().toString(36)}-${cellSeq.toString(36)}`;
}

// Cameras of a layout, in CELL order, without repetition and only those in the catalog.
// It is the child list of the layout node in the sidebar: one level, camera, never a folder.
// ponytail: the layout comes from the API (id/name left over) — the parameter asks only for what is read.
export function layoutCameras(
  layout: { cells?: { content?: { kind?: string; camera_id?: string | null } | null }[] } | null,
  cameras: { id: string }[] | null,
): string[] {
  const known = new Set((cameras || []).map((c) => c.id));
  const out: string[] = [];
  for (const c of (layout && layout.cells) || []) {
    const content = c && c.content;
    if (!content || content.kind !== 'live' || !content.camera_id) continue;
    if (!known.has(content.camera_id) || out.includes(content.camera_id)) continue;
    out.push(content.camera_id);
  }
  return out;
}

// Adds ONE 1x1 cell per camera not yet shown, in the requested order, each at the autoPlace
// (centroid) of the accumulated state — the same rule as the batch without a drop point.
// With nothing new it returns the SAME list: identity preserved so the tab is not marked dirty.
export function addCameras(cells: Cell[] | null | undefined, cameraIds: string[] | null | undefined, newId: () => string): Cell[] {
  const current = cells || [];
  const seen = new Set(current.flatMap((c) => (c.content && c.content.camera_id ? [c.content.camera_id] : [])));
  const incoming = [...new Set(cameraIds || [])].filter((id) => !seen.has(id));
  if (!incoming.length) return current;
  const state: Cell[] = current.map((c) => ({ id: c.id, col: c.col, row: c.row, colspan: c.colspan, rowspan: c.rowspan }));
  const out: Cell[] = [...current];
  for (const camera_id of incoming) {
    const pos = autoPlace(state, { colspan: 1, rowspan: 1 });
    const id = newId();
    state.push({ id, col: pos.col, row: pos.row, colspan: 1, rowspan: 1 });
    out.push({ id, col: pos.col, row: pos.row, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id } });
  }
  return out;
}

// Cell display state during loading (2026-10-15 spinner plan):
// 'idle'    = there is no profile to play (nothing to load: the cell shows no spinner)
// 'loading' = there is a profile, still no frame and no failure: the transient interval
// 'playing' = the video started delivering frames
// 'failed'  = the current attempt failed (the "No signal" warning takes over)
// Precedence: no profile > failure > playing > loading.
export type CellState = 'idle' | 'loading' | 'playing' | 'failed';
export function cellState({ hasProfile = false, failed = false, playing = false }: { hasProfile?: boolean; failed?: boolean; playing?: boolean } = {}): CellState {
  if (!hasProfile) return 'idle';
  if (failed) return 'failed';
  if (playing) return 'playing';
  return 'loading';
}

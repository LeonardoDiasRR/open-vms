// Port of test/stage.test.mjs: the SAME cases and assertions — only the runner became vitest
// (the assert is still `assert.equal`/`deepEqual`).
import { assert, test } from 'vitest';
import { canPlace, closestFreeSlot, autoPlace, sequenceAutoPlace, move, resize, remove, center, boundingRect, layoutCameras, addCameras, newCellId, cellState } from './stage';

const cell = (id: string, col: number, row: number, colspan = 1, rowspan = 1) => ({ id, col, row, colspan, rowspan, content: { kind: 'live', camera_id: id } });

test('canPlace: collision by rect intersection; negative coordinate is outside the plane', () => {
  const cells = [cell('a', 0, 0, 2, 2)];
  assert.equal(canPlace(cells, { col: 2, row: 0, colspan: 1, rowspan: 1 }), true);
  assert.equal(canPlace(cells, { col: 1, row: 1, colspan: 1, rowspan: 1 }), false);
  assert.equal(canPlace(cells, { col: -1, row: 0, colspan: 1, rowspan: 1 }), false);
  // ignoreId: the cell itself never collides with itself
  assert.equal(canPlace(cells, { col: 0, row: 0, colspan: 2, rowspan: 2 }, 'a'), true);
  // regression: rect TALLER than the existing cell — the row comparison must use
  // rect.rowspan; with c.rowspan the collision goes unnoticed and the cells overlap on screen
  assert.equal(canPlace([cell('b', 0, 1)], { col: 0, row: 0, colspan: 1, rowspan: 2 }), false);
  assert.equal(canPlace([cell('b', 1, 0)], { col: 0, row: 0, colspan: 2, rowspan: 1 }), false);
  assert.equal(canPlace([cell('b', 0, 2)], { col: 0, row: 0, colspan: 1, rowspan: 2 }), true);
});

test('closestFreeSlot: empty goes to the origin; an occupied point falls to the closest free slot', () => {
  assert.deepEqual(closestFreeSlot([], { col: 5, row: 5 }, { colspan: 1, rowspan: 1 }), { col: 0, row: 0 });
  const cells = [cell('a', 0, 0)];
  // d((1,0)->target) = d((0,1)->target) = 1: tie resolved by the smaller-COLUMN tiebreak
  // => (0,1). Vertical stack = the 1x2 of the NX screenshots.
  assert.deepEqual(closestFreeSlot(cells, { col: 0, row: 0 }, { colspan: 1, rowspan: 1 }), { col: 0, row: 1 });
  // 2x2 item: (0,1) and (1,0) tie in distance; same smaller-column rule => (0,1)
  assert.deepEqual(closestFreeSlot(cells, { col: 0, row: 0 }, { colspan: 2, rowspan: 2 }), { col: 0, row: 1 });
});

test('autoPlace: origin when empty; vertical stack with one cell (NX 1x2 rule)', () => {
  assert.deepEqual(autoPlace([], { colspan: 1, rowspan: 1 }), { col: 0, row: 0 });
  assert.deepEqual(autoPlace([cell('a', 0, 0)], { colspan: 1, rowspan: 1 }), { col: 0, row: 1 });
});

test('sequenceAutoPlace: 4 cells close a full 2x2; 2 form the vertical stack', () => {
  const pos = sequenceAutoPlace(['c1', 'c2', 'c3', 'c4']).map((x) => `${x.col},${x.row}`).sort();
  assert.deepEqual(pos, ['0,0', '0,1', '1,0', '1,1']);
  const two = sequenceAutoPlace(['a', 'b']).map((x) => `${x.col},${x.row}`).sort();
  assert.deepEqual(two, ['0,0', '0,1']);
});

test('move: to a free slot ok; collides with a neighbor => null; same position => null', () => {
  const cells = [cell('a', 0, 0), cell('b', 2, 0)];
  assert.deepEqual(move(cells, 'a', { col: 1, row: 0 }), [cell('a', 1, 0), cell('b', 2, 0)]);
  assert.equal(move(cells, 'a', { col: 2, row: 0 }), null);
  assert.equal(move(cells, 'a', { col: 0, row: 0 }), null);
  assert.deepEqual(move(cells, 'a', { col: 0, row: 3 }), [cell('a', 0, 3), cell('b', 2, 0)]);
});

test('resize: grows into free space, refuses a collision and refuses <1', () => {
  const cells = [cell('a', 0, 0), cell('b', 1, 0)];
  // '!' because the return is Cell[] | null: the non-empty list is the assertion itself
  assert.equal(resize(cells, 'a', 1, 2)![0].rowspan, 2);
  assert.equal(resize(cells, 'a', 2, 1), null);
  assert.equal(resize(cells, 'a', 0, 1), null);
});

test('remove centers; boundingRect gives the occupied rect; no cells returns null', () => {
  const cells = [cell('a', 5, 5), cell('b', 6, 5)];
  assert.deepEqual(boundingRect(cells), { col: 5, row: 5, w: 2, h: 1 });
  assert.deepEqual(boundingRect([]), null);
  const pos = remove(cells, 'b');
  assert.deepEqual(pos.map((c) => ({ id: c.id, col: c.col, row: c.row })), [{ id: 'a', col: 0, row: 0 }]);
  assert.deepEqual(center(cells).map((c) => `${c.col},${c.row}`), ['0,0', '1,0']);
});

test('layoutCameras: cell order, without repetition and only those in the catalog', () => {
  const cams = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  // cell() sets content.camera_id = id: 'x' is orphan (not in the catalog) and 'b' occupies two cells
  const l = { id: 'l1', name: 'Aeroporto', cells: [cell('x', 0, 0), cell('b', 1, 0), cell('a', 2, 0), cell('b', 0, 1)] };
  assert.deepEqual(layoutCameras(l, cams), ['b', 'a']);
  assert.deepEqual(layoutCameras({ cells: [] }, cams), []);
  assert.deepEqual(layoutCameras(null, cams), []);
  assert.deepEqual(layoutCameras(l, []), []);
});

test('layoutCameras: a cell that is not live does not become a tree child', () => {
  const cams = [{ id: 'a' }];
  const l = { cells: [
    { id: 'z', col: 0, row: 0, colspan: 1, rowspan: 1, content: { kind: 'webpage' } },
    { id: 'y', col: 1, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: 'a' } },
  ] };
  assert.deepEqual(layoutCameras(l, cams), ['a']);
});

test('addCameras: enters the autoPlace of the accumulated state and skips a camera already in the tab', () => {
  let n = 0;
  const newId = () => `novo${++n}`;
  const with3 = [cell('a', 0, 0), cell('b', 1, 0), cell('c', 2, 0)];
  const out = addCameras(with3, ['a', 'd', 'e', 'd'], newId);
  assert.equal(out.length, 5); // 3 + 'd' + 'e' ('a' was already there; 'd' repeated in the request)
  assert.deepEqual(
    out.slice(3).map((c) => [c.id, c.col, c.row, c.colspan, c.rowspan, c.content!.kind, c.content!.camera_id]),
    [['novo1', 1, 1, 1, 1, 'live', 'd'], ['novo2', 0, 1, 1, 1, 'live', 'e']],
  );
  assert.deepEqual(out.slice(0, 3), with3); // existing cells are untouched
});

test('addCameras: with nothing new it returns the SAME list (the tab is not needlessly dirty)', () => {
  const with1 = [cell('a', 0, 0)];
  assert.equal(addCameras(with1, ['a'], () => 'x'), with1);
  assert.equal(addCameras(with1, [], () => 'x'), with1);
  assert.equal(addCameras([], [], () => 'x').length, 0);
  const first = addCameras([], ['a'], () => 'novoA');
  assert.deepEqual(first.map((c) => [c.col, c.row, c.content!.camera_id]), [[0, 0, 'a']]);
});

test('addCameras: the fourth camera closes the 2x2, like the drop batch', () => {
  let n = 0;
  const cells = addCameras(addCameras(addCameras([], ['a'], () => `n${++n}`), ['b'], () => `n${++n}`), ['c'], () => `n${++n}`);
  const out = addCameras(cells, ['d'], () => `n${++n}`);
  assert.deepEqual(out.map((c) => `${c.col},${c.row}`).sort(), ['0,0', '0,1', '1,0', '1,1']);
});

test('newCellId: unique across consecutive calls', () => {
  const a = newCellId();
  const b = newCellId();
  assert.equal(typeof a, 'string');
  assert.notEqual(a, b);
});

test('cellState: no profile does not load; failure beats playing; no frame is loading', () => {
  // no profile means nothing to load — the cell cannot spin forever
  assert.equal(cellState({ hasProfile: false }), 'idle');
  assert.equal(cellState({ hasProfile: false, failed: true, playing: true }), 'idle');
  assert.equal(cellState(), 'idle');
  // the transient interval is the default case for a cell with a profile
  assert.equal(cellState({ hasProfile: true }), 'loading');
  assert.equal(cellState({ hasProfile: true, playing: true }), 'playing');
  // the failure wins: a fatal error after the first frames becomes a warning, not a spinner
  assert.equal(cellState({ hasProfile: true, failed: true }), 'failed');
  assert.equal(cellState({ hasProfile: true, failed: true, playing: true }), 'failed');
});

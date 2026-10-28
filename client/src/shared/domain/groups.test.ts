import { test } from 'vitest'; import assert from 'node:assert';
import { buildTree, descendants, directCameras, canMove, flatten, range, normalize, filterCameras, type TreeNode } from './groups';

const G = [
  { id: 'g1', name: 'Sede', parent_id: null },
  { id: 'g2', name: 'Portaria', parent_id: 'g1' },
  { id: 'g3', name: 'Fundos', parent_id: 'g1' },
  { id: 'g4', name: 'Anexo', parent_id: 'g3' },
  { id: 'orfa', name: 'Orfa', parent_id: 'sumiu' },
];
const groups = Object.fromEntries(G.map((g) => [g.id, g]));
const cams = [
  { id: 'c1', name: 'C1', group_id: 'g2' },
  { id: 'c2', name: 'C2', group_id: 'g4' },
  { id: 'c3', name: 'C3', group_id: null },
  { id: 'c4', name: 'C4' },
  { id: 'c5', name: 'C5', group_id: 'nao-existe' },
];

// ponytail: strict TS requires narrowing the TreeNode union before reading .children — the test
// case accesses the folder directly (implicit in JS). That is the only port change.
type TestNode = TreeNode<(typeof cams)[number]>;
const folder = (n: TestNode | undefined): Extract<TestNode, { kind: 'group' }> => {
  if (!n || n.kind !== 'group') throw new Error('expected a folder');
  return n;
};

test('buildTree: nested folders with the cameras inside, no level limit', () => {
  const t = buildTree(groups, cams);
  const names = t.map((n) => (n.kind === 'group' ? `[${n.name}]` : n.name));
  assert.deepEqual(names, ['[Sede]', '[Orfa]', 'C3', 'C4', 'C5']);
  const sede = folder(t[0]);
  assert.deepEqual(sede.children.map((n) => `[${n.name}]`), ['[Portaria]', '[Fundos]']);
  const fundos = folder(sede.children[1]);
  assert.deepEqual(fundos.children.map((n) => `[${n.name}]`), ['[Anexo]']);
  assert.deepEqual(folder(fundos.children[0]).children.map((n) => n.name), ['C2']);
  assert.deepEqual(folder(sede.children[0]).children.map((n) => n.name), ['C1']);
});

test('a group with a missing parent and a camera with a missing group_id fall to the root', () => {
  const t = buildTree(groups, cams);
  assert.equal(folder(t.find((n) => n.kind === 'group' && n.name === 'Orfa')).children.length, 0);
  assert.ok(t.some((n) => n.kind === 'camera' && n.name === 'C5'), 'orphan camera must appear, not vanish');
});

test('descendants is recursive', () => {
  assert.deepEqual(descendants(groups, 'g1').sort(), ['g2', 'g3', 'g4']);
});

test('canMove refuses itself and a descendant', () => {
  assert.equal(canMove(groups, 'g1', null), true);
  assert.equal(canMove(groups, 'g4', 'g1'), true);
  assert.equal(canMove(groups, 'g1', 'g1'), false);
  assert.equal(canMove(groups, 'g1', 'g4'), false);
  assert.equal(canMove(groups, 'g2', 'g4'), true);
});

test('accepts the server LIST (not only the map) — the shape the App really passes', () => {
  // regression: with `Object.keys` over an array, ids became {'0'} and the tree came out ALL flat
  const list = Object.values(groups);
  const t = buildTree(list, cams);
  const sede = folder(t.find((n) => n.kind === 'group' && n.name === 'Sede'));
  assert.ok(sede, 'the root folder must appear');
  assert.deepEqual(sede.children.map((n) => n.name), ['Portaria', 'Fundos'], 'subgroups must nest with a list as input');
  assert.deepEqual(folder(folder(sede.children[1]).children[0]).children.map((n) => n.name), ['C2'], 'and the grandchild too');
  assert.deepEqual(descendants(list, 'g1').sort(), ['g2', 'g3', 'g4']);
  assert.equal(canMove(list, 'g1', 'g4'), false);
});

test('flatten: the visible tree in order, with a closed folder hiding its children', () => {
  const t = buildTree(groups, cams);
  assert.deepEqual(flatten(t).map((x) => x.id), ['g1', 'g2', 'c1', 'g3', 'g4', 'c2', 'orfa', 'c3', 'c4', 'c5']);
  assert.deepEqual(flatten(t, ['g1']).map((x) => x.id), ['g1', 'orfa', 'c3', 'c4', 'c5']);
  assert.deepEqual(flatten(t, ['g3']).map((x) => x.id), ['g1', 'g2', 'c1', 'g3', 'orfa', 'c3', 'c4', 'c5']);
});

test('range: the visible rows between both ends, folders included', () => {
  const p = flatten(buildTree(groups, cams));
  // visible order: g1, g2, c1, g3, g4, c2, orfa, c3, c4, c5
  assert.deepEqual(range(p, 'c1', 'c3'), [
    { kind: 'camera', id: 'c1' }, { kind: 'group', id: 'g3' }, { kind: 'group', id: 'g4' },
    { kind: 'camera', id: 'c2' }, { kind: 'group', id: 'orfa' }, { kind: 'camera', id: 'c3' },
  ]);
  assert.deepEqual(range(p, 'c3', 'c1'), range(p, 'c1', 'c3'), 'inverted end gives the same range');
  assert.deepEqual(range(p, 'c4', 'c5'), [{ kind: 'camera', id: 'c4' }, { kind: 'camera', id: 'c5' }]);
  assert.deepEqual(range(p, 'g2', 'g4'), [
    { kind: 'group', id: 'g2' }, { kind: 'camera', id: 'c1' }, { kind: 'group', id: 'g3' }, { kind: 'group', id: 'g4' },
  ]);
});

test('range: an invisible end (closed folder) becomes only the clicked end, camera OR folder', () => {
  const p = flatten(buildTree(groups, cams), ['g1']);
  assert.deepEqual(range(p, 'c1', 'c3'), [{ kind: 'camera', id: 'c3' }]);
  // g1 stays visible with its own folder closed: the range g1..c3 takes what lies between them
  assert.deepEqual(range(p, 'g1', 'c3'), [
    { kind: 'group', id: 'g1' }, { kind: 'group', id: 'orfa' }, { kind: 'camera', id: 'c3' },
  ]);
  // the visible folder end enters the selection — it is the new contract (folders are selectable)
  assert.deepEqual(range(p, 'c1', 'orfa'), [{ kind: 'group', id: 'orfa' }]);
  assert.deepEqual(range(p, 'c1', 'nao-existe'), []);
});

// Task 1.1 of the 2026-10-17 plan: `normalize` is the pruning used by the filter (blocks transcribed from the plan).
it('normalize strips accent and case (including cedilla)', () => {
  expect(normalize('Ação')).toBe('acao');
  expect(normalize('PACARAIMA')).toBe('pacaraima');
  expect(normalize('Rodoviária BVB')).toBe('rodoviaria bvb');
  expect(normalize('')).toBe('');
});

it('an empty filter returns everything (today\'s path, no pruning)', () => {
  const gs = [{ id: 'a', name: 'Aeroporto' }];
  const cams = [{ id: 'c1', name: 'Portao', group_id: 'a' }, { id: 'c2', name: 'Solo' }];
  const r = filterCameras(gs, cams, '');
  expect(r.cameras).toHaveLength(2);
  expect(r.groups).toHaveLength(1);
});

it('the camera matches by name and the folder appears only as an ancestor', () => {
  const gs = [{ id: 'a', name: 'Aeroporto' }, { id: 'b', name: 'Bairro' }];
  const cams = [{ id: 'c1', name: 'Portao 1', group_id: 'a' }, { id: 'c2', name: 'Rua X', group_id: 'b' }];
  const r = filterCameras(gs, cams, 'portao');
  expect(r.cameras.map((c) => c.id)).toEqual(['c1']);
  expect(r.groups.map((g) => g.id)).toEqual(['a']);   // folder 'b' disappears
});

it('the folder does NOT match on its own: a folder name without a matching camera brings nothing', () => {
  const gs = [{ id: 'a', name: 'Aeroporto' }];
  const cams = [{ id: 'c1', name: 'Portao 1', group_id: 'a' }];
  expect(filterCameras(gs, cams, 'aeroporto').groups).toEqual([]);
  expect(filterCameras(gs, cams, 'aeroporto').cameras).toEqual([]);
});

it('pruning walks the whole subtree up: a matching grandchild brings its grandparent and parent', () => {
  const gs = [{ id: 'a', name: 'Raiz' }, { id: 'b', name: 'Filho', parent_id: 'a' }];
  const cams = [{ id: 'c1', name: 'Portao', group_id: 'b' }];
  expect(filterCameras(gs, cams, 'portao').groups.map((g) => g.id).sort()).toEqual(['a', 'b']);
});

it('matches without accent on both sides', () => {
  const gs: { id: string; name: string }[] = [];
  const cams = [{ id: 'c1', name: 'Ação Central' }];
  expect(filterCameras(gs, cams, 'acao').cameras).toHaveLength(1);
  expect(filterCameras(gs, [{ id: 'c1', name: 'Acao Central' }], 'ação').cameras).toHaveLength(1);
});

// Task 3.2 of the 2026-10-17 plan: the `device` node in the tree — the device is a CONTAINER (amendment E8).
const ds = [{ id: 'd1', name: 'DVR' }];

it('device: the child with device_id lives inside the device, not at the root or in the folder', () => {
  const gs = [{ id: 'g1', name: 'Sede' }];
  const cs = [
    { id: 'c1', name: 'Canal 1', device_id: 'd1' },
    { id: 'c2', name: 'Portao', group_id: 'g1' },
  ];
  const t = buildTree(gs, cs, ds);
  assert.deepEqual(t.map((n) => n.name), ['Sede', 'DVR'], 'the device enters the root after the folders');
  const d1 = t[1];
  if (d1.kind !== 'device') throw new Error('expected a device');
  assert.deepEqual(d1.children.map((n) => n.id), ['c1'], 'the child lives inside the device');
  assert.ok(!t.some((n) => n.id === 'c1'), 'the child does NOT appear at the root');
  const g1 = t[0];
  if (g1.kind !== 'group') throw new Error('expected a folder');
  assert.deepEqual(g1.children.map((n) => n.id), ['c2'], 'the folder has only its own camera');
});

it('device: an orphan device_id returns the camera to the folder/root (nothing vanishes)', () => {
  const gs = [{ id: 'g1', name: 'Sede' }];
  const cs = [
    { id: 'c1', name: 'ComPasta', device_id: 'nao-existe', group_id: 'g1' },
    { id: 'c2', name: 'SemPasta', device_id: 'nao-existe' },
  ];
  const t = buildTree(gs, cs, ds);
  const g1 = t[0];
  if (g1.kind !== 'group') throw new Error('expected a folder');
  assert.deepEqual(g1.children.map((n) => n.id), ['c1'], 'the orphan with a folder goes back to the folder');
  assert.ok(t.some((n) => n.kind === 'camera' && n.id === 'c2'), 'the orphan without a folder falls to the root, it does not vanish');
});

it('flatten: the device is a container — it does not enter the list, its children do; closed, they vanish', () => {
  const gs = [{ id: 'g1', name: 'Sede' }];
  const cs = [
    { id: 'c1', name: 'Canal 1', device_id: 'd1' },
    { id: 'c2', name: 'Portao', group_id: 'g1' },
  ];
  const t = buildTree(gs, cs, ds);
  const flat = flatten(t);
  assert.ok(!flat.some((p) => p.id === 'd1'), 'the device does not enter the selection (amendment E8)');
  assert.deepEqual(flat.map((p) => p.id), ['g1', 'c2', 'c1'], 'the children appear in tree order');
  assert.deepEqual(flatten(t, ['d1']).map((p) => p.id), ['g1', 'c2'], 'a closed device hides its children');
  // 2 arguments (like the old tests) come out identical to today's
  assert.deepEqual(buildTree(gs, cs), buildTree(gs, cs, []));
});

// Task 1.3 of the ajustes-sidebar-tela-cheia plan (spec 1.3d): the DVR may live INSIDE a folder.
it('device with group_id enters INSIDE the folder, with its children inside it', () => {
  const gs = [{ id: 'g1', name: 'Sede' }];
  const cs = [
    { id: 'c1', name: 'Canal 1', device_id: 'd1' },
    { id: 'c2', name: 'Portao', group_id: 'g1' },
  ];
  const t = buildTree(gs, cs, [{ id: 'd1', name: 'DVR', group_id: 'g1' }]);
  assert.deepEqual(t.map((n) => n.name), ['Sede'], 'the DVR is no longer loose at the root');
  const g1 = t[0];
  if (g1.kind !== 'group') throw new Error('expected a folder');
  assert.deepEqual(g1.children.map((n) => n.name), ['DVR', 'Portao'], 'the DVR enters the folder, before the loose cameras');
  const d1 = g1.children[0];
  if (d1.kind !== 'device') throw new Error('expected a device');
  assert.deepEqual(d1.children.map((n) => n.id), ['c1'], 'the child stays inside the DVR (the link is device_id)');
});

it('device with a missing group_id goes back to the root (the SAME orphan rule)', () => {
  const gs = [{ id: 'g1', name: 'Sede' }];
  const cs = [{ id: 'c1', name: 'Canal 1', device_id: 'd1' }];
  const t = buildTree(gs, cs, [{ id: 'd1', name: 'DVR', group_id: 'sumiu' }]);
  assert.deepEqual(t.map((n) => n.name), ['Sede', 'DVR'], 'a deleted group cannot take the recorder with it');
  const d1 = t[1];
  if (d1.kind !== 'device') throw new Error('expected a device');
  assert.deepEqual(d1.children.map((n) => n.id), ['c1']);
});

test('directCameras: level-direct only, subfolder cameras never enter', () => {
  assert.deepEqual(directCameras(cams, 'g1'), [], 'g1 has only subfolders -> nothing direct');
  assert.deepEqual(directCameras(cams, 'g2'), ['c1']);
  assert.deepEqual(directCameras(cams, 'g3'), []);
  assert.deepEqual(directCameras(cams, 'g4'), ['c2']);
  assert.deepEqual(directCameras(cams, 'nope'), []);
});

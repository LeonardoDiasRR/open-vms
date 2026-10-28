// Sidebar folder tree: pure, immutable functions.
// The server stores a flat list with parent_id; the tree is built here.

export type Group = { id: string; name: string; parent_id?: string | null };
export type Camera = { id: string; name: string; group_id?: string | null; device_id?: string | null };
export type Device = { id: string; name: string; group_id?: string | null };

// The input accepts both shapes the server/state deliver: a LIST or an index by id.
export type Groups = Group[] | Record<string, Group>;

// Node of the built tree: the camera carries the whole object (the badge reads .state), the group
// carries its children. The generic preserves the concrete camera type that came in.
export type TreeNode<C extends Camera = Camera> =
  | { kind: 'group'; id: string; name: string; children: TreeNode<C>[] }
  | { kind: 'device'; id: string; name: string; children: TreeNode<C>[] }
  | { kind: 'camera'; id: string; name: string; camera: C };

// Flattened row: just the {kind, id} pair — it is what multi-selection consumes.
export type FlatRow = { kind: 'group' | 'camera'; id: string };

// ponytail: one single orphan rule — a parent that does not exist (group deleted by hand,
// old state) becomes root. Valid for groups and cameras, hence the helper.
const rootOf = (parentId: string | null | undefined, ids: Set<string>): string | null =>
  parentId && ids.has(parentId) ? parentId : null;

// ponytail: the server returns a LIST (`GET /api/v1/groups`) and these functions need the index
// by id — normalize here, in one place. Making every caller convert was what left the whole tree
// flat on screen: with an array, `ids` became {'0'} and no group_id was recognized.
const byId = (groups: Groups): Record<string, Group> =>
  Array.isArray(groups) ? Object.fromEntries(groups.map((g) => [g.id, g] as const)) : groups;

export function buildTree<C extends Camera>(groups: Groups, cameras: C[], devices: Device[] = []): TreeNode<C>[] {
  const gs = byId(groups);
  const ids = new Set(Object.keys(gs));
  const deviceIds = new Set(devices.map((d) => d.id));
  const children = new Map<string | null, TreeNode<C>[]>(); // parentId | null -> nodes
  const push = (key: string | null, node: TreeNode<C>) => {
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(node);
  };
  const place = (pid: string | null | undefined, node: TreeNode<C>) => push(rootOf(pid, ids), node);
  for (const g of Object.values(gs)) place(g.parent_id, { kind: 'group', id: g.id, name: g.name, children: [] });
  // Device: goes to the ROOT by default and INSIDE the folder when it has `group_id` (spec 2026-10-17, 1.3d).
  // Uses the SAME orphan rule as folders and cameras: a missing group returns the recorder to the
  // root instead of losing it. It goes in before the loose cameras (map insertion order).
  for (const d of devices) place(d.group_id ?? null, { kind: 'device', id: d.id, name: d.name, children: [] });
  for (const c of cameras) {
    // the child lives INSIDE the device; a missing device (old state) returns the camera to the folder
    const inside = c.device_id && deviceIds.has(c.device_id) ? c.device_id : null;
    if (inside) push(inside, { kind: 'camera', id: c.id, name: c.name, camera: c });
    else place(c.group_id ?? null, { kind: 'camera', id: c.id, name: c.name, camera: c });
  }
  // ponytail: walk down from the root — a cycle recorded in the state (a→b→a) is simply
  // never reached instead of freezing the render
  const build = (pid: string | null): TreeNode<C>[] =>
    (children.get(pid) || []).map((n) => (n.kind === 'camera' ? n : { ...n, children: build(n.id) }));
  return build(null);
}

export function descendants(groups: Groups, id: string): string[] {
  const gs = byId(groups);
  const out: string[] = [];
  const queue: string[] = [id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const g of Object.values(gs)) {
      if (g.parent_id === current) { out.push(g.id); queue.push(g.id); }
    }
  }
  return out;
}

// spec 2026-10-27: the wall shows the cameras DIRECTLY under the folder; subfolder cameras only
// open when the user opens the subfolder itself
export function directCameras<C extends Camera>(cameras: C[], id: string): string[] {
  return cameras.filter((c) => c.group_id === id).map((c) => c.id);
}

// moving a group into itself (or into a descendant) would create a cycle
export function canMove(groups: Groups, id: string, newParentId: string | null): boolean {
  if (newParentId == null) return true;
  if (id === newParentId) return false;
  return !descendants(groups, id).includes(newParentId);
}

// flatten: the VISIBLE tree in reading order (a closed folder hides its children).
// Returns folders and cameras; multi-selection only uses the cameras.
export function flatten<C extends Camera>(nodes: TreeNode<C>[], closed: string[] = []): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (list: TreeNode<C>[]) => {
    for (const n of list) {
      // the device node is a CONTAINER: it descends into the children and does not enter the
      // selection (amendment E8) — this way `FlatRow` and `Marked` keep two/three kinds and the
      // Shift range does not change meaning
      if (n.kind === 'device') { if (!closed.includes(n.id)) walk(n.children); continue; }
      out.push({ kind: n.kind, id: n.id });
      if (n.kind === 'group' && !closed.includes(n.id)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

// range: the VISIBLE rows between two visible rows, inclusive, in the order they appear
// (Shift+click). Folders are included: multi-selection accepts camera and folder ({kind, id} pairs).
// An invisible end (its folder is closed) does not drop the action: only the clicked end remains.
export function range(rows: FlatRow[], fromId: string, toId: string): FlatRow[] {
  const i = rows.findIndex((x) => x.id === fromId);
  const j = rows.findIndex((x) => x.id === toId);
  if (i < 0 || j < 0) return rows.filter((x) => x.id === toId).map((x) => ({ kind: x.kind, id: x.id }));
  const [a, b] = i <= j ? [i, j] : [j, i];
  return rows.slice(a, b + 1).map((x) => ({ kind: x.kind, id: x.id }));
}

// Lowercase + accent folding, so a search for 'acao' also matches the accented spelling (spec 2026-10-17, section 4.2).
// Does NOT trim: the caller decides (the sidebar and the panel trim their own text first).
export function normalize(text: string): string {
  return String(text || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

// Tree pruning by the filter (spec 4.3): the CAMERA matches by name; the FOLDER does not match on
// its own — it only enters as an ancestor of a camera that matched. An empty filter returns
// everything, so the filtered and unfiltered paths are the same code (today's behavior is intact).
// ponytail: walk up from the camera to the root instead of descending the whole subtree — same
// set, fewer operations.
export function filterCameras<C extends Camera>(groups: Groups, cameras: C[], filter: string):
  { groups: Group[]; cameras: C[] } {
  const gs = byId(groups);
  const ids = new Set(Object.keys(gs));
  const needle = normalize(filter.trim());
  if (!needle) return { groups: Object.values(gs), cameras };
  const matches = cameras.filter((c) => normalize(c.name).includes(needle));
  const ancestors = new Set<string>();
  for (const c of matches) {
    let current = rootOf(c.group_id, ids);
    while (current && !ancestors.has(current)) {
      ancestors.add(current);
      current = rootOf(gs[current]?.parent_id, ids);   // `rootOf` cuts a missing parent: a state cycle does not hang
    }
  }
  return { groups: Object.values(gs).filter((g) => ancestors.has(g.id)), cameras: matches };
}

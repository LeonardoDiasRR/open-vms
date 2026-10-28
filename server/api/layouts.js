'use strict';
const { randomUUID } = require('node:crypto');
const { AppError } = require('../lib/errors');
// ponytail: routes = path->handler map, testable without an HTTP server (same pattern as archive.js).
// Unlimited plane (spec 2026-10-14): no cols/rows; the geometry lives in the cells.
// The document is out of this file: layouts live in `store.ops.layouts` (spec 2026-10-20 §6).
const MAX_CELLS = 1024; // abuse ceiling, not a grid limit
const int = (v, min) => Number.isInteger(v) && v >= min;

// The API speaks epoch seconds for `created_ts`/`updated_ts`; the column is timestamptz. Converting
// at the boundary keeps the client contract unchanged by the storage change.
const epoch = (ts) => Math.floor(new Date(ts).getTime() / 1000);
const apiShape = (l) => ({ ...l, created_ts: epoch(l.created_ts), updated_ts: epoch(l.updated_ts) });

function layoutRoutes(store) {
  const layouts = store.ops.layouts;
  return {
    'GET /api/v1/layouts': async () => (await layouts.list()).map(apiShape),

    'POST /api/v1/layouts': async ({ id, name, cells } = {}) => {
      if (typeof name !== 'string' || !name.trim()) throw new AppError('name_required');
      // cells is mandatory (no default): the client always sends the list, and a PUT without it would
      // silently wipe the layout
      if (!Array.isArray(cells) || cells.length > MAX_CELLS) throw new AppError('layout_cells_invalid');
      for (const c of cells) {
        if (!c || typeof c.id !== 'string') throw new AppError('layout_cell_without_id');
        if (!int(c.col, 0) || !int(c.row, 0) || !int(c.colspan, 1) || !int(c.rowspan, 1))
          throw new AppError('layout_cell_geometry_invalid');
      }
      const lid = id || randomUUID();
      // One read serves both rules: the duplicate name and the created_ts the upsert must preserve.
      const all = await layouts.list();
      if (all.some((l) => l.name === name && l.id !== lid)) throw new AppError('layout_exists', { name });
      const prev = all.find((l) => l.id === lid);
      const now = new Date();
      const layout = await layouts.put({ id: lid, name, cells,
        created_ts: prev ? prev.created_ts : now, updated_ts: now });
      return apiShape(layout);
    },

    'DELETE /api/v1/layouts': async ({ ids, id } = {}) => {
      const target = Array.isArray(ids) ? ids : (id ? [id] : []);
      if (!target.length) throw new AppError('layout_ids_required');
      // All or nothing: the existence check runs BEFORE the first delete, as the old single write did.
      const known = new Set((await layouts.list()).map((l) => l.id));
      if (target.some((x) => !known.has(x))) throw new AppError('layout_not_found');
      for (const x of target) await layouts.remove(x);
      return { deleted: target };
    },
  };
}
module.exports = { layoutRoutes };

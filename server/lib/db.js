'use strict';
const fs = require('node:fs'), path = require('node:path');
const { migrateAccess } = require('./access-migration');
const { migrateNomenclature } = require('./nomenclature-migration');
const { record } = require('./audit');
// ponytail: single-writer per process, no locks (M1; Postgres replaces it in M3 of the TRD)
function openState(dir) {
  const file = path.join(dir, 'state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { state = { cameras: {}, profiles: {}, segments: {}, gaps: [], users: {}, sessions: {}, candidates: {}, credentials: {}, layouts: {}, exports: {}, scans: {}, groups: {} }; }
  // one-way migration (spec 2026-10-14): mural became layout; cols/rows belonged to the fixed grid
  // and mean nothing in the unlimited plan — only the used fields carry over.
  if (state.walls) {
    state.layouts = { ...(state.layouts || {}) };
    for (const [id, w] of Object.entries(state.walls)) {
      if (state.layouts[id]) continue; // conflicting id: the existing layout wins
      state.layouts[id] = { id, name: w.name, cells: w.cells || [], created_ts: w.created_ts, updated_ts: w.updated_ts };
    }
    delete state.walls;
  }
  // writes the whole document to disk atomically (the `.tmp` + rename is what guarantees an
  // interruption leaves the OLD file complete, never mixed).
  const persist = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  };
  // ATOMIC backup before any load mutation (§11.1). Only when a document already exists — a fresh
  // installation has nothing to preserve.
  const backup = () => {
    const tmp = file + '.bak.tmp';
    fs.copyFileSync(file, tmp);
    fs.renameSync(tmp, file + '.bak');
  };
  // one-way migration of the access model (spec 2026-10-17 §11): runs on load and persists ONCE.
  // The pt-BR -> English nomenclature comes first: access already sees the document with the new keys.
  const { changed } = migrateNomenclature(state);
  const { changed: accessChanged, events } = migrateAccess(state);
  if (accessChanged || changed > 0) {
    if (fs.existsSync(file)) backup();
    persist();
    for (const e of events) record(dir, e);
  }
  return {
    get: () => state,
    mutate(fn) {
      fn(state);
      persist();
    },
  };
}
module.exports = { openState };

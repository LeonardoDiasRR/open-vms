'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createPool, migrate, withTx } = require('./pgpool');
const { importState } = require('./import-state');
const { loadConfigFile } = require('./config-file');
const { catalog } = require('../repo/catalog');
const { access, sessions, ops } = require('../repo/store-ops');
const mediaIndex = require('../repo/media-index');
const { cardOfRow } = require('./fmp4index');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

// Read the legacy document. A malformed file is a boot failure, not something to skip: importing
// half a state is worse than refusing to start.
function readStateFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw Object.assign(new Error(`state.json is not valid JSON (${file}): ${err.message}`), {
      code: 'state_invalid',
      field: 'state.json',
    });
  }
}

// The writer is only useful if it can write: create the directory on first boot and fail loudly
// when it cannot be written, instead of discovering it on the first recording.
function checkArchiveDir(config) {
  const dir = config.recordings.archive_dir;
  try {
    if (typeof dir !== 'string' || dir.trim() === '') throw new Error('archive_dir is not set');
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    throw Object.assign(
      new Error(`recordings.archive_dir is not writable: ${dir ?? '(unset)'} (${err.code || err.message})`),
      { code: 'config_archive_dir_required', field: 'recordings.archive_dir' },
    );
  }
}

// Single entry point for the PostgreSQL store: pool, schema, migrations, one-shot import, config.
// Repositories take the pool, so they stay unaware of boot order.
async function openStore({ url, dataDir, configPath, schema, checkArchive = true } = {}) {
  // schema goes in the startup packet; unset means the connection's own search_path (public).
  const pool = createPool({ url, options: schema ? `-c search_path=${schema},public` : undefined });
  try {
    await migrate(pool, { dir: MIGRATIONS });

    const doc = dataDir ? readStateFile(path.join(dataDir, 'state.json')) : null;
    const result = doc ? await importState(pool, doc) : { imported: false };
    const imported = result.imported === true;
    const importCounts = result.counts || null;
    // System access profiles are part of the schema contract (every user row points at one of them).
    // Seeded AFTER the import: the legacy document already carries them, and a fresh database needs them.
    await pool.query(`INSERT INTO access_profiles (id, name, kind) VALUES
      ('admin','admin','system'), ('operator','operator','system'), ('viewer','viewer','system')
      ON CONFLICT (id) DO NOTHING`);

    const config = loadConfigFile(configPath);
    if (checkArchive) checkArchiveDir(config);

    return {
      mode: 'pg',
      pool,
      catalog: catalog(pool),
      access: access(pool),
      sessions: sessions(pool),
      ops: ops(pool),
      // plan 2026-10-20: the persisted media index, bound to the pool — the boot hydrates from here and
      // the write-behind sends the changes back. Absent in the in-memory store: there the index is
      // rebuilt from disk on every boot, as before.
      media: {
        loadAll: () => mediaIndex.loadAll(pool),
        // Boot: metadata only (plan 2026-10-20). The fragments of an hour come from `fragsFor`, one PK
        // query, when someone seeks into it.
        loadMeta: () => mediaIndex.loadMeta(pool),
        // The timeline's read (plan 2026-10-20, T1/T4): one (profile, day) window, no fragments.
        loadWindow: (profile, days) => mediaIndex.loadWindow(pool, profile, days),
        // Retention: the whole archive as cards, still no fragment list — `runRetention` plans over hours,
        // not over fragments.
        listAll: async () => (await mediaIndex.listAll(pool)).map(cardOfRow),
        fragsFor: (profile, day, hour, session) => mediaIndex.fragsFor(pool, profile, day, hour, session),
        listPaths: () => mediaIndex.listPaths(pool),
        loadDays: () => mediaIndex.loadDays(pool),
        upsertHours: (rows) => mediaIndex.upsertHours(pool, rows),
        upsertDays: (rows) => mediaIndex.upsertDays(pool, rows),
        deleteHours: (paths) => mediaIndex.deleteHours(pool, paths),
        forget: (paths) => mediaIndex.forget(pool, paths),
      },
      config,
      imported,
      importCounts,
      tx: (fn) => withTx(pool, fn),
      close: () => pool.end(),
    };
  } catch (err) {
    // A failed boot must not leave an open pool behind: its handles keep the process alive.
    await pool.end().catch(() => {});
    throw err;
  }
}

module.exports = { openStore };

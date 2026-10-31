'use strict';
const { migrateAccess } = require('./access-migration');
const { migrateNomenclature } = require('./nomenclature-migration');
const { record } = require('./audit');
const { AppError } = require('./errors');

// ponytail: faithful port of the local JSON store document (db.js) — one table, one jsonb row.
// Relational schema only when there is real relational querying (YAGNI). The initial state mirrors
// the `db.js:openState` default so a freshly created database does not hand out a document missing
// the keys the rest of the server assumes.
const EMPTY = {
  cameras: {}, profiles: {}, segments: {}, gaps: [], users: {}, sessions: {},
  candidates: {}, credentials: {}, walls: {}, exports: {}, scans: {}, groups: {},
};

async function openPgState({ url, table = 'openvms_state', dir = null }) {
  let pg;
  try {
    // ponytail: optional, lazy dependency — without 'pg' installed the JSON mode keeps working
    pg = require('pg');
  } catch {
    throw new AppError('pg_missing');
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  // ponytail: the table name comes from the operator config, not from the user; DDL takes no bind
  await client.query(`CREATE TABLE IF NOT EXISTS ${table} (id int primary key, doc jsonb not null)`);
  const { rows } = await client.query(`SELECT doc FROM ${table} WHERE id = 1`);
  let state = rows[0] && rows[0].doc ? rows[0].doc : JSON.parse(JSON.stringify(EMPTY));
  // One-way migration of the access model (spec 2026-10-17 §11), BEFORE any mutate enters the
  // chain: the await here guarantees the first write queued by the rest of the server already sees
  // the new document. ATOMIC backup = the OLD row goes whole into the backup table before the
  // UPDATE (same guarantee as the JSON store `.bak`).
  const previous = rows[0] ? JSON.parse(JSON.stringify(rows[0].doc)) : null;
  // The pt-BR -> English nomenclature runs first (and mutates `state` in place, like access).
  const { changed } = migrateNomenclature(state);
  const { changed: accessChanged, events } = migrateAccess(state);
  // ponytail: `state` ALIASES `rows[0].doc` — `migrateAccess` mutates in place, so the OLD document
  // has to be photographed BEFORE the migration (otherwise the backup would keep the new one).
  if (accessChanged || changed > 0) {
    if (rows[0] && previous) {
      await client.query(`CREATE TABLE IF NOT EXISTS ${table}_bak (id serial primary key, doc jsonb not null, at timestamptz not null default now())`);
      await client.query(`INSERT INTO ${table}_bak (doc) VALUES ($1)`, [previous]);
    }
    await client.query(`INSERT INTO ${table} (id, doc) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc`, [state]);
    for (const e of events) record(dir, e);
  }
  // ponytail: serial write chain. Historical callers call mutate without await (the JSON store was
  // synchronous), so the chain preserves order and close() drains it before ending the socket; a
  // write that fails does not block the next ones nor become an unhandledRejection — the lost data
  // shows up again on the next load (known ceiling).
  let chain = Promise.resolve();
  return {
    get: () => state,
    mutate(fn) {
      fn(state);
      chain = chain.then(() => client.query(
        `INSERT INTO ${table} (id, doc) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc`,
        [state],
      )).catch(() => {});
      return chain;
    },
    async close() { await chain; await client.end(); },
  };
}

module.exports = { openPgState };

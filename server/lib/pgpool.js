'use strict';
const fs = require('node:fs'), path = require('node:path');
const pg = require('pg');

// ponytail: options on the client config (startup packet) instead of a `SET` after connect — one
// connection string, no second query in the hot path.
// `options` (e.g. `-c search_path=tenant,public`) rides the same startup packet: every connection
// the pool opens gets the schema before its first statement.
function createPool({ url, max = 10, options } = {}) {
  return new pg.Pool({
    connectionString: url,
    max,
    application_name: 'ovms-api',
    statement_timeout: 15000,
    ...(options ? { options } : {}),
  });
}

// Same DDL as 001_init.sql: the runner has to create its own bookkeeping table before it can read
// it, and the migration then finds it already there.
const SCHEMA_MIGRATIONS = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version int PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

// Serializes boots across API instances (advisory lock is per database, not per session state).
// No per-file transaction: every migration is written idempotent (IF NOT EXISTS / DROP+CREATE), so
// a crash mid-file is repaired by the next boot re-running it.
async function migrate(pool, { dir }) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(4242)');
    try {
      await client.query(SCHEMA_MIGRATIONS);
      const { rows } = await client.query('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.version));
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        const version = parseInt(file, 10);
        if (applied.has(version)) continue;
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        // ON CONFLICT: the file itself also records its version (001_init.sql does).
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
          [version],
        );
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(4242)');
    }
  } finally {
    client.release();
  }
}

async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, migrate, withTx };

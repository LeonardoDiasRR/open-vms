'use strict';
// Development/test fallback: startServer imported as a module without OPENVMS_PG_URL runs on an
// in-memory store. The process CLI refuses to start without PostgreSQL (see main.js). The cache is
// keyed by dataDir so a test that restarts the server keeps the same rows.
const fs = require('node:fs');
const path = require('node:path');
const { memStore, CAMERA_META_KEYS } = require('./mem-store');
const { loadConfigFile } = require('./config-file');

const cache = new Map();

function fallbackConfig(dataDir, configPath) {
  if (configPath && fs.existsSync(configPath)) return loadConfigFile(configPath);
  return {
    recordings: {
      retention_days: 3,
      disk_max_percent: 80,
      archive_dir: path.resolve(dataDir || './data', 'archive'),
    },
    events: { retention_days: 30 },
  };
}

// Legacy document view over the in-memory tables. The HTTP/E2E suite still drives the server through
// `srv.state.get()/mutate()`; the memory store is the only place where that view is safe (it is a
// test/dev fallback, never PostgreSQL). Writes land on the same row objects the store methods read.
const KEYED = {
  cameras: 'id', profiles: 'id', groups: 'id', devices: 'id', layouts: 'id', exports: 'id',
  scans: 'id', candidates: 'id', users: 'username', credentials: 'ref', access_profiles: 'id',
  sessions: 'token_hash',
};

// A camera row as the legacy document presented it: the `meta` jsonb keys were top-level fields
// (`positions`, `onvif`, `ptz`, ...). The proxy flattens them on read and writes them back into `meta`,
// so a fixture that plants `cameras[id].positions = [...]` lands where the routes read it.
function cameraRow(row) {
  const isMeta = (k) => CAMERA_META_KEYS.includes(k);
  return new Proxy(row, {
    get(t, k) {
      if (typeof k === 'string' && isMeta(k)) return (t.meta || {})[k];
      return t[k];
    },
    set(t, k, v) {
      if (typeof k === 'string' && isMeta(k)) { t.meta = { ...(t.meta || {}), [k]: v }; return true; }
      t[k] = v;
      return true;
    },
  });
}

function mapProxy(rows, key, wrap = (r) => r) {
  const find = (id) => rows.find((r) => r[key] === id);
  return new Proxy({}, {
    get(_t, id) { const r = typeof id === 'string' ? find(id) : undefined; return r && wrap(r); },
    set(_t, id, value) {
      const i = rows.findIndex((r) => r[key] === id);
      if (value === undefined) { if (i >= 0) rows.splice(i, 1); return true; }
      if (i >= 0) rows[i] = value; else rows.push(value);
      return true;
    },
    deleteProperty(_t, id) {
      const i = rows.findIndex((r) => r[key] === id);
      if (i >= 0) rows.splice(i, 1);
      return true;
    },
    has(_t, id) { return !!find(id); },
    ownKeys() { return rows.map((r) => r[key]); },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  });
}

// `m.exports = {...}` (the whole table at once) is how the old document fixtures planted rows. The view
// forwards it into the same array the store methods read instead of replacing the view property.
function table(view, name, getProxy, setRows) {
  Object.defineProperty(view, name, {
    enumerable: true, configurable: true,
    get: getProxy,
    set(value) {
      if (Array.isArray(value)) setRows(value);
      else setRows(Object.values(value || {}));
    },
  });
}

function legacyView(mem) {
  const view = {};
  for (const [name, key] of Object.entries(KEYED)) {
    const rows = mem[name] || [];
    const wrap = name === 'cameras' ? cameraRow : (r) => r;
    table(view, name, () => mapProxy(rows, key, wrap), (next) => { rows.length = 0; rows.push(...next); });
  }
  // events/gaps are plain arrays in the legacy document.
  for (const name of ['events', 'gaps']) {
    table(view, name, () => mem[name], (next) => { mem[name] = next; });
  }
  view.segments = {};
  view.settings = {};
  return view;
}

function openMemoryStore({ dataDir = './data', configPath } = {}) {
  const key = path.resolve(dataDir);
  let store = cache.get(key);
  if (!store) {
    const mem = memStore();
    // Same schema contract as openStore (PostgreSQL): the three SYSTEM access profiles exist from the
    // first boot. Without them the users list (INNER JOIN on the profile) hides every seeded user.
    for (const id of ['admin', 'operator', 'viewer']) {
      mem.mem.access_profiles.push({ id, name: id, kind: 'system',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    }
    store = {
      mode: 'memory',
      pool: null,
      ...mem,
      config: fallbackConfig(dataDir, configPath),
      imported: false,
      importCounts: null,
      state: { get: () => legacyView(mem.mem), mutate: (fn) => fn(legacyView(mem.mem)) },
      close: async () => {},
    };
    // memStore's tx hands back the store; keep that contract for the injected routes.
    store.tx = (fn) => fn(store);
    cache.set(key, store);
  }
  return store;
}

module.exports = { openMemoryStore };

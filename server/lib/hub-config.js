'use strict';
const http = require('node:http');
const { AppError } = require('./errors');

// Minimal client for the mediamtx Control API (spec 2026-10-16). No dependency: the Hub listens on
// loopback and requires no auth on that listener (authHTTPExclude: [{action: api}]).
// ponytail: 3 calls and one JSON — not worth a generic HTTP client.
function call(base, method, relPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const url = new URL(relPath, base);
    const req = http.request({ method, hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, timeout: 5000,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} },
    (res) => {
      let txt = '';
      res.on('data', (c) => { txt += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: txt }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout on the Hub Control API')));
    if (data) req.write(data);
    req.end();
  });
}

const encodePath = (relPath) => String(relPath).split('/').map(encodeURIComponent).join('%2F');

// replace is the API's UPSERT (add returns 400 if the name exists); there is no delete in 1.21.2.
async function publishPath(base, relPath, { source, startTimeout = '10s', closeAfter = '10s' }) {
  // measured bug 2026-10-19: without TCP on the SOURCE, UDP loss on the WAN enters the recording as
  // corrupted H.264. In 1.21.2 the GLOBAL config rejects these fields, but the per-path replace
  // accepts them (tested on the 1.21.2 container: 200 with both). Both fields go for safety — the
  // canonical name changed between versions.
  const r = await call(base, 'POST', `/v3/config/paths/replace/${encodePath(relPath)}`, {
    source, sourceOnDemand: true, sourceProtocol: 'tcp', rtspTransport: 'tcp',
    sourceOnDemandStartTimeout: startTimeout, sourceOnDemandCloseAfter: closeAfter,
  });
  if (r.status !== 200) {
    const e = new AppError('hub_path_refused', { path: relPath, body: r.body, status: r.status });
    e.status = r.status;   // the Hub status is the transport status, as before
    throw e;
  }
  return r.status;
}

// Without a reader, it removes the configuration and the path stays inert (nobody publishes).
async function removePath(base, relPath) {
  const r = await call(base, 'POST', `/v3/config/paths/replace/${encodePath(relPath)}`, { source: 'publisher' });
  if (r.status !== 200) {
    const e = new AppError('hub_remove_refused', { path: relPath, body: r.body, status: r.status });
    e.status = r.status;
    throw e;
  }
  return r.status;
}

// `ready` does NOT exist in /v3/config/paths/list (it describes the CONFIGURATION, not the state):
// what knows whether the path is up is /v3/paths/list (runtime). Without joining the two, `pronto`
// would always be false and the `active` of GET /api/v1/rtsp would never list any path (measured on
// the host's 1.21.2).
// The Hub PAGINATES these lists (100 items by default). Reading only the first page makes every
// path beyond it look ABSENT: on 2026-10-24 a Hub with 5.864 paths republished all 40 camera paths
// every reconcile cycle (the cameras lived on pages 8 to 56), and `ready` came out false for all of
// them. Read every page.
const PAGE_SIZE = 1000;
async function listAll(base, relPath) {
  const items = [];
  for (let page = 0; ; page++) {
    const r = await call(base, 'GET', `${relPath}?page=${page}&itemsPerPage=${PAGE_SIZE}`);
    if (r.status !== 200) return { status: r.status, items: null };
    const body = JSON.parse(r.body);
    const pageItems = body.items || [];
    items.push(...pageItems);
    if (!pageItems.length || page + 1 >= (body.pageCount || 1)) return { status: 200, items };
  }
}

async function listPaths(base) {
  const r = await listAll(base, '/v3/config/paths/list');
  if (r.status !== 200) {
    const e = new AppError('hub_paths_unlisted', { status: r.status });
    e.status = r.status;
    throw e;
  }
  const config = r.items;
  let runtime = [];
  try {
    const rr = await listAll(base, '/v3/paths/list');
    if (rr.status === 200) runtime = rr.items;
  } catch { runtime = []; }
  const ready = new Set(runtime.filter((i) => i.ready === true).map((i) => i.name));
  return config.map((i) => ({
    name: i.name, source: i.source || null, ready: ready.has(i.name),
    transport: i.rtspTransport || null,
  }));
}

// The Control API config lives in memory: a restarted Hub loses everything. It reapplies what is
// missing and what diverged — the only recovery path without restarting the API.
async function reconcile(base, desired) {
  const current = new Map((await listPaths(base)).map((c) => [c.name, c]));
  const published = [];
  for (const [name, cfg] of Object.entries(desired)) {
    const atual = current.get(name);
    // the skip also requires the right TRANSPORT: old paths (automatic=UDP) need ONE replace to
    // become TCP, otherwise reconcile would never reapply (measured 19/10)
    if (atual && atual.source === cfg.source && atual.transport === 'tcp') continue;
    await publishPath(base, name, cfg);
    published.push(name);
  }
  return { published };
}

// Path state in the Hub RUNTIME (spec 2026-10-16): only `ready === true` implies available tracks —
// 287 paths answer `online: true` without `ready`. 396 bytes per camera.
async function pathState(base, name) {
  const r = await call(base, 'GET', `/v3/paths/get/${encodePath(name)}`);
  if (r.status !== 200) return false;
  return JSON.parse(r.body).ready === true;
}

// Hub read sessions (spec §8): revoking the ACL cuts the consumer IN PROGRESS with a POST on `kick`.
// MEASURED on mediamtx 1.21.2 of this host: POST /v3/<webrtc|rtsp>sessions/kick/{id} exists (an
// invalid id = 400; GET/DELETE = 404). `rtspconns` has no kick.
async function listSessions(base) {
  const out = [];
  for (const type of ['webrtc', 'rtsp']) {
    try {
      const r = await call(base, 'GET', `/v3/${type}sessions/list`);
      if (r.status !== 200) continue;
      for (const s of (JSON.parse(r.body).items || [])) {
        out.push({ type, id: s.id, path: s.path, user: s.user || '' });
      }
    } catch { /* Hub down: there is no session to cut */ }
  }
  return out;
}

async function kickSession(base, type, id) {
  const r = await call(base, 'POST', `/v3/${type}sessions/kick/${encodeURIComponent(id)}`);
  if (r.status !== 200) {
    const e = new AppError('hub_session_expel_refused', { id, status: r.status });
    e.status = r.status;
    throw e;
  }
  return r.status;
}

module.exports = { publishPath, removePath, listPaths, reconcile, pathState,
  listSessions, kickSession };

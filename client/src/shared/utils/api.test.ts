import { test, it, expect, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startServer } = require('../../../../server/main.js');
import { ApiClient, type PtzCapability, type Session } from './api';

// The fetch/API error is an Error with .status glued on by hand (see api), without its own type:
// the status comes out by narrowing, not by cast (same shape the components use).
const statusOf = (e: unknown): number =>
  typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number' ? e.status : 0;

// F4: the server blocks a user with a pending password change (§7.1.4). The fixture represents the
// operator who ALREADY changed it — without this every administrative method in this file gets 403.
const withoutPendingChange = (srv: any, ...names: string[]) => srv.state.mutate((m: any) => {
  for (const n of names) if (m.users[n]) m.users[n].must_change_password = false;
});

test('login -> cameras -> scan -> add camera -> timeline 404 over real HTTP', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'ovms-')), adminUser: 'admin', adminPassword: 'pw-teste' });
  withoutPendingChange(srv, 'admin');
  try {
  const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
  await assert.rejects(api.cameras(), (e) => statusOf(e) === 401);
  await api.login('admin', 'pw-teste');
  assert.deepEqual(await api.cameras(), []);
  // invalid range: immediate 400 (the server validates before firing the scan).
  // scanner 2026-10-27: a hyphenated single label IS a valid hostname now; use real junk here.
  await assert.rejects(api.startScan({ kind: 'scan', scope: { ips: ['nao e host!'] } }), (e) => statusOf(e) === 400);
  // asynchronous scan: answers at once with {scan_id, state:'running'} and continues in the background
  const start = await api.startScan({ kind: 'scan', scope: { ips: ['127.0.0.1'] } });
  assert.ok(start.scan_id); assert.equal(start.state, 'running');
  // 1s poll until 'done'
  let s = await api.scanStatus(start.scan_id);
  const deadline = Date.now() + 15000;
  while (s.state === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    s = await api.scanStatus(start.scan_id);
  }
  assert.equal(s.state, 'done');
  assert.ok(Number.isFinite(s.found));
  assert.equal((await api.scanStatus('id-inexistente').catch((e) => e)).status, 404); // 404 with an unknown id
  const candidates = await api.discoveryResults(); assert.ok(Array.isArray(candidates));
  const cam = await api.addCamera({ name: 'T', addresses: [{ ip: '127.0.0.1', port: 80, scheme: 'http' }], credential: { username: 'u', password: 'p' } });
  assert.equal(cam.state, 'provisioning');
  await assert.rejects(api.timeline({ stream_profile_id: 'x', from: 0, to: 60 }), (e) => statusOf(e) === 404);
  } finally { srv.close(); }
});

test('the client exposes liveToken, profiles and onvifSync against the real server', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(tmpdir() + '/ovms-'), adminUser: 'admin', adminPassword: 'pw2' });
  withoutPendingChange(srv, 'admin');
  const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
  await api.login('admin', 'pw2');
  const cam = await api.addCamera({ name: 'A', addresses: [], source: 'rtsp://x/main' });
  const tk = await api.liveToken(cam.profile_ids[0]);
  assert.equal(tk.whep_url.includes('/whep'), true);
  assert.equal(typeof tk.token, 'string');
  assert.equal((await api.profiles()).length, 1);
  assert.equal(typeof api.onvifSync, 'function');
  srv.close();
});

test('the client exposes events with a since cursor', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(tmpdir() + '/ovms-'), adminUser: 'admin', adminPassword: 'pw3' });
  withoutPendingChange(srv, 'admin');
  const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
  await api.login('admin', 'pw3');
  const out = await api.events({});
  assert.ok(Array.isArray(out.events));
  assert.ok(out.server_ts > 0);
  const later = await api.events({ since: out.server_ts });
  assert.ok(Array.isArray(later.events));
  srv.close();
});

test('the client exposes groups and camera management against the real server', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(tmpdir() + '/ovms-'), adminUser: 'admin', adminPassword: 'pw4' });
  withoutPendingChange(srv, 'admin');
  try {
    const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
    await api.login('admin', 'pw4');
    assert.deepEqual(await api.groups(), []);
    const g = await api.createGroup({ name: 'Portaria' });
    assert.ok(g.id);
    const sub = await api.createGroup({ name: 'Fundos', parent_id: g.id });
    assert.equal((await api.groups()).length, 2);
    assert.equal((await api.updateGroup(sub.id, { name: 'Fundos 2' })).name, 'Fundos 2');
    const cam = await api.addCamera({ name: 'C', addresses: [], source: 'rtsp://x/' });
    assert.equal((await api.moveCamera(cam.id, sub.id)).group_id, sub.id);
    assert.equal((await api.renameCamera(cam.id, 'C2')).name, 'C2');
    assert.equal((await api.cameras()).find((c) => c.id === cam.id)!.name, 'C2');
    assert.deepEqual(await api.deleteGroup(g.id), { deleted: g.id });
    assert.equal((await api.cameras()).find((c) => c.id === cam.id)!.group_id, sub.id, 'with the parent folder deleted, the camera in the subfolder stays in the subfolder');
    assert.deepEqual(await api.deleteCamera(cam.id), { deleted: cam.id });
    assert.deepEqual(await api.cameras(), []);
    await assert.rejects(api.deleteCamera(cam.id), (e) => statusOf(e) === 404);
    await assert.rejects(api.updateGroup('nao-existe', { name: 'z' }), (e) => statusOf(e) === 404);
  } finally { srv.close(); }
});

test('cameraConfig returns the camera state read over real HTTP', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'ovms-cfg-')), adminUser: 'admin', adminPassword: 'pw-cfg' });
  withoutPendingChange(srv, 'admin');
  try {
    const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
    await api.login('admin', 'pw-cfg');
    const cam = await api.addCamera({ name: 'CFG', addresses: [{ ip: '127.0.0.1', port: 80, scheme: 'onvif' }] });
    const cfg = await api.cameraConfig(cam.id);
    assert.equal(cfg.id, cam.id);
    assert.equal(cfg.name, 'CFG');
    assert.equal(cfg.onvif, null);
    assert.equal(cfg.onvif_error, undefined); // GET is now a pure state read
    assert.equal(cfg.manufacturer, null);
    await assert.rejects(api.cameraConfig('id-que-nao-existe'), (e) => statusOf(e) === 404);
  } finally { srv.close(); }
});

test('brands + setting the manufacturer by hand over real HTTP (informar-fabricante spec)', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'ovms-fab-')), adminUser: 'admin', adminPassword: 'pw-fab' });
  withoutPendingChange(srv, 'admin');
  try {
    const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
    await api.login('admin', 'pw-fab');
    const brands = await api.cameraBrands();
    assert.equal(brands.length, 8);
    assert.ok(brands.some((m) => m.name === 'Uniview'));
    const cam = await api.addCamera({ name: 'FAB', addresses: [{ ip: '127.0.0.1', port: 80, scheme: 'onvif' }] });
    // without credentials: refresh answers 200 with a short error (the client opens the smaller modal)
    const ref = await api.cameraOnvifRefresh(cam.id);
    assert.equal(ref.onvif_error, 'no saved credential');
    await assert.rejects(api.setCameraManufacturer(cam.id, 'Fabricante Inexistente'), (e) => statusOf(e) === 400);
    const cfg = await api.setCameraManufacturer(cam.id, 'Uniview');
    assert.equal(cfg.manufacturer, 'Uniview');
    assert.equal(cfg.manufacturer_source, 'manual');
    assert.equal(cfg.rtsp.primary, 'rtsp://127.0.0.1:554/media/video1');
    assert.equal(cfg.rtsp.secondary, 'rtsp://127.0.0.1:554/media/video2');
    const cfg2 = await api.cameraConfig(cam.id); // persisted: the next GET already brings everything
    assert.equal(cfg2.manufacturer, 'Uniview');
    assert.equal(cfg2.manual!.manufacturer, 'Uniview');
  } finally { srv.close(); }
});

test('the client exposes rtsp (re-streaming state)', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'ovms-')), adminUser: 'admin', adminPassword: 'pw-teste' });
  withoutPendingChange(srv, 'admin');
  try {
    const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
    await api.login('admin', 'pw-teste');
    const r = await api.rtsp();
    assert.equal(r.enabled, true); // mandatory resource: on with no env at all
    assert.equal(r.port, 8554);
    // `active` lists what the HUB has READY now: without a Hub it is []; with a read path it comes as the name.
    // The list cannot be pinned — the test Hub is shared between the suite files.
    assert.ok(Array.isArray(r.active), 'active is the list of paths ready in the Hub');
  } finally { srv.close(); }
  const off = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'ovms-')), adminUser: 'admin', adminPassword: 'pw-teste', rtsp: false });
  withoutPendingChange(off, 'admin');
  try {
    const api2 = new ApiClient(`http://127.0.0.1:${off.port}`);
    await api2.login('admin', 'pw-teste');
    const r2 = await api2.rtsp();
    assert.equal(r2.enabled, false); // OPENVMS_RTSP=0 is the only way to turn it off
    assert.deepEqual(r2.active, []);
  } finally { off.close(); }
});

test('addCamera carries the reported port marker to the server', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'ovms-')), adminUser: 'admin', adminPassword: 'pw-teste' });
  withoutPendingChange(srv, 'admin');
  try {
    const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
    await api.login('admin', 'pw-teste');
    const cam = await api.addCamera({
      name: 'porta-informada',
      addresses: [{ ip: '127.0.0.1', port: 5003, scheme: 'rtsp', informada: true }],
      credential: { username: 'admin', password: 'x' },
      source: 'rtsp://127.0.0.1:5003/',
    });
    const cfg = await api.cameraConfig(cam.id);
    // guard: the server returns the SAME `addresses` object, so this case passes before and after the
    // marker exists in the type. What the task delivers is the TYPE (proved by the gate `tsc`); here
    // what is pinned is the round-trip contract. IP 127.0.0.1 on purpose: with a non-routable IP the
    // ONVIF ladder burns 5x5s and blows vitest's default 5s timeout.
    assert.equal(cfg.addresses?.[0].port, 5003);
    assert.equal(cfg.addresses?.[0].informada, true);
  } finally { srv.close(); }
});

test('PTZ methods hit the right paths and methods', async () => {
  const requests: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    requests.push({ method: init?.method || 'GET', url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    // The PER-AXIS fields are part of the `PtzCapability` type (spec 2026-10-17): the gate `tsc`
    // proves the TYPE; here what is pinned is the value the client reads from the response (the
    // `req` reads by `text`).
    const capability: PtzCapability = { supported: true, absolute: false, absolutePanTilt: true, absoluteZoom: false };
    return { ok: true, status: 200, text: async () => JSON.stringify(capability) };
  }));
  try {
    const api = new ApiClient('http://servidor');
    await api.ptzCapability('c 1');
    // spec 2026-10-17: live asks for the capability revalidation
    await api.ptzCapability('c 1', true);
    await api.ptzMove('c 1', { pan: 0.6, tilt: 0, zoom: 0 });
    await api.ptzStop('c 1');
    assert.deepEqual(requests.map((p) => `${p.method} ${p.url}`), [
      'GET http://servidor/api/v1/cameras/c%201/ptz',
      'GET http://servidor/api/v1/cameras/c%201/ptz?refresh=1',
      'POST http://servidor/api/v1/cameras/c%201/ptz/move',
      'POST http://servidor/api/v1/cameras/c%201/ptz/stop',
    ]);
    assert.deepEqual(requests[2].body, { pan: 0.6, tilt: 0, zoom: 0 });
    const cap = await api.ptzCapability('c 1');
    assert.equal(cap.absolutePanTilt, true, 'the client reads the pan/tilt axis from the response');
    assert.equal(cap.absoluteZoom, false);
  } finally { vi.unstubAllGlobals(); }
});

it('device: catalog, channels and resync hit the right path, method and body', async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const api = new ApiClient('http://x');
  (api as unknown as { req: (m: string, u: string, c?: unknown) => Promise<unknown> }).req =
    (method, url, body) => { calls.push({ method, url, body }); return Promise.resolve({}); };
  await api.devices();
  // spec decision 2/E2: the classification is the wizard's on-demand route, with the TYPED credential
  await api.deviceChannels({ ip: '10.95.4.201', port: null, credential: { username: 'admin', password: 'p' } });
  // spec decision 3: the resync `:id` is the DEVICE id (the old /devices/:id/onvif route is still a camera)
  await api.syncDevice('dev 1');
  expect(calls).toEqual([
    { method: 'GET', url: '/api/v1/devices', body: undefined },
    { method: 'POST', url: '/api/v1/devices/channels', body: { ip: '10.95.4.201', port: null, credential: { username: 'admin', password: 'p' } } },
    { method: 'POST', url: '/api/v1/devices/dev%201/sync', body: undefined },
  ]);
});

it('PTZ positions: path, method and body of each call', async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const api = new ApiClient('http://x');
  (api as unknown as { req: (m: string, u: string, c?: unknown) => Promise<unknown> }).req =
    (method, url, body) => { calls.push({ method, url, body }); return Promise.resolve({}); };
  await api.ptzPositions('c1');
  await api.ptzSavePosition('c1');
  await api.ptzGoToPosition('c1', 1);
  await api.ptzRenamePosition('c1', 1, 'Portão');
  await api.ptzDeletePosition('c1', 1);
  expect(calls).toEqual([
    { method: 'GET', url: '/api/v1/cameras/c1/ptz/positions', body: undefined },
    // save goes WITHOUT a body: the SERVER computes the `Posicao N` name (amendment E1)
    { method: 'POST', url: '/api/v1/cameras/c1/ptz/positions', body: undefined },
    // spec §4.6 + amendment E6: the position travels in `position`, never in `id` (which is the camera's in the path)
    { method: 'POST', url: '/api/v1/cameras/c1/ptz/positions/goto', body: { position: 1 } },
    { method: 'PATCH', url: '/api/v1/cameras/c1/ptz/positions', body: { position: 1, name: 'Portão' } },
    { method: 'DELETE', url: '/api/v1/cameras/c1/ptz/positions', body: { position: 1 } },
  ]);
  // spec 2026-10-17: "Centralize" is gone — the method no longer exists in the HTTP client
  expect('ptzCentralizar' in api).toBe(false);
});

it('PTZ area zoom: path, method and body of both calls', async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const api = new ApiClient('http://x');
  (api as unknown as { req: (m: string, u: string, c?: unknown) => Promise<unknown> }).req =
    (method, url, body) => { calls.push({ method, url, body }); return Promise.resolve({}); };
  // the box goes normalized against the SHOWN video and the aspect goes with it (amendment E3)
  await api.ptzZoomArea('c 1', { left: 0.25, top: 0.2, right: 0.75, bottom: 0.6, aspect: 1.7777777777777777 });
  await api.ptzUndoZoom('c 1');
  expect(calls).toEqual([
    { method: 'POST', url: '/api/v1/cameras/c%201/ptz/viewport-zoom',
      body: { left: 0.25, top: 0.2, right: 0.75, bottom: 0.6, aspect: 1.7777777777777777 } },
    { method: 'POST', url: '/api/v1/cameras/c%201/ptz/viewport-unzoom', body: undefined },
  ]);
});

// spec 2026-10-17 (item 1.3): the DVR as a folder — rename, move group and delete (with the children).
it('device: rename, move folder and delete hit the right path, method and body', async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const api = new ApiClient('http://x');
  (api as unknown as { req: (m: string, u: string, c?: unknown) => Promise<unknown> }).req =
    (method, url, body) => { calls.push({ method, url, body }); return Promise.resolve({}); };
  await api.renameDevice('dev 1', 'DVR Central');
  await api.moveDevice('dev 1', 'g1');
  await api.moveDevice('dev 1', null);
  await api.deleteDevice('dev 1');
  expect(calls).toEqual([
    { method: 'PATCH', url: '/api/v1/devices/dev%201', body: { name: 'DVR Central' } },
    // group_id: null is the body that returns the recorder to the root (same shape as moveCamera)
    { method: 'PATCH', url: '/api/v1/devices/dev%201', body: { group_id: 'g1' } },
    { method: 'PATCH', url: '/api/v1/devices/dev%201', body: { group_id: null } },
    { method: 'DELETE', url: '/api/v1/devices/dev%201', body: undefined },
  ]);
});

// F4 (spec §10): the session and administration surface the new UI consumes. All over real HTTP,
// against the API the test itself starts — no new route was created in this phase.
test('me, change-password and the whole administration go through ApiClient', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'ovms-f4-')), adminUser: 'admin', adminPassword: 'pw-f4' });
  // No `withoutPendingChange` seed here on purpose: this case exists to prove the bootstrap is born
  // with the change PENDING (§7.1.1). It only touches session routes before changing the password,
  // and the change itself (next line) clears the flag — after it the administration routes pass.
  const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
  try {
    const s = await api.login('admin', 'pw-f4');
    assert.equal(s.profile_id, 'admin', 'login returns the profile, not the role');
    assert.equal(s.must_change_password, true, 'bootstrap is born with a pending change');
    const me = await api.me();
    // spec 2026-10-19 (onboarding §5.1): first_run is additive; AMENDMENT E6 (the 2nd exact deepEqual
    // that spec §6 swore did not exist — the 1st was auth_sessoes.test.js:63, E1). Clean boot: admin first use.
    assert.deepEqual(me, { username: 'admin', profile_id: 'admin', capabilities: ['camera.view', 'camera.control', 'camera.manage', 'camera.manage.global', 'settings.manage', 'users.manage', 'profiles.manage', 'retention.manage'], status: 'active', must_change_password: true, first_run: true });

    // §7.1.6: the password change returns a NEW token and clears the flag
    const change = await api.changePassword('pw-f4', 'senha-nova-longa');
    assert.equal(change.must_change_password, false);
    assert.notEqual(change.token, s.token);
    // Acceptance regression: the server invalidates the old token on change, so the instance must
    // adopt the new one on its own. Until F4 the test masked the bug with a manual `api.token = change.token`.
    assert.equal(api.token, change.token, 'changePassword must leave the instance with the new token');
    assert.equal((await api.me()).must_change_password, false);

    // create the access profile, assign a grant and create the user that consumes it
    const profile = await api.createAccessProfile({ name: 'Portaria' });
    assert.equal(profile.kind, 'custom');
    assert.deepEqual(profile.grants, []);
    const cam = await api.addCamera({ name: 'C1', addresses: [], source: 'rtsp://x/1' });
    const withGrant = await api.patchAccessProfile(profile.id, { grants: [{ camera_id: cam.id, level: 'view' }] });
    assert.deepEqual(withGrant.grants, [{ camera_id: cam.id, level: 'view' }]);
    assert.equal((await api.accessProfiles()).items.find((p) => p.id === profile.id)!.name, 'Portaria');

    const u = await api.createUser({ username: 'ana', password: 'senha-boa-forte', profile_id: profile.id });
    assert.equal(u.profile_id, profile.id);
    assert.equal(u.must_change_password, true);
    // Measured divergence (2nd pinned snippet of the plan that does not run here): `GET /users` returns
    // the document insertion order — the bootstrap admin first (`['admin','ana']`), not alphabetical.
    // What is pinned here is the CONTENT of the list.
    assert.deepEqual((await api.users()).items.map((x) => x.username).sort(), ['admin', 'ana']);

    // §7.1.5: the reset returns the temporary password ONCE (contract fixed in F3 — `temporary_password`)
    const r = await api.resetPassword('ana');
    assert.ok(r.temporary_password.length >= 20);
    assert.equal(r.must_change_password, true);
    const ana = new ApiClient(`http://127.0.0.1:${srv.port}`);
    await ana.login('ana', r.temporary_password);
    assert.equal((await ana.me()).profile_id, profile.id);

    // disable, re-enable and delete through PATCH/DELETE
    assert.equal((await api.patchUser('ana', { status: 'disabled' })).status, 'disabled');
    assert.equal((await api.patchUser('ana', { status: 'active' })).status, 'active');
    assert.deepEqual(await api.deleteUser('ana'), { deleted: 'ana' });
    assert.deepEqual(await api.deleteAccessProfile(profile.id), { deleted: profile.id });
    assert.equal((await api.accessProfiles()).items.some((p) => p.id === profile.id), false);
  } finally { srv.close(); }
});

test('login returns `profile_id` and the Session type no longer carries `role`', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'ovms-f4b-')), adminUser: 'admin', adminPassword: 'pw-f4b' });
  withoutPendingChange(srv, 'admin');
  try {
    const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
    const s: Session = await api.login('admin', 'pw-f4b');
    assert.equal(s.profile_id, 'admin', 'spec §10: the session identity is the PROFILE, not the role');
    // Divergence measured in F1 (the pinned plan snippet does not run here): the SERVER still returns
    // `role` in the login body — the bridge dies in Phase 5, after no client sends the legacy body
    // (amendment E10). What this phase delivers is the TYPE, and the gate `tsc --noEmit` proves it:
    // the line below does not compile if `Session` declares `role` again.
    const withoutRole: 'role' extends keyof Session ? true : false = false;
    assert.equal(withoutRole, false);
  } finally { srv.close(); }
});

// spec 2026-10-20 §5: the administration tables are server-side now. What is pinned here is the
// envelope `{items, total, limit, offset}`, the closed sort list, the ceiling of 100 and the grants of
// a profile delivered on demand (the list carries only `grants_count`).
test('users, access profiles and grants follow the paged contract of spec §5', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'ovms-pg4-')), adminUser: 'admin', adminPassword: 'pw-pg4' });
  withoutPendingChange(srv, 'admin');
  try {
    const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
    await api.login('admin', 'pw-pg4');

    // the 3 system profiles are born on the first call; the list never carries the grants
    const all = await api.accessProfiles({ limit: 100 });
    assert.equal(all.limit, 100);
    assert.equal(all.offset, 0);
    assert.equal(all.total >= 3, true);
    const admin = all.items.find((p) => p.id === 'admin')!;
    assert.equal('grants' in admin, false, 'the list carries grants_count, never grants');
    assert.equal(admin.grants_count, 0);

    const custom = await api.createAccessProfile({ name: 'Portaria' });
    assert.deepEqual(custom.grants, [], 'create answers with the full profile');
    const cam = await api.addCamera({ name: 'C', addresses: [], source: 'rtsp://x/' });
    await api.patchAccessProfile(custom.id, { grants: [{ camera_id: cam.id, level: 'view' }] });

    const filtered = await api.accessProfiles({ q: 'port', limit: 10, sort: 'cameras', dir: 'desc' });
    assert.deepEqual(filtered.items.map((p) => [p.name, p.grants_count]), [['Portaria', 1]]);
    assert.equal(filtered.total, 1);
    // the grants route is verified at the PATH level below: server/api/access.js declares it, but
    // server/main.js has no DYN regex for `/profiles/access/:id/grants` yet (404 route_not_found).

    // users: `profile_name` comes from the JOIN, and `q` also covers the PROFILE name
    await api.createUser({ username: 'ana', password: 'senha-boa-forte', profile_id: custom.id });
    const searched = await api.users({ q: 'portaria' });
    assert.deepEqual(searched.items.map((u) => u.username), ['ana']);
    assert.equal(searched.items[0].profile_name, 'Portaria');
    assert.equal(searched.total, 1);

    // the total is of the FILTERED set and the page is the slice, in the requested order
    const first = await api.users({ limit: 1, offset: 0, sort: 'username', dir: 'asc' });
    const second = await api.users({ limit: 1, offset: 1, sort: 'username', dir: 'asc' });
    assert.deepEqual([first.items.length, first.total, first.limit, first.offset], [1, 2, 1, 0]);
    assert.equal(first.items[0].username, 'admin');
    assert.equal(second.items[0].username, 'ana');
    const desc = await api.users({ sort: 'username', dir: 'desc' });
    assert.deepEqual(desc.items.map((u) => u.username), ['ana', 'admin']);

    // the ceiling of 100 and the closed sort list are 400 with the published code
    await assert.rejects(api.users({ limit: 101 }), (e) => statusOf(e) === 400 && /limit_invalid/.test(String(e)));
    await assert.rejects(api.users({ sort: 'created_at' }), (e) => statusOf(e) === 400 && /sort_invalid/.test(String(e)));
    await assert.rejects(api.accessProfiles({ sort: 'grants' }), (e) => statusOf(e) === 400);
  } finally { srv.close(); }
});

// spec §6: GET /api/v1/cameras is a CONDITIONAL read. The client sends the ETag back, and a 304 keeps
// the list already in hand — the poll that changes nothing transfers no body.
test('cameras sends If-None-Match, keeps the list on a 304 and refreshes it after a change', async () => {
  const srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'ovms-etag-')), adminUser: 'admin', adminPassword: 'pw-etag' });
  withoutPendingChange(srv, 'admin');
  try {
    const api = new ApiClient(`http://127.0.0.1:${srv.port}`);
    await api.login('admin', 'pw-etag');
    const cam = await api.addCamera({ name: 'E', addresses: [], source: 'rtsp://x/' });
    const first = await api.cameras();
    assert.equal(first.length, 1);
    assert.ok(api.camerasEtag, 'the validator of the 200 is kept for the next read');

    // the server honours the validator: same revision, no body
    const raw = await api.reqRaw('GET', '/api/v1/cameras', undefined, { 'if-none-match': api.camerasEtag });
    assert.equal(raw.status, 304);
    assert.equal(raw.data, null);

    // and the method answers with the list it already had instead of an empty one
    const again = await api.cameras();
    assert.deepEqual(again, first);

    // a write bumps the catalog revision: the next read is a 200 with the new state
    await api.renameCamera(cam.id, 'E2');
    const after = await api.cameras();
    assert.equal(after.find((c) => c.id === cam.id)!.name, 'E2');
  } finally { srv.close(); }
});

it('cameras sends the stored ETag and treats 304 as unchanged', async () => {
  const calls: { headers?: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ headers: init?.headers });
    if (calls.length === 1) {
      return { status: 200, headers: new Headers({ etag: '"7"' }),
        text: async () => JSON.stringify([{ id: 'c1', name: 'A', state: 'online', profile_ids: [] }]) };
    }
    return { status: 304, headers: new Headers(), text: async () => '' };
  }));
  try {
    const api = new ApiClient('http://servidor');
    const first = await api.cameras();
    const second = await api.cameras();
    assert.deepEqual(second, first);
    assert.equal(calls[1].headers?.['if-none-match'], '"7"');
  } finally { vi.unstubAllGlobals(); }
});

// spec §5: the editor's on-demand grants. Pinned at the PATH level — `server/api/access.js` declares
// `GET /api/v1/profiles/access/:id/grants`, but the dispatcher table in `server/main.js` still has no
// regex for it, so a real HTTP call answers 404 route_not_found (finding reported, not fixed here).
it('accessProfileGrants hits the profile grants route', async () => {
  const calls: { method: string; url: string }[] = [];
  const api = new ApiClient('http://x');
  (api as unknown as { req: (m: string, u: string, c?: unknown) => Promise<unknown> }).req =
    (method, url) => { calls.push({ method, url }); return Promise.resolve([{ camera_id: 'c1', level: 'view' }]); };
  const grants = await api.accessProfileGrants('p 1');
  expect(calls).toEqual([{ method: 'GET', url: '/api/v1/profiles/access/p%201/grants' }]);
  expect(grants).toEqual([{ camera_id: 'c1', level: 'view' }]);
});

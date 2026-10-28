'use strict';
const { withPort } = require('../lib/rtsp');
const { newCamera, addressOf } = require('../lib/cameras');
const { profileChannel, profileChannels, physicalIdOf } = require('../lib/nvr');
const { AppError } = require('../lib/errors');
const iso = () => new Date().toISOString();

// Camera fields the schema keeps in `meta` (spec §3): the child identity and the payload of the sync.
const metaOf = (row) => (row && row.meta) || {};

// The API keeps the flat camera/device shape: `meta` went to a jsonb column, the callers (and the UI)
// still read physical_id/channel/onvif at the top level.
const flat = ({ meta, ...row }) => ({ ...row, ...(meta || {}) });

// Idempotent per (camera_id, name): the unique index on profiles is the last line of defence, so a
// duplicate that slipped past the read (two syncs at once) does not take the whole sync down.
async function createProfile(store, p) {
  try {
    return await store.catalog.profiles.create({ recording_mode: 'continuous', ...p });
  } catch (e) {
    if (e.code !== '23505') throw e;
    return null;
  }
}

// ponytail: the same work serves the manual route (re-sync) and the automatic add; it lives here,
// outside the router, so it is not duplicated. Idempotent by NAME: the 'main' profile the add already
// created is not recreated.
async function syncProfiles(store, deps, id) {
  const cam = await store.catalog.cameras.get(id);
  if (!cam) throw new AppError('camera_not_found');
  // Child of a device: the DEVICE synchronizes, in a single authenticated session for all children
  // (amendment E4). N syncs per child would mean N deviceInformation + N GetProfiles on one box.
  if (cam.device_id) {
    const out = await syncDevice(store, deps, cam.device_id);
    const dev = await store.catalog.devices.get(cam.device_id);
    return {
      device: metaOf(dev).onvif || null,
      profiles: await store.catalog.profiles.listByCamera(id),
      errors: out.errors || [],
    };
  }
  // ponytail: an address only has {ip,port,scheme}; the xaddr is the default ONVIF device_service
  const addrs = (await store.catalog.cameras.addresses(id)).map(addressOf);
  const addr = addrs.find((a) => a.scheme === 'onvif') || addrs[0];
  if (!addr) throw new AppError('camera_onvif_address_required');
  // port the operator gave: it beats the GetStreamUri one (port-forward case)
  const informedPort = addr.informada === true ? addr.port : null;
  // scan ladder: the address may hold the RTSP port (554), where there is no ONVIF HTTP
  const ONVIF_PORTS = [addr.port, 80, 8080, 8899, 8000].filter(Boolean);

  // the store keeps the secret SEALED: it is opened here, right before the ONVIF call (never logged)
  const cred = cam.credential_ref && await deps.openCredential(cam.credential_ref);
  if (!cred) throw new AppError('camera_credentials_required');
  const { username: user, password: pass } = cred;

  let xaddr = null, device = null, lastError = 'no testable port';
  for (const port of ONVIF_PORTS) {
    const u = `http://${addr.ip}:${port}/onvif/device_service`;
    try { device = await deps.onvif.deviceInformation({ xaddr: u, user, pass }); xaddr = u; break; }
    catch (e) {
      lastError = e.message;
      // The CREDENTIAL refusal belongs to the device, not the port (measured: the ladder burns 5
      // attempts per sync with a wrong password and the DVR locks at ~30 — fact 6). Insisting only
      // brings the lockout closer.
      if (e.kind === 'auth') throw new AppError('onvif_unreachable', { reason: e.message });
    }
  }
  if (!xaddr) throw new AppError('onvif_unreachable', { reason: lastError });
  const onvifProfiles = await deps.onvif.profiles({ xaddr, user, pass });
  // ponytail: a profile without a URI does not take the sync down — it goes to errors
  const resolved = [];
  const errors = [];
  for (const p of onvifProfiles) {
    try {
      const source_url = withPort(await deps.onvif.streamUri({ xaddr, user, pass, profileToken: p.token }), informedPort);
      resolved.push({ ...p, source_url });
    } catch (e) {
      errors.push({ token: p.token, error: e.message });
    }
  }

  const onvif = { manufacturer: device.manufacturer, model: device.model, firmware: device.firmware, synced_at: iso() };
  await store.catalog.cameras.update(id, { meta: { ...metaOf(cam), onvif } });

  const known = new Set((await store.catalog.profiles.listByCamera(id)).map((p) => p.name));
  for (const p of resolved) {
    const name = p.name || p.token;
    // ponytail: idempotent — same camera name is not recreated
    if (known.has(name)) continue;
    known.add(name);
    await createProfile(store, {
      camera_id: id, name, source_url: p.source_url,
      // ponytail: resolution comes from the ONVIF profile and feeds the selector label in the UI
      width: p.width ?? null, height: p.height ?? null, onvif_token: p.token,
    });
  }

  return { device: onvif, profiles: await store.catalog.profiles.listByCamera(id), errors };
}

// ---- multi-channel device (spec 2026-10-17, decisions 1 to 3) ----
// ONE authenticated session for the parent and all children. The device profiles are DISTRIBUTED per
// channel (the `channel=N&subtype=M` map of the GetStreamUri URL — measured fact 4); the child is found
// by physicalId, NEVER by name: a resync duplicates nothing and deletes nothing (decision 3).
async function syncDevice(store, deps, deviceId) {
  const dev = await store.catalog.devices.get(deviceId);
  if (!dev) throw new AppError('device_not_found');
  const devMeta = metaOf(dev);
  const addrs = (devMeta.addresses || []).map(addressOf);
  const addr = addrs.find((a) => a.scheme === 'onvif') || addrs[0];
  if (!addr) throw new AppError('device_onvif_address_required');
  const informedPort = addr.informada === true ? addr.port : null;
  const ONVIF_PORTS = [addr.port, 80, 8080, 8899, 8000].filter(Boolean);
  const cred = devMeta.credential_ref && await deps.openCredential(devMeta.credential_ref);
  if (!cred) throw new AppError('device_credentials_required');
  const { username: user, password: pass } = cred;

  let xaddr = null, device = null, lastError = 'no testable port';
  for (const port of ONVIF_PORTS) {
    const u = `http://${addr.ip}:${port}/onvif/device_service`;
    try { device = await deps.onvif.deviceInformation({ xaddr: u, user, pass }); xaddr = u; break; }
    catch (e) {
      lastError = e.message;
      if (e.kind === 'auth') throw new AppError('onvif_unreachable', { reason: e.message });   // amendment E3
    }
  }
  if (!xaddr) throw new AppError('onvif_unreachable', { reason: lastError });

  const onvifProfiles = await deps.onvif.profiles({ xaddr, user, pass });
  const selected = new Set(devMeta.channels || []);
  const resolved = [];
  const errors = [];
  for (const p of onvifProfiles) {
    // pre-filter by NAME (the measured fallback): a channel the operator did not pick pays no GetStreamUri
    const byName = profileChannel({ name: p.name });
    if (selected.size && byName.channel !== null && !selected.has(byName.channel)) continue;
    try {
      const source_url = withPort(await deps.onvif.streamUri({ xaddr, user, pass, profileToken: p.token }), informedPort);
      resolved.push({ ...p, source_url });
    } catch (e) { errors.push({ token: p.token, error: e.message }); }
  }
  const channels = profileChannels(resolved);

  const devOnvif = { manufacturer: device.manufacturer, model: device.model, firmware: device.firmware, xaddr, synced_at: iso() };
  await store.catalog.devices.put({ id: deviceId, name: dev.name, meta: { ...devMeta, onvif: devOnvif } });

  // Children of the device: the list is a tree read, so the meta of each one comes from its own row.
  const children = [];
  for (const row of (await store.catalog.cameras.listCatalog()).filter((c) => c.device_id === deviceId)) {
    children.push(await store.catalog.cameras.get(row.id));
  }

  const created = [];
  for (const c of channels) {
    const pId = physicalIdOf(addr.ip, c.channel);
    let child = children.find((x) => metaOf(x).physical_id === pId);
    const existed = Boolean(child);
    if (!child) {
      // a channel outside the wizard choice does not become a child (the add selection is the contract)
      if (selected.size && !selected.has(c.channel)) continue;
      child = await store.catalog.cameras.create({
        ...newCamera({
          name: `${dev.name} · Channel ${c.channel}`, added_via: 'discovery',
          addresses: addrs, credential_ref: devMeta.credential_ref, device_id: deviceId,
        }),
        meta: { physical_id: pId, channel: c.channel, channel_missing: false },
      });
      children.push(child);
      created.push(child.id);
    }
    // primary (subtype 0) first: the UI and ingest read the order to pick the recording profile
    const current = await store.catalog.profiles.listByCamera(child.id);
    for (const p of [c.primary, c.secondary].filter(Boolean)) {
      const name = p.name || p.token;
      const existing = current.find((x) => x.name === name);
      if (existing) {
        // profile coming from the DEVICE (has onvif_token) is updated; a hand-typed URL stays (file rule)
        if (existing.onvif_token) {
          await store.catalog.profiles.update(existing.id, { source_url: p.source_url, onvif_token: p.token });
        }
        continue;
      }
      const row = await createProfile(store, {
        camera_id: child.id, name, source_url: p.source_url,
        width: p.width ?? null, height: p.height ?? null, onvif_token: p.token,
      });
      if (row) current.push(row);
    }
    // one write per child: channel and channel_missing travel together, so no stale copy wins
    const meta = { ...metaOf(child), channel: c.channel, channel_missing: false };
    if (existed) await store.catalog.cameras.update(child.id, { meta });
    child.meta = meta;   // the row in hand follows the write, so the payload below is not stale
  }
  // A child whose channel vanished from the map is MARKED, never deleted (decision 3): profiles and
  // segments stay where they are, its recording is not lost.
  const present = new Set(channels.map((c) => physicalIdOf(addr.ip, c.channel)));
  for (const f of children) {
    const meta = metaOf(f);
    if (meta.physical_id && !present.has(meta.physical_id)) {
      await store.catalog.cameras.update(f.id, { meta: { ...meta, channel_missing: true } });
      f.meta = { ...meta, channel_missing: true };
    }
  }

  const cameras = [];
  for (const f of children) {
    cameras.push({ ...flat(f), profile_ids: (await store.catalog.profiles.listByCamera(f.id)).map((p) => p.id) });
  }
  return {
    device: flat({ ...dev, meta: { ...devMeta, onvif: devOnvif } }),
    cameras,
    channels: channels.map((c) => c.channel),
    created,
    missing: cameras.filter((c) => c.channel_missing === true).map((c) => c.id),
    errors,
  };
}

// ponytail: routes = path->handler map; the ONVIF lib comes injected in deps.onvif (testable without network)
function onvifRoutes(store, deps) {
  return {
    'POST /api/v1/devices/:id/onvif': async ({ id } = {}) => syncProfiles(store, deps, id),
    // Device resync (spec decision 3): one session for the parent and all children. `:id` is the
    // DEVICE id, not a camera (the old `/devices/:id/onvif` route is still a camera id).
    'POST /api/v1/devices/:id/sync': async ({ id } = {}) => syncDevice(store, deps, id),
  };
}

module.exports = { onvifRoutes, syncProfiles, syncDevice };

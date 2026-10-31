'use strict';
const crypto = require('node:crypto');
const { newCamera, addressOf } = require('../lib/cameras');
const { syncProfiles, syncDevice } = require('./onvif');
const { verifyCamera, probeChannel, probeRtspAuth } = require('../lib/camera-gate');
const { classifySources, profileChannels, physicalIdOf, newDevice } = require('../lib/nvr');
const { urlForBrand, isPlaceholder, withoutUser, isKnownBrand, brandByName, listBrands, withPort } = require('../lib/rtsp');
const { cameraRoles } = require('../lib/roles');
const { AppError } = require('../lib/errors');
const iso = () => new Date().toISOString();

// `meta` is a jsonb column (spec §3): the API and the UI still read its keys at the top level.
const metaOf = (row) => (row && row.meta) || {};
const flat = ({ meta, ...row }) => ({ ...row, ...(meta || {}) });
// Every device field the table does not have (kind, addresses, credential_ref, channels, onvif) lives in meta.
const deviceMeta = ({ id, name, created_at, ...meta }) => meta;

// Legacy profile order: 'main' first (it is what ingest records), the rest by name.
const profileOrder = (a, b) => (a.name === 'main' ? 0 : 1) - (b.name === 'main' ? 0 : 1) ||
  String(a.name).localeCompare(String(b.name));

// The candidates table keys by uuid: a NAME-BASED id derived from ip|port keeps the legacy "one row per
// host and port" identity, so a rescan updates the same row instead of inserting a second one.
function candidateId(ip, port) {
  const h = crypto.createHash('sha1').update(`${ip}|${port}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const candidateRow = (c) => ({
  id: c.id, scan_id: c.scan_id, ip: c.ip, xaddr: c.xaddr, name: c.name, manufacturer: c.manufacturer,
  model: c.model, status: c.status, outcome: c.outcome, seen_count: c.seen_count,
  open_ports: c.openPorts, first_seen_at: c.first_seen_at, last_seen_at: c.last_seen_at,
  ...(c.videoSources !== undefined ? { video_sources: c.videoSources } : {}),
});
// `video_sources`/`open_ports` are the column names; the wizard reads videoSources/openPorts.
const candidateOut = (row) => {
  const { video_sources, open_ports, ...rest } = row;
  return { ...rest, openPorts: open_ports,
    ...(video_sources !== undefined && video_sources !== null ? { videoSources: video_sources } : {}) };
};

// spec §6: the 304 of a conditional read is a successful answer, not an error — the registry holds 4xx/5xx
// only, and the thrown AppError is the one channel the router gives a non-200 status today.
const notModified = () => Object.assign(new AppError('not_modified'), { status: 304, message: 'Not modified' });

// ponytail: pure handlers (JSON in/out); the HTTP router is mounted in main
function deviceRoutes(store, deps) {
  const cat = store.catalog;
  const ops = store.ops;

  const profilesOf = async (id) => (await cat.profiles.listByCamera(id)).sort(profileOrder);

  // The API/UI camera shape: the columns, the meta keys flattened back to the top level, the addresses in
  // array order and the profile ids in the legacy order. `profile_ids` is DERIVED now: profiles.camera_id
  // owns the relation (spec §3).
  const cameraOut = async (row) => {
    const list = await profilesOf(row.id);
    // spec 2026-10-27: the `ativa` flag lives in meta; absent = active — strict false is the only inactive form
    return { ...flat(row), ativa: (row.meta && row.meta.ativa) !== false,
      addresses: (await cat.cameras.addresses(row.id)).map(addressOf),
      profile_ids: list.map((p) => p.id) };
  };

  const childrenOf = async (deviceId) => {
    const ids = (await cat.cameras.listCatalog()).filter((c) => c.device_id === deviceId).map((c) => c.id);
    const out = [];
    for (const id of ids) out.push(await cameraOut(await cat.cameras.get(id)));
    return out.sort((a, b) => (a.channel ?? 0) - (b.channel ?? 0));
  };

  // A credential is shared by a DVR and its children (amendment E7): whoever leaves LAST removes it.
  const dropCredentialIfUnused = async (ref) => {
    if (ref && !(await cat.credentials.inUse(ref))) await cat.credentials.remove(ref);
  };

  // ponytail: the scan runs in the background; the wizard follows it through GET /discovery/scans/:id
  // GATE (spec 2026-10-16): only a host that PROVED it is a camera becomes a candidate — an ONVIF reply
  // with manufacturer/model, an authorization Fault (it spoke SOAP and refused the credential) or an RTSP
  // OPTIONS. An open TCP port is not enough: that is what filled the table with printers, routers and NAS.
  const GATE_WORKERS = 32;
  const GATE_TIMEOUT = 1500;
  // With a credential the gate makes ONE authenticated call per host; 32 parallel workers could burn 32
  // attempts at once and the DVR locks at ~30 (fact 6). 4 workers + a cut at 5 refusals leave the worst
  // case at 5 + (4-1) = 8 attempts (amendment E10). Without a credential none of this runs.
  const CREDENTIAL_WORKERS = 4;
  const CREDENTIAL_FAILURE_LIMIT = 5;
  // Light classification (spec decision 2): ONE GetVideoSources call after the authenticated
  // deviceInformation. Enumerating the channels (GetProfiles + N GetStreamUri + N OPTIONS) does NOT happen
  // here — it is on demand in the /devices/channels route (amendment E2).
  const classify = async (seen, credential) => {
    if (!seen || seen.status !== 'verified' || !seen.xaddr) return seen;
    if (!credential || !credential.username || !credential.password) return seen;
    try {
      const sources = await deps.onvif.videoSources({
        xaddr: seen.xaddr, user: credential.username, pass: credential.password, timeoutMs: GATE_TIMEOUT * 2,
      });
      return { ...seen, videoSources: sources.length };
    } catch { return seen; }   // without multi-channel proof the candidate enters as today
  };
  // The password NEVER leaves here into the database; a host that fails the gate never becomes a candidate.
  const verifyHosts = async (hosts, credential) => {
    const seen = new Map();
    const withCredentials = !!(credential && credential.username && credential.password);
    let next = 0;
    let failures = 0;
    const worker = async () => {
      while (next < hosts.length && failures < CREDENTIAL_FAILURE_LIMIT) {
        const h = hosts[next++];
        const v = await classify(await verifyCamera({
          host: h, credential, onvif: deps.onvif, rtspProbe: deps.rtspProbe,
          rtspAuthProbe: deps.rtspAuthProbe, timeoutMs: GATE_TIMEOUT,
        }), credential);
        if (v.status === 'invalid_credential') failures += 1;
        seen.set(h.ip, v);
      }
    };
    const n = Math.min(withCredentials ? CREDENTIAL_WORKERS : GATE_WORKERS, hosts.length);
    await Promise.all(Array.from({ length: n }, worker));
    return { seen, failures };
  };
  const runScan = async (id, kind, scope, credential) => {
    try {
      const hosts = kind === 'wsdd'
        ? await deps.wsddDiscover({})
        // ponytail: the client port wins; with no port asked the KEY is absent, so main injects the default list
        : await deps.scanRange({ ips: scope?.ips ?? [], ...(scope?.ports ? { ports: scope.ports } : {}) });
      if (scope && scope.source) {
        try {
          const su = new URL(scope.source);
          for (const h of hosts) if (h.ip === su.hostname) h.source = scope.source;
        } catch { /* fonte malformada j foi barrada no handler; dupla protecao: segue na raiz */ }
      }
      const { seen, failures } = await verifyHosts(hosts, credential);
      // wsdd: the ProbeMatch already proved the protocol (the device answered an ONVIF Probe), so a host
      // that answered the probe is a camera even with the ONVIF HTTP blocked along the way
      if (kind === 'wsdd') {
        for (const h of hosts) {
          const v = seen.get(h.ip);
          if (!v || v.status === 'none') {
            seen.set(h.ip, { status: 'verified', xaddr: h.xaddr ?? null, manufacturer: null, model: h.model ?? null });
          }
        }
      }
      // Dedup by id: already seen => seen_count++ and the candidate belongs to the current scan (only
      // scan_id advances; "added" is derived from the cameras on read, not stamped here). The status belongs
      // to the CURRENT scan (the gate re-evaluates every scan); manufacturer/model/xaddr/videoSources stay
      // when the new scan does not bring them, so a rescan without credentials cannot wipe discovery.
      const known = new Map((await ops.candidates.list()).map((c) => [c.id, c]));
      let found = 0;
      for (const h of hosts) {
        const v = seen.get(h.ip);
        if (!v || v.status === 'none') continue; // an open port is not a camera
        found += 1;
        const port = (h.openPorts || [])[0] || 80;
        const cand = {
          id: candidateId(h.ip, port), ip: h.ip, openPorts: h.openPorts || [],
          xaddr: v.xaddr ?? h.xaddr ?? null, name: h.name ?? null,
          manufacturer: v.manufacturer ?? null, model: v.model || h.model || null,
          status: v.status, scan_id: id, outcome: 'pending', first_seen_at: iso(), last_seen_at: iso(),
          // only exists when the gate proved multi-channel; without a credential the field does not appear
          ...(v.videoSources !== undefined ? { videoSources: v.videoSources } : {}),
        };
        const prev = known.get(cand.id);
        const merged = prev ? {
          ...prev, scan_id: cand.scan_id, seen_count: (prev.seen_count || 1) + 1,
          manufacturer: cand.manufacturer || prev.manufacturer,
          model: cand.model || prev.model,
          xaddr: cand.xaddr || prev.xaddr,
          videoSources: cand.videoSources !== undefined ? cand.videoSources : prev.videoSources,
          status: cand.status, last_seen_at: cand.last_seen_at,
        } : { ...cand, seen_count: 1 };
        await ops.candidates.put(candidateRow(merged));
        known.set(cand.id, merged);
      }
      // the credential cut (amendment E10): the scan ends in ERROR so the wizard shows the reason and the
      // operator does not burn the device counter
      await ops.scans.put(failures >= CREDENTIAL_FAILURE_LIMIT
        ? { id, state: 'error', found, finished_ts: iso(),
            error: `credential refused ${failures} times — scan stopped (the recorder locks after about 30 failures)` }
        : { id, state: 'done', found, finished_ts: iso() });
    } catch (e) {
      const scan = await ops.scans.get(id);
      if (scan) await ops.scans.put({ id, state: 'error', error: e.message, finished_ts: iso() });
    }
  };
  // ponytail: a single path writes a profile; POST /devices and the profile POSTs both just call it
  const newProfile = (camId, { name, source, recording_mode = 'continuous' }) =>
    cat.profiles.create({ camera_id: camId, name, source_url: source, recording_mode });

  // One POST creates the PARENT device + 1 camera per chosen channel, and syncs ONCE (amendments E4/E5).
  // The credential is sealed once and SHARED with the children (amendment E7): it is what ingest/live
  // inject into each channel's RTSP.
  const addDvr = async (body, addrs, channels) => {
    const ip = (addrs[0] || {}).ip || null;
    if (!ip) throw new AppError('device_address_required');
    const credential_ref = body.credential ? 'cred:' + crypto.randomUUID() : null;
    if (credential_ref) {
      await cat.credentials.put(credential_ref, {
        username: body.credential.username,
        secret: deps.credentials.seal(body.credential.password),
      });
    }
    const dev = newDevice({ name: body.name, addresses: addrs, credential_ref, channels });
    await cat.devices.put({ id: dev.id, name: dev.name, meta: deviceMeta(dev) });
    // the child is born WITHOUT a profile: whoever creates the channel profiles is the device sync (E5)
    for (const channel of channels) {
      await cat.cameras.create({
        ...newCamera({
          name: `${body.name} · Channel ${channel}`, added_via: body.added_via || 'manual',
          addresses: addrs, credential_ref, device_id: dev.id,
        }),
        meta: { channel, physical_id: physicalIdOf(ip, channel) },
      });
    }
    // sync BEFORE returning (same shape as the single-camera path): a failure here does NOT take the add
    // down — the reason comes back in onvif_error and the resync fixes it
    let onvif = null, onvif_error = null;
    try { onvif = await syncDevice(store, deps, dev.id); } catch (e) { onvif_error = e.message; }
    return {
      device: flat(await cat.devices.get(dev.id)),
      cameras: await childrenOf(dev.id),
      onvif, onvif_error,
    };
  };
  // PURE database read (spec inform-manufacturer-camera): no live ONVIF, no recording.
  // Manufacturer precedence: persisted onvif > manual > null. RTSP: authoritative profile source > manual
  // URL > brand table (only when the brand is known).
  const configReadOnly = async ({ id } = {}) => {
    const row = await cat.cameras.get(id);
    if (!row) throw new AppError('camera_not_found');
    const cam = flat(row);
    const addrs = (await cat.cameras.addresses(id)).map(addressOf);
    const ip = (addrs[0] || {}).ip || null;
    const onvif = cam.onvif || null;
    const manual = cam.manual || null;
    const brand = { manufacturer: (onvif && onvif.manufacturer) || (manual && manual.manufacturer) || '',
                    model: (onvif && onvif.model) || '' };
    const urls = ip ? urlForBrand({ manufacturer: brand.manufacturer, model: brand.model, ip,
      port: addrs[0] && addrs[0].informada ? addrs[0].port : null })
                    : { primary: null, secondary: null };
    const sources = (await profilesOf(id)).filter((p) => p.source_url);
    // Spec 2026-10-27: the mode belongs to the CAMERA (meta), never to a profile — the recorder
    // picks the WIDEST profile to write, the UI used to pick 'main': two answers to one question.
    const recordingMode = cam.recording_mode === 'motion' ? 'motion' : 'continuous';
    const authorized = sources.filter((p) => p.onvif_token || !isPlaceholder(p.source_url));
    return {
      id: cam.id, name: cam.name, state: cam.state, group_id: cam.group_id ?? null,
      recording: cam.recording === true,
      recording_mode: recordingMode,
      motion_sensitivity: Number.isInteger(cam.motion_sensitivity) ? cam.motion_sensitivity : 5,
      // spec 2026-10-19: `retention_days` left the camera (retention is global). The flag comes from the
      // disk gate in main — the UI uses it to disable the switch with the warning.
      recording_blocked: !!(deps.recordingBlocked && deps.recordingBlocked()),
      // spec 2026-10-19: the modal shows the configured FOV; null = camera without real FOV (linear fallback)
      fov_min_grau: cam.fov_min_grau ?? null,
      fov_max_grau: cam.fov_max_grau ?? null,
      addresses: addrs,
      manufacturer: brand.manufacturer || null,
      manufacturer_source: onvif && onvif.manufacturer ? 'onvif' : manual ? 'manual' : null,
      synced_at: (onvif && onvif.synced_at) || null,
      onvif, manual,
      rtsp: {
        primary: withoutUser((authorized[0] || {}).source_url || (manual && manual.rtsp_primary)
          || (isKnownBrand(brand) ? urls.primary : null) || null),
        secondary: withoutUser((authorized[1] || {}).source_url || (manual && manual.rtsp_secondary)
          || (isKnownBrand(brand) ? urls.secondary : null) || null),
      },
      profiles: sources.map((p) => ({ name: p.name, source_url: p.source_url,
        width: p.width ?? null, height: p.height ?? null })),
    };
  };

  // ponytail: deleting takes profiles and credential; the SEGMENTS stay — retention works on the segment
  // records, so deleting them would orphan the files (whoever stops the ingest/live workers is main, which
  // holds both instances).
  // It lives in its own const because the DEVICE DELETE (item 1.3g) reuses THIS path per child: a second
  // cleanup path would leave profiles and credential behind.
  const deleteCamera = async ({ id } = {}) => {
    const cam = await cat.cameras.get(id);
    if (!cam) throw new AppError('camera_not_found');
    const ref = cam.credential_ref;
    // profiles, addresses and grants go with the camera (ON DELETE CASCADE): the credential only leaves
    // once nobody else uses it — a DVR child must not take the parent's credential down (amendment E7)
    await cat.cameras.remove(id);
    await dropCredentialIfUnused(ref);
    return { deleted: id };
  };
  return {
    'POST /api/v1/discovery/scan': async ({ kind = 'scan', scope, credential } = {}) => {
      // ponytail: validate the range here (immediate 400) before firing the async scan
      if (kind !== 'wsdd' && deps.expandIps) deps.expandIps(scope?.ips ?? []);
      const id = crypto.randomUUID();
      const started_ts = iso();
      const sc = scope || null;
      // 2026-10-30: source so entra se for URL rtsp simples; lixo vira "sem source" (raiz, como hoje)
      if (sc && typeof sc.source === 'string' && !/^rtsp:\/\/[^\s]{1,500}$/i.test(sc.source)) delete sc.source;
      await ops.scans.put({ id, kind, state: 'running', scope: sc, started_ts });
      runScan(id, kind, sc, credential); // fire-and-forget: answers without waiting for the scan to end
      return { scan_id: id, state: 'running', scope: sc, started_ts };
    },

    'GET /api/v1/discovery/scans/:id': async ({ id } = {}) => {
      const scan = await ops.scans.get(id);
      if (!scan) throw new AppError('scan_not_found');
      return scan;
    },

    // ponytail: "already added" is a FACT derived from the cameras, not a stamp from the add moment — a
    // candidate created later (same IP, another port, "Known address" tab) was born 'pending' and showed up
    // as new, letting the same device be registered twice
    'GET /api/v1/discovery/results': async () => {
      const ips = new Set((await cat.cameras.allAddresses()).map((a) => addressOf(a.address).ip));
      return (await ops.candidates.list())
        .filter((c) => c.outcome !== 'ignored')
        .map((c) => candidateOut(ips.has(c.ip) ? { ...c, outcome: 'added' } : c));
    },

    // Enumerate the channels of ONE candidate for the wizard (spec decision 2/4). On demand on purpose: the
    // scan does not pay 50 GetStreamUri per host (amendment E2). The GetVideoSources count is the detector;
    // the list comes from the channel=N&subtype=M map of the URL (fact 4) and each channel gets the OPTIONS
    // probe that decides "channel without stream" (fact 5).
    'POST /api/v1/devices/channels': async ({ ip, port, credential } = {}) => {
      if (!ip) throw new AppError('ip_required');
      const user = credential && credential.username;
      const pass = credential && credential.password;
      if (!user || !pass) throw new AppError('classify_credentials_required');
      const givenPort = Number(port) || null;
      const PORTS = [...new Set([givenPort, 80, 8080, 8899, 8000].filter(Boolean))];
      let xaddr = null, lastError = 'no testable port';
      for (const p of PORTS) {
        const u = `http://${ip}:${p}/onvif/device_service`;
        try { await deps.onvif.deviceInformation({ xaddr: u, user, pass, timeoutMs: 5000 }); xaddr = u; break; }
        catch (e) {
          lastError = e.message;
          // the refusal belongs to the DEVICE, not the port: insisting only burns the counter (amendment E3)
          if (e.kind === 'auth') throw new AppError('onvif_unreachable', { reason: e.message });
        }
      }
      if (!xaddr) throw new AppError('onvif_unreachable', { reason: lastError });
      const sources = await deps.onvif.videoSources({ xaddr, user, pass });
      const profiles = await deps.onvif.profiles({ xaddr, user, pass });
      const resolved = [];
      for (const p of profiles) {
        try {
          resolved.push({ ...p, source_url: withPort(await deps.onvif.streamUri({ xaddr, user, pass, profileToken: p.token }), givenPort) });
        } catch { /* a profile without a URI stays out of the map */ }
      }
      const probe = deps.rtspCanalProbe || probeChannel;
      const channels = [];
      for (const c of profileChannels(resolved)) {
        const url = (c.primary || c.secondary).source_url;
        // ponytail: `probeChannel answers its `reason`
        const r = await probe(url).catch(() => ({ stream: false, reason: 'error' }));
        channels.push({ channel: c.channel, has_stream: r.stream === true, reason: r.reason || null });
      }
      // the channel list does not leave without a validated credential: without it the wizard offers no checkbox
      return { multichannel: classifySources(sources) === 'nvr', sources: sources.length, channels };
    },

    'POST /api/v1/devices': async (body = {}) => {
      if (!body.name) throw new AppError('name_required');
      const addrs = body.addresses || [];
      // `channels` in the body = MULTI-CHANNEL add (spec decisions 1 and 4): the wizard sends the operator's
      // choice. Without `channels` nothing changes — it is the single-camera path as always.
      const channels = Array.isArray(body.channels)
        ? [...new Set(body.channels.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
        : [];
      if (channels.length) return addDvr(body, addrs, channels);
      const extras = body.profiles || [];
      // ponytail: validate the extras before writing; unique name on the camera (main included)
      const names = new Set(['main']);
      for (const p of extras) {
        if (!p.name) throw new AppError('stream_profile_name_required');
        if (!p.source) throw new AppError('stream_profile_source_required');
        if (names.has(p.name)) throw new AppError('stream_profile_name_taken');
        names.add(p.name);
      }
      // Gate de credencial no momento do add (bug medido 2026-10-30): a varredura sonda a RAIZ do
      // RTSP — um servidor por caminho (mediamtx) responde lá igual com senha certa ou errada.
      // Aqui o wizard já trouxe a URL do canal (body.source): o DESCRIBE autenticado decide.
      // 'unknown' não pune, a mesma regra do gate do scan. Antes de qualquer escrita.
      const cred = body.credential;
      const source0 = body.source || (addrs[0] ? `rtsp://${addrs[0].ip}:${Number(addrs[0].port) || 554}/` : null);
      if (cred && cred.username && cred.password && source0 && /^rtsp:\/\//i.test(source0)) {
        const u = new URL(source0);
        const r = await (deps.rtspAuthProbe || probeRtspAuth)(
          u.hostname, Number(u.port) || 554, cred.username, cred.password, 5000, source0);
        if (r === 'refused') throw new AppError('invalid_credentials');
      }
      const credential_ref = body.credential ? 'cred:' + crypto.randomUUID() : null;
      if (credential_ref) {
        // ponytail: the password only enters sealed; never persisted in clear
        await cat.credentials.put(credential_ref, {
          username: body.credential.username,
          secret: deps.credentials.seal(body.credential.password),
        });
      }
      const cam = newCamera({
        name: body.name, added_via: body.added_via || 'manual',
        addresses: addrs, credential_ref,
        // spec 2026-10-27: body.recording_mode seeds the CAMERA meta (what the recorder and the UI
        // read); the per-profile column keeps being written below but nobody reads it anymore.
        meta: body.recording_mode === 'motion' ? { recording_mode: 'motion' } : {},
      });
      await cat.cameras.create(cam);
      // 'main' is born from the same source as before; extras enter in order through the same helper
      await newProfile(cam.id, {
        name: 'main',
        source: body.source || (addrs[0] ? `rtsp://${addrs[0].ip}:${Number(addrs[0].port) || 554}/` : null),
        recording_mode: body.recording_mode ?? 'continuous',
      });
      for (const p of extras) {
        await newProfile(cam.id, { name: p.name, source: p.source,
          recording_mode: p.recording_mode || body.recording_mode });
      }
      // ponytail: like NX, the add already discovers the ONVIF profiles — but a failure here does NOT take
      // the add down: a camera that does not speak ONVIF (or has a wrong credential, or is offline) is still
      // added, with the reason in onvif_error for the modal to show. The sync happens BEFORE returning on
      // purpose: the returned profile_ids already include the discovered profiles, and main.js starts ingest
      // and live from it.
      let onvif = null;
      let onvif_error = null;
      try {
        onvif = await syncProfiles(store, deps, cam.id);
      } catch (e) {
        onvif_error = e.message;
      }
      // placeholder repair: the wizard source is a port guess; with the device identified, profiles without
      // an ONVIF token get the brand canonical URL. A profile with onvif_token came from GetStreamUri and is
      // authoritative — it is not touched.
      if (onvif && onvif.device) {
        const addrsOf = (await cat.cameras.addresses(cam.id)).map(addressOf);
        const ip = (addrsOf[0] || {}).ip;
        if (ip) {
          const urls = urlForBrand({
            manufacturer: onvif.device.manufacturer || '', model: onvif.device.model || '', ip,
            port: addrsOf[0] && addrsOf[0].informada ? addrsOf[0].port : null });
          let n = 0;
          for (const p of await profilesOf(cam.id)) {
            if (!p.onvif_token && isPlaceholder(p.source_url)) {
              const nextUrl = n === 0 ? urls.primary : urls.secondary;
              if (nextUrl) await cat.profiles.update(p.id, { source_url: nextUrl });
            }
            n += 1;
          }
        }
      }
      return { ...(await cameraOut(await cat.cameras.get(cam.id))), onvif, onvif_error };
    },

    // the sidebar tree needs the PARENTS (spec decision 5): the child already comes in GET /cameras with device_id
    'GET /api/v1/devices': async () => (await cat.devices.list()).map(flat),

    // spec 2026-10-16: the playback page needs the profile that RECORDS (the primary by width), which is not
    // necessarily the first of profile_ids.
    // spec §6: the response carries only the fields the tree uses, and the ETag of the catalog turns a
    // repeated read into a 304. The headers arrive in `input.headers`; `deps.catalogRev` lets main read the
    // revision once per request (the repository read is the fallback).
    'GET /api/v1/cameras': async (input = {}) => {
      const rev = String(await (deps.catalogRev ? deps.catalogRev() : cat.catalogRev()));
      const inm = input.headers && input.headers['if-none-match'];
      // `W/` and the quotes are not part of the revision: a weak validator answers the same
      if (inm && String(inm).replace(/W\/|"/g, '') === rev) throw notModified();
      const perCamera = new Map();
      for (const p of await cat.profiles.listAll()) {
        if (!perCamera.has(p.camera_id)) perCamera.set(p.camera_id, []);
        perCamera.get(p.camera_id).push(p);
      }
      return (await cat.cameras.listCatalog()).map((cam) => {
        const list = perCamera.get(cam.id) || [];
        const { primary } = cameraRoles({ profile_ids: list.map((p) => p.id) },
          Object.fromEntries(list.map((p) => [p.id, p])));
        // spec 2026-10-27: same flattening as cameraOut — only strict false is inactive; the meta
        // column itself never crosses to the client (the tree carries it only to feed this line).
        const { meta, ...rest } = cam;
        return { ...rest, ativa: (meta && meta.ativa) !== false, recording_profile_id: primary ? primary.id : null };
      });
    },

    'GET /api/v1/cameras/:id/config': configReadOnly,

    // live ONVIF panel on demand ("Report manufacturer" CTA): success stores cam.meta.onvif and repairs the
    // placeholder; failure returns 200 + a short onvif_error and the client opens the manual choice.
    'POST /api/v1/cameras/:id/onvif-refresh': async ({ id, probe } = {}) => {
      const row = await cat.cameras.get(id);
      if (!row) throw new AppError('camera_not_found');
      const cam = flat(row);
      const addrs = (await cat.cameras.addresses(id)).map(addressOf);
      const failure = async (reason) => ({ ...(await configReadOnly({ id })), onvif_error: String(reason).slice(0, 160) });
      const cred = cam.credential_ref && deps.openCredential && await deps.openCredential(cam.credential_ref);
      if (!cred) return failure('no saved credential');
      const addr = addrs.find((a) => a.scheme === 'onvif') || addrs[0];
      if (!addr || !addr.ip) return failure('camera without address');
      const ports = [...new Set([addr.port, 80, 8080, 8899, 8000].filter(Boolean))];
      try {
        let xaddr = null, dev = null, lastError = 'no testable port';
        for (const p of ports) {
          const u = `http://${addr.ip}:${p}/onvif/device_service`;
          try { dev = await deps.onvif.deviceInformation({ xaddr: u, user: cred.username, pass: cred.password, timeoutMs: 3000 }); xaddr = u; break; }
          catch (e) { lastError = e.message; }
        }
        if (!xaddr) throw new Error(lastError);
        // GetProfiles is not called: the refresh persists what the modal needs; authoritative ONVIF profiles
        // were already written by the add/sync
        const net = await deps.onvif.networkInterfaces({ xaddr, user: cred.username, pass: cred.password, timeoutMs: 3000 }).catch(() => null);
        // probe:true (spec 2026-10-26 (save button)): same live read, NOTHING written. The settings modal
        // shows this payload as the pending manufacturer; only a later refresh without probe persists.
        if (probe) {
          const cfg = await configReadOnly({ id });
          const live = { ...(cfg.onvif || {}), manufacturer: dev.manufacturer ?? null, model: dev.model ?? null,
            firmware: dev.firmware ?? null, mac: net ? net.mac ?? null : null, endpoint: xaddr, synced_at: iso() };
          return { ...cfg, onvif: live, synced_at: live.synced_at,
            manufacturer: dev.manufacturer || cfg.manufacturer,
            manufacturer_source: dev.manufacturer ? 'onvif' : cfg.manufacturer_source,
            onvif_error: null };
        }
        const meta = metaOf(row);
        await cat.cameras.update(id, { meta: { ...meta,
          onvif: {
            ...(meta.onvif || {}),
            manufacturer: dev.manufacturer ?? null, model: dev.model ?? null, firmware: dev.firmware ?? null,
            mac: net ? net.mac ?? null : null, endpoint: xaddr, synced_at: iso(),
          } } });
        // placeholder repair (same rule as the add): no ONVIF token + placeholder = canonical URL
        const urls = urlForBrand({ manufacturer: dev.manufacturer || '', model: dev.model || '', ip: addr.ip });
        let n = 0;
        for (const p of await profilesOf(id)) {
          if (!p.onvif_token && isPlaceholder(p.source_url)) {
            const nextUrl = n === 0 ? urls.primary : urls.secondary;
            if (nextUrl) await cat.profiles.update(p.id, { source_url: nextUrl });
          }
          n += 1;
        }
        return { ...(await configReadOnly({ id })), onvif_error: null };
      } catch (e) {
        return failure(e && e.message);
      }
    },

    // manual manufacturer choice: persists cam.meta.manual and writes the table URLs into the profiles WITHOUT
    // an ONVIF token (GetStreamUri stays authoritative). It overwrites even a non-placeholder source: fixing a
    // wrong brand is exactly the use case.
    'POST /api/v1/cameras/:id/manufacturer': async ({ id, name } = {}) => {
      const row = await cat.cameras.get(id);
      if (!row) throw new AppError('camera_not_found');
      const addrs = (await cat.cameras.addresses(id)).map(addressOf);
      const brandRow = brandByName(name);
      if (!brandRow) throw new AppError('manufacturer_unknown');
      const ip = (addrs[0] || {}).ip;
      if (!ip) throw new AppError('camera_address_required');
      const urls = urlForBrand({ manufacturer: brandRow.name, model: '', ip,
        port: addrs[0] && addrs[0].informada ? addrs[0].port : null });
      await cat.cameras.update(id, { meta: { ...metaOf(row),
        manual: { manufacturer: brandRow.name, rtsp_primary: urls.primary,
          rtsp_secondary: urls.secondary, reported_at: iso() } } });
      let n = 0;
      for (const p of await profilesOf(id)) {
        if (p.onvif_token) continue;
        const nextUrl = n === 0 ? urls.primary : urls.secondary;
        // preserves the user:pass of a hand-typed URL; the sealed credential is injected only at use time
        const userinfo = /^rtsp:\/\/([^@/\s]+@)/i.exec(p.source_url || '');
        if (nextUrl && p.source_url) {
          await cat.profiles.update(p.id, {
            source_url: userinfo ? nextUrl.replace(/^rtsp:\/\//, `rtsp://${userinfo[1]}`) : nextUrl });
        }
        n += 1;
      }
      return configReadOnly({ id });
    },

    // canonical display names for the combobox — a new row in BRANDS = a new brand here
    'GET /api/v1/camera-brands': async () => listBrands(),

    // ponytail: renaming, moving folder and configuring recording are the same PATCH; group_id null = root
    'PATCH /api/v1/cameras/:id': async ({ id, name, group_id, recording, retention_days,
                                          fov_min_grau, fov_max_grau,
                                          recording_mode, motion_sensitivity, ativa } = {}) => {
      const row = await cat.cameras.get(id);
      if (!row) throw new AppError('camera_not_found');
      const cam = flat(row);
      if (name !== undefined && !name) throw new AppError('name_required');
      if (group_id !== undefined && group_id !== null && !(await cat.groups.get(group_id))) {
        throw new AppError('group_not_found');
      }
      if (recording !== undefined && typeof recording !== 'boolean') {
        throw new AppError('recording_flag_invalid');
      }
      // spec 2026-10-27: the on/off flag is a strict boolean too — same code as the recording flag
      if (ativa !== undefined && typeof ativa !== 'boolean') throw new AppError('recording_flag_invalid');
      // Spec 2026-10-23: the mode lives in the profile that records, the sensitivity in `meta`.
      if (recording_mode !== undefined && recording_mode !== 'continuous' && recording_mode !== 'motion') {
        throw new AppError('field_invalid', { field: 'recording_mode' });
      }
      if (motion_sensitivity !== undefined &&
          (!Number.isInteger(motion_sensitivity) || motion_sensitivity < 1 || motion_sensitivity > 9)) {
        throw new AppError('field_invalid', { field: 'motion_sensitivity' });
      }
      // spec 2026-10-19: retention is global (PATCH /api/v1/settings). Accepting and ignoring would leave
      // the API ambiguous — the field is now an explicit error.
      if (retention_days !== undefined) {
        throw new AppError('retention_days_removed');
      }
      // spec 2026-10-19 (Nx parity): real FOV at both ends of the zoom course; null clears it and the
      // viewport-zoom goes back to the linear path.
      for (const [field, v] of [['fov_min_grau', fov_min_grau], ['fov_max_grau', fov_max_grau]]) {
        if (v === undefined || v === null) continue;
        if (!Number.isFinite(v) || v <= 0 || v >= 180) throw new AppError('field_invalid', { field });
      }
      const vmin = fov_min_grau === undefined ? cam.fov_min_grau : fov_min_grau;
      const vmax = fov_max_grau === undefined ? cam.fov_max_grau : fov_max_grau;
      if (vmin != null && vmax != null && !(vmin < vmax)) {
        throw new AppError('fov_order_invalid');
      }
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (group_id !== undefined) patch.group_id = group_id;
      if (recording !== undefined) patch.recording = recording;
      // the FOV lives in `meta` (the table has no column for it): one write carries the merged object
      if (fov_min_grau !== undefined || fov_max_grau !== undefined) {
        const meta = { ...metaOf(row) };
        if (fov_min_grau !== undefined) meta.fov_min_grau = fov_min_grau;
        if (fov_max_grau !== undefined) meta.fov_max_grau = fov_max_grau;
        patch.meta = meta;
      }
      // after the FOV block on purpose: it starts from metaOf(row) and would drop the sensitivity
      if (motion_sensitivity !== undefined) {
        patch.meta = { ...(patch.meta || metaOf(row)), motion_sensitivity };
      }
      // spec 2026-10-27: the mode lives in the camera's meta — it can even be set BEFORE the first
      // profile exists (the old write silently dropped it in that case). Merges on top of `patch.meta`
      // like the sensitivity block above, so the FOV/sensitivity keys already merged survive.
      if (recording_mode !== undefined) {
        patch.meta = { ...(patch.meta || metaOf(row)), recording_mode };
      }
      // spec 2026-10-27: `ativa` merges on top like the two blocks above — same file, same order discipline
      if (ativa !== undefined) patch.meta = { ...(patch.meta || metaOf(row)), ativa };
      await cat.cameras.update(id, patch);
      const out = await cameraOut(await cat.cameras.get(id));
      // the flat cameraOut carries meta keys at the top level; normalize the mode for the client
      // (old rows migrated and created cameras always carry it, but the API must never answer undefined)
      out.recording_mode = out.recording_mode === 'motion' ? 'motion' : 'continuous';
      return out;
    },

    // ponytail: deleting takes profiles and credential; the SEGMENTS stay — retention works on the segment
    // records, so deleting them would orphan the files (whoever stops the ingest/live workers is main, which
    // holds both instances)
    'DELETE /api/v1/cameras/:id': deleteCamera,

    // ---- spec 2026-10-17 (item 1.3): the DVR behaves like a folder ----
    // Renaming, moving folder and deleting are the same PATCH/DELETE the cameras and folders already have;
    // what changes in the DEVICE is the cascade into the children (they have no life of their own outside the
    // recorder) — a FOLDER's cascade. The parent NAME no longer flows down to them (spec 2026-10-17): lining
    // up a child name is a manual rename.
    'PATCH /api/v1/devices/:id': async ({ id, name, group_id } = {}) => {
      const dev = await cat.devices.get(id);
      if (!dev) throw new AppError('device_not_found');
      if (name !== undefined && !name) throw new AppError('name_required');
      if (group_id !== undefined && group_id !== null && !(await cat.groups.get(group_id))) {
        throw new AppError('group_not_found');
      }
      const meta = { ...metaOf(dev) };
      // spec 2026-10-17: the device PATCH touches ONLY its own name. No child is touched, not even the one
      // still carrying the parent's old name: lining up a child name is a manual rename in /cameras/:id.
      if (group_id !== undefined) meta.group_id = group_id;
      // put replaces the row: name is NOT NULL, so the current one goes back with the merged meta
      await cat.devices.put({ id, name: name !== undefined ? name : dev.name, meta });
      // 1.3d: the children FOLLOW the DVR group (operator decision, same move) — and it is through their
      // `group_id` that an orphan child (device deleted by hand, old state) finds its place
      if (group_id !== undefined) {
        for (const cam of (await cat.cameras.listCatalog()).filter((c) => c.device_id === id)) {
          await cat.cameras.update(cam.id, { group_id });
        }
      }
      return flat(await cat.devices.get(id));
    },

    // 1.3g: deleting the DVR takes its N children. Each child leaves through the CAMERA deletion path that
    // already exists (profiles, credential and the shared-credential rule) — never through a second cleanup
    // path. The ORDER matters: the device leaves the index BEFORE the children, because the credential is the
    // same (amendment E9) and whoever deletes it is the LAST to leave; with the device still in the index, the
    // last child's exit would see it using the credential and it would be orphaned forever.
    'DELETE /api/v1/devices/:id': async ({ id } = {}) => {
      const dev = await cat.devices.get(id);
      if (!dev) throw new AppError('device_not_found');
      const children = (await cat.cameras.listCatalog()).filter((c) => c.device_id === id).map((c) => c.id);
      const ref = metaOf(dev).credential_ref;
      await cat.devices.remove(id);
      await dropCredentialIfUnused(ref);
      for (const childId of children) await deleteCamera({ id: childId });
      return { deleted: id, cameras: children };
    },

    'GET /api/v1/cameras/:id/profiles': async ({ id } = {}) => {
      if (!(await cat.cameras.get(id))) throw new AppError('camera_not_found');
      return profilesOf(id);
    },

    'POST /api/v1/cameras/:id/profiles': async ({ id, name, source, recording_mode } = {}) => {
      if (!(await cat.cameras.get(id))) throw new AppError('camera_not_found');
      if (!name) throw new AppError('stream_profile_name_required');
      if (!source) throw new AppError('source_required');
      if ((await cat.profiles.listByCamera(id)).some((p) => p.name === name)) {
        throw new AppError('stream_profile_name_taken');
      }
      return newProfile(id, { name, source, recording_mode });
    },

    'DELETE /api/v1/cameras/:id/profiles': async ({ id, profile_id } = {}) => {
      if (!(await cat.cameras.get(id))) throw new AppError('camera_not_found');
      const list = await cat.profiles.listByCamera(id);
      if (!list.some((p) => p.id === profile_id)) throw new AppError('stream_profile_not_found');
      if (list.length <= 1) throw new AppError('last_profile');
      await cat.profiles.remove(profile_id);
      return { deleted: profile_id };
    },
  };
}

module.exports = { deviceRoutes };

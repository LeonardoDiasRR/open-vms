'use strict';
const http = require('node:http');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('./lib/config');
const { openStore } = require('./lib/store');
const { openMemoryStore } = require('./lib/memory-store');
const { watchConfigFile, writeConfigFile } = require('./lib/config-file');
const { loadMasterKey, seal, open } = require('./lib/credentials');
const { AppError } = require('./lib/errors');
const { scanRange, expandIps } = require('./lib/scanner');
const { buildProbe, parseProbeMatch } = require('./lib/wsdd');
const { recordContinuous } = require('./lib/continuous-recorder');
const { createExportQueue: createExportQueue, sweepPendingJobs: sweepPendingJobs } = require('./lib/export-queue');
const { IngestManager } = require('./lib/ingest');
const { MotionDetector } = require('./lib/motion-detector');
const { Preroll } = require('./lib/preroll');
const { MotionRecording } = require('./lib/motion-recording');
const { MediaIndex: MediaIndex } = require('./lib/fmp4index');
const { createMediaIo } = require('./lib/media-io');
const { mediaResponse } = require('./lib/media-response');
const { monitorPlaybackResources } = require('./lib/playback-resources');
const { windowFor: windowFor, playlistHlsMulti, DEFAULT_WINDOW: DEFAULT_WINDOW } = require('./lib/playback');
const { createTranscoder: createTranscoder } = require('./lib/transcoder');
const { planChunks: planChunks } = require('./lib/transcode-plano');
const { transition } = require('./lib/cameras');
const { ensureAdmin, login, checkSession, sessionKey } = require('./api/auth');
const { deviceRoutes } = require('./api/devices');
const { groupRoutes } = require('./api/groups');
const { archiveRoutes } = require('./api/archive');
const { layoutRoutes } = require('./api/layouts');
// ponytail: the `segments/*` route died (amendment E2) — `segmentFileHandler` has NO CALLER left, but
// the import stays: `server/api/files.js` is outside this spec's file table (its cleanup is the next
// step).
const { exportFileHandler, segmentFileHandler } = require('./api/files');
const { openExportZip } = require('./lib/export-zip');
const { liveRoutes } = require('./api/live');
const { onvifRoutes } = require('./api/onvif');
const { ptzRoutes } = require('./api/ptz');
const { onvifCall, ptzCapability: ptzCapability, ptzMove: ptzMove, ptzStop: ptzStop,
  parsePtzStatus, ptzPosition: ptzPosition, ptzGotoAbsolute: ptzGotoAbsolute } = require('./lib/onvif');
const { authorizeRoute: authorizeRoute, requirePolicy: requirePolicy, isSessionLive: liveSession,
  can: can, filterAuthorizedCameras, cameraControlFlags, PUBLIC_ROUTES: PUBLIC_ROUTES, POLICY: POLICY } = require('./lib/rbac');
const { sanitize: sanitize } = require('./lib/payload-camera');
const { appendEvent, pruneEvents } = require('./lib/events');
const { eventRoutes } = require('./api/events');
const { settingsRoutes } = require('./api/settings');
const { usedPercent: usedPercent, decideLimit: decideLimit } = require('./lib/disk');
const { userRoutes } = require('./api/users');
const { accessRoutes } = require('./api/access');
const { runRetention } = require('./lib/retention');
const { createMediaPersist } = require('./lib/media-persist');
const { createMediaScanner } = require('./lib/media-scan');
const { withCredential: withCredential, withoutCredential: withoutCredential } = require('./lib/rtsp');
const { cameraRoles: cameraRoles } = require('./lib/roles');
const { hubUrl, hubApiUrl, ensureCredential: ensureCredential } = require('./lib/hub');
const { publishCamera: publishCamera, removeCamera, reconcile } = require('./lib/publicacao');
const { restreamRoutes } = require('./api/restream');
const { createStateWatcher: createStateWatcher } = require('./lib/state-hub');
const { repairPort } = require('./lib/reparo-porta');
const { authSessionsRoutes } = require('./api/auth-sessions');
const { createLoginLimiter: createLoginLimiter } = require('./lib/login-limit');
const { record: record } = require('./lib/audit');
const { originIp: originIp, requiresHttps: requiresHttps,
  originAllowed: originAllowed, corsHeaders: corsHeaders } = require('./lib/secure-http');

const VERSION = '0.1.0';
const MAX_BODY = 1e6;
const BEARER = 'Bearer ';   // ponytail: one literal, used as a prefix only (never concatenated here)

// ponytail: WSDD multicast best-effort; any failure => [] and the server stays up
function makeWsddDiscover({ wsddMulticast, wsddPort, timeoutMs = 1500 }) {
  return () => new Promise((resolve) => {
    let sock;
    const found = new Map(); // dedup by ip|port
    let timer;
    const finish = () => {
      clearTimeout(timer);
      if (sock) { try { sock.close(); } catch { /* already closed */ } }
      resolve([...found.values()]);
    };
    try {
      sock = dgram.createSocket('udp4');
      sock.on('error', finish);
      sock.on('message', (msg, rinfo) => {
        try {
          const probe = parseProbeMatch(msg.toString());
          if (!probe || !probe.xaddr) return;
          const port = +new URL(probe.xaddr).port || 80;
          found.set(`${rinfo.address}|${port}`, {
            ip: rinfo.address, openPorts: [port], xaddr: probe.xaddr, name: probe.name, model: probe.model,
          });
        } catch { /* irrelevant probe */ }
      });
      timer = setTimeout(finish, timeoutMs);
      sock.bind(() => {
        try {
          sock.send(buildProbe(crypto.randomUUID()), wsddPort, wsddMulticast, (err) => { if (err) finish(); });
        } catch { finish(); }
      });
    } catch { finish(); }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        // ponytail: the registry has no 413 code yet (errors.js is frozen for this spec) — keep the
        // status the UI contract already expects; `bad_request` is the closest code it owns.
        const tooLarge = new AppError('bad_request', { message: 'Payload too large' });
        tooLarge.status = 413;
        reject(tooLarge);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function startServer(cfg = {}) {
  const conf = { ...loadConfig(process.env), ...cfg };
  const dataDir = conf.dataDir;
  // config.yaml (spec 2026-10-20 §7) is the every-day configuration; the environment keeps only the
  // connection string and the process paths.
  const configPath = cfg.configPath || process.env.OPENVMS_CONFIG || path.join(process.cwd(), 'config.yaml');
  // The CLI refuses to boot without PostgreSQL. A module import (the test suite) gets the in-memory
  // store instead, so route tests do not need a database; production always sets OPENVMS_PG_URL.
  if (!cfg.store && !conf.pgUrl && require.main === module) throw new Error('postgres_required');
  fs.mkdirSync(dataDir, { recursive: true });
  const injected = !!cfg.store;
  const store = cfg.store || (conf.pgUrl
    ? await openStore({ url: conf.pgUrl, dataDir, configPath, checkArchive: true })
    : openMemoryStore({ dataDir, configPath }));
  // `config` is the value IN FORCE: the watcher replaces it when config.yaml changes and stays valid.
  let config = store.config;
  // The root in force. A new archive_dir does NOT move the recordings of a running server — it needs a
  // restart (config_restart_required), so this variable is the only read and does not follow the watcher.
  let archiveRoot = config.recordings.archive_dir;
  const currentRoot = () => archiveRoot;
  // spec 2026-10-19 (video export): workers die with the process — a job persisted as 'queued'/'exporting'
  // lies about its state; boot turns them into 'error' before any route.
  await sweepPendingJobs(store);
  // D7 (§7.1): without an initial password boot GENERATES one, prints it ONCE and keeps it alive in the
  // process. The `admin/admin` default died here — it was the spec's anti-goal.
  await ensureAdmin(store, conf.adminUser || 'admin', conf.adminPassword || process.env.OPENVMS_ADMIN_PASSWORD);
  const masterKey = loadMasterKey(path.join(dataDir, 'vault.key'));
  // RTSP publication (spec 2026-10-14): service credential sealed in the vault, created only with the feature on
  const publishCred = conf.rtsp === true ? await ensureCredential(store, masterKey) : null;
  // ponytail: Hub addresses resolved once — publication reads from here
  const hubApi = hubApiUrl(conf.hubApiUrl);

  // spec 2026-10-18 (5.2) + plan 2026-10-20: the index is DERIVED from disk and the database is its
  // copy. The boot asks NOTHING (T4): a record is created only for the (profile, day) window the UI
  // displays — one query per day shown — and the discovery scan keeps the rows in step with the disk.
  // The 500 ms timer only reindexes the profiles that are RECORDING (flagged by `startIngest`).
  const mediaIo = createMediaIo();
  let index = new MediaIndex({ base: currentRoot(), io: mediaIo, loader: store.media ? {
    loadWindow: (profile, days) => store.media.loadWindow(profile, days),
    loadFrags: (profile, day, hour, session) => store.media.fragsFor(profile, day, hour, session),
    listAll: () => store.media.listAll(),
  } : null });
  const mediaPersist = store.media ? createMediaPersist({ media: store.media, index }) : null;
  // Every change to the index goes to the write-behind; the queue debounces and never throws.
  index.onChange = (profile) => { if (mediaPersist) mediaPersist.touch(profile); };
  // A recording profile is on the timer; the 500 ms scan only touches those (and their day is pinned).
  // Regression 2026-10-20 (rollback in production): `start()` is NOT here — it runs after the listen
  // and after the current day of every recording profile is pinned (see `pinDaysAndStartTimer`).

  // camera state through the Hub (spec 2026-10-16): the auth callback is what wakes the watcher
  const hubState = createStateWatcher({ store, conf, hubApi });
  // §9 (F3): in-process login rate limit (double key account/origin) and JSONL audit in the data
  // directory — the same folder as state.json and the audit.jsonl of the migration.
  const loginLimiter = createLoginLimiter();
  const audit = (event) => record(dataDir, event);
  // spec 2026-10-19 (video export): export queue — ceiling = half the CPUs (user rule), measured
  // ONCE at boot (production container: 12 CPUs -> 6 simultaneous jobs). `run` is one
  // worker_thread per job (server/lib/export-worker.js): copy and ffmpeg stay off the event loop.
  const exportQueue = createExportQueue({
    limit: Math.max(1, Math.floor(os.cpus().length / 2)),
    store,
    run: (jobId, payload, onProgress) => new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'lib', 'export-worker.js'), { workerData: payload });
      w.on('message', (msg) => {
        if (msg.type === 'progress') onProgress(msg.progress);
        else if (msg.type === 'done') resolve(msg);
        else reject(new Error(msg.error));
      });
      w.on('error', reject);
      w.on('exit', (code) => { if (code !== 0) reject(new Error(`export worker exited with code ${code}`)); });
    }),
  });

  // publicacao.js asks deps.cameraSource SYNCHRONOUSLY (desiredPaths builds the Hub source), so the
  // credential of each camera is kept hot in memory: one join per publication pass, not one query per
  // camera. ponytail: the map is only as fresh as the last prime — every path that publishes primes first.
  const credentialByCamera = new Map();
  async function primeCredentials() {
    if (!store.pool) return; // injected in-memory store: nothing to read
    const { rows } = await store.pool.query(
      'SELECT c.id, k.username, k.secret FROM cameras c JOIN credentials k ON k.ref = c.credential_ref');
    credentialByCamera.clear();
    for (const row of rows) {
      credentialByCamera.set(row.id, { username: row.username, password: open(row.secret, masterKey) });
    }
  }

  const deps = {
    credentials: { seal: (secret) => seal(secret, masterKey) },
    expandIps,
    // CFTV preset (TELAS.md T4): the scanner needs ports; inject the default when the client does not ask
    scanRange: (args = {}) => scanRange({ ports: [80, 443, 554, 3702, 8000, 8080], ...args }),
    wsddDiscover: makeWsddDiscover(conf),
    queue: exportQueue,
    // spec 2026-10-16: the playback read walks the disk from this root
    get archiveRoot() { return currentRoot(); },
    chunkSeconds: conf.segmentSeconds,
    // spec 2026-10-18: the timeline, playlist, retention and export routes read from here. `chunkSeconds`
    // stays in deps because the orphan handler of `segments/*` (server/api/files.js, outside this plan's
    // file table — amendment E2) still receives it.
    get indice() { return index; },
    recordingBlocked: () => disk.limited,
    // ponytail: the password is unsealed only at ONVIF call time; it never reaches a log or a response
    openCredential: async (ref) => {
      const c = ref && await store.catalog.credentials.get(ref);
      if (!c) return null;
      return { username: c.username, password: open(c.secret, masterKey) };
    },
    // CAMERA source including the credential: ONLY the Hub publisher uses it (hub spec 2026-10-14).
    // Synchronous on purpose — `desiredPaths` builds every source in one pass; see primeCredentials().
    cameraSource: (profile) =>
      withCredential(profile.source_url, credentialByCamera.get(profile.camera_id) || null),
    // ETag of the camera list (spec §6): `GET /api/v1/cameras` reads it once per request
    catalogRev: () => store.catalog.catalogRev(),
    // internal read through the Hub: ingest reads the Hub RTSP, never the camera
    hubUrl: (route) => hubUrl(conf.rtspPublish, publishCred, route),
    tokens: require('./lib/read-token'),
    hubState: hubState,
    publishCredential: () => publishCred,
    // re-streaming state for the UI: enabled, port and the paths the Hub has ready
    rtsp: async () => {
      if (conf.rtsp !== true) return { enabled: false, port: conf.rtspPort, active: [] };
      const { listPaths } = require('./lib/hub-config');
      let items = [];
      try { items = await listPaths(hubApi); } catch { items = []; }
      return { enabled: true, port: conf.rtspPort, active: items.filter((c) => c.ready).map((c) => c.name) };
    },
    onvif: {
      deviceInformation: (a) => onvifCall({ ...a, action: 'GetDeviceInformation' }),
      profiles: (a) => onvifCall({ ...a, action: 'GetProfiles' }),
      networkInterfaces: (a) => onvifCall({ ...a, action: 'GetNetworkInterfaces' }),
      streamUri: (a) => onvifCall({ ...a, action: 'GetStreamUri' }),
      // multi-channel detector (spec 2026-10-17): injected like the others so tests can swap them
      videoSources: (a) => onvifCall({ ...a, action: 'GetVideoSources' }),
      // PTZ (spec 2026-10-16): injected like the others so tests can swap in doubles
      ptzCapability: ptzCapability, ptzMove: ptzMove, ptzStop: ptzStop,
      // local positions (spec 2026-10-17): same injection shape — without them the route breaks at runtime
      parsePtzStatus, ptzPosition: ptzPosition, ptzGotoAbsolute: ptzGotoAbsolute,
    },
  };

  // spec 2026-10-19 (task 3.1): the per-session transcode engine (60 s chunks, LRU cache under the
  // data directory). `conf.transcoder` is the test seam (same pattern as `recordOnce`/onvif): tests
  // inject the engine with mocked `execFile`/ffprobe. The shutdown AbortController is the engine's
  // `signal`: close() kills the in-flight ffmpeg, like the ingest worker does (review note).
  const transcoderAbort = new AbortController();
  deps.transcoder = conf.transcoder || createTranscoder({
    cacheRoot: process.env.OPENVMS_TRANSCODE_CACHE_DIR || path.join(dataDir, 'transcode'),
    chunkSeconds: 4, signal: transcoderAbort.signal });
  const playbackResources = monitorPlaybackResources({ io: mediaIo, transcoder: deps.transcoder });
  // review note: the encoder probe runs at BOOT — otherwise the first chunk would pay for the candidate
  // tests (nvenc/qsv/vaapi/libx264) in front of the request. The catch keeps boot alive, but the error
  // is LOGGED (review issue C: a mute catch hid the cause of the encoder choice on the first chunk).
  Promise.resolve(deps.transcoder.chooseEncoder()).then((result) => {
    if (!result) return;
    console.log(`transcoder: encoder=${result.encoder}`);
    for (const line of result.logs || []) if (line.startsWith('WARN')) console.log(line);
  }).catch((e) => console.error('transcoder: probe failed', e && e.message));

  // display roles per camera: primary = widest; secondary = the smallest of the rest
  // (roles.js takes `profile_ids` + a map of profiles: the catalog owns the relation, so it is rebuilt).
  // `list` travels with the roles so the boot can stop a worker left on a profile that no longer wins.
  const rolesOf = async (cam) => {
    const list = await store.catalog.profiles.listByCamera(cam.id);
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    const roles = cameraRoles({ id: cam.id, profile_ids: list.map((p) => p.id) }, byId);
    return { ...roles, list };
  };

  // per-camera recording (spec 2026-10-15): the manager ALWAYS exists, empty, and the Recording tab
  // switch is what starts a worker.
  const ingest = new IngestManager({
    // ponytail: test seam, like the onvif/ptz in deps — tests swap the recorder for a double
    recordOnce: conf.recordOnce || recordContinuous,
    continuous: !conf.recordOnce,
    // Return the promise so continuous publication waits for indexing and state changes.
    events: (e) => ingestEvent(e).catch((err) => console.error(`ingest event: ${err.message}`)),
  });

  // spec 2026-10-18 (5.2): there is no manifest and no `state.segments` anymore — what was recorded
  // lives in the hour file and the index finds it by itself. What is left here is the camera state
  // transition.
  async function ingestEvent(e) {
    if (e.kind === 'opened' || e.kind === 'closed') {
      const dir = e.dir || path.dirname(e.file);
      const [year, month, day] = dir.split(path.sep).slice(-3).map(Number);
      // ponytail: wait out a current-day timer scan before requesting yesterday at midnight.
      await index.profileScans.get(e.id);
      await index.scanProfileAsync(e.id, new Date(year, month - 1, day));
    }
    if (e.state === 'error') {
      await appendEvent(store, { kind: 'ingest', severity: 'error',
        message: `ingest ${e.id}: ${withoutCredential(e.error)}`, profile_id: e.id });
      return;
    }
    if (e.state !== 'online') return;
    const profile = await store.catalog.profiles.get(e.id);
    const cameraId = profile && profile.camera_id;
    const cam = cameraId ? await store.catalog.cameras.get(cameraId) : null;
    // ponytail: ingest emits 'online' on every round; only the offline->online transition becomes an event
    if (!cam || cam.state === 'online') return;
    try { transition(cam, 'online'); } catch { return; } // illegal transition (ENTIDADES.md): state stays
    await store.catalog.cameras.setStates([{ id: cameraId, state: 'online', error_code: null }]);
    await appendEvent(store, { kind: 'camera', severity: 'info', message: 'camera online', camera_id: cameraId });
  }

  // The index only walks the RECORDING profiles (spec 5.2). These two doors are the only path to
  // start/stop a worker — flagging here covers boot, registration, the tab switch and the DELETE.
  const startIngest = (profile, opts) => { ingest.start(profile, opts); index.markActive(profile, true); };
  const stopIngest = (profile) => { ingest.stop(profile); index.markActive(profile, false); };

  // Spec 2026-10-23: one instance per process. The detector and the pre-roll are replaceable in tests
  // (`conf.motionDetector` / `conf.preroll`), like `conf.recordOnce`.
  // ponytail: `disk` is born AFTER this. The closure only reads it in arm(), when the disk is already measured.
  const motion = new MotionRecording({
    detector: conf.motionDetector || new MotionDetector(),
    preroll: conf.preroll || new Preroll({ dir: process.env.OPENVMS_PREROLL_DIR || '/tmp/ovms-preroll' }),
    ingest: { start: startIngest, stop: stopIngest },
    diskLimited: () => disk.limited,
  });

  // Detection source: the Hub secondary when the camera has one. Otherwise the primary (spec §6.6).
  async function detectSourceOf(cameraId) {
    const profiles = await store.catalog.profiles.listByCamera(cameraId);
    const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
    const { secondary } = cameraRoles({ id: cameraId, profile_ids: profiles.map((p) => p.id) }, byId);
    return deps.hubUrl(secondary ? `${cameraId}/sub` : cameraId);
  }
  async function sensitivityOf(cameraId) {
    const row = await store.catalog.cameras.get(cameraId);
    const v = row && row.meta && row.meta.motion_sensitivity;
    return Number.isInteger(v) && v >= 1 && v <= 9 ? v : 5;
  }
  async function armMotion({ cameraId, profileId, outDir }) {
    return motion.arm({
      cameraId, profileId, outDir, base: currentRoot(),
      recordSource: deps.hubUrl(cameraId),
      detectSource: await detectSourceOf(cameraId),
      sensitivity: await sensitivityOf(cameraId),
    });
  }

  // spec 2026-10-16: the "recording now" stripe needs a live worker; ingest is born after deps,
  // so the access is published here (before the routes are mounted).
  deps.recording = (profileId) => ingest.isRecording(profileId);
  // spec 2026-10-19: rearming is its own function — boot, root change and leaving the disk gate use
  // the same path. With the gate on, no worker starts (recording preserved in state).
  // spec 2026-10-25: the profile that records is the WIDEST (`cameraRoles`), never the one named
  // `main`. Every worker this camera has on another profile is stale: when a wider profile appears,
  // the old one would keep writing a second copy of the same stream.
  async function recordingTargets() {
    const out = [];
    for (const cam of await store.catalog.cameras.listRecording()) {
      // spec 2026-10-27 (camera ativa): a deactivated camera never re-arms at boot (nor when the disk
      // gate lifts); the `recording` column survives, so reactivating restores it through the PATCH.
      if (cam.meta && cam.meta.ativa === false) continue;
      const roles = await rolesOf(cam);
      if (roles.primary) out.push({ cam, roles });
    }
    return out;
  }

  async function rearmIngest() {
    if (disk.limited) return;
    for (const { cam, roles } of await recordingTargets()) {
      const primary = roles.primary;
      for (const p of roles.list || []) if (p.id !== primary.id) stopIngest(p.id);
      // spec 2026-10-27: the MODE belongs to the camera (meta); the WIDEST profile only decides
      // WHERE the footage is written. Reading the mode from the profile was the Aeroporto bug:
      // the UI wrote 'main', the recorder obeyed 'mainStream'.
      const mode = (cam.meta && cam.meta.recording_mode) === 'motion' ? 'motion' : 'continuous';
      const outDir = path.join(currentRoot(), primary.id);
      if (mode !== 'motion') {
        await motion.disarm(cam.id).catch(() => {});
        startIngest(primary.id, { source: deps.hubUrl(cam.id), outDir });
        continue;
      }
      stopIngest(primary.id);
      await armMotion({ cameraId: cam.id, profileId: primary.id, outDir })
        .catch((e) => console.error(`motion: falha ao armar ${cam.id}: ${e.message}`));
    }
  }

  // Disk watcher (spec 2026-10-19): fs.statfs on the effective root. The gate state lives in memory and
  // is recomputed at boot — the disk is the source of truth, not state.json.
  const disk = { path: null, used_percent: null, total_bytes: null, free_bytes: null, limited: false, error: null };
  const statfsFn = conf.statfs || fs.promises.statfs;
  // config.yaml validates the range (1..100) on boot and on every reload, so the value is already effective
  const diskLimit = () => config.recordings.disk_max_percent;
  async function remediateDisk() {
    const base = currentRoot();
    disk.path = base;
    let st = null;
    try { fs.mkdirSync(base, { recursive: true }); } catch { /* exists or will fail in the statfs below */ }
    try { st = await statfsFn(base); disk.error = null; } catch (e) { disk.error = e.message; }
    if (!st) {
      disk.limited = true; // fail-safe (E8): without a measurement, do NOT record — root gone, mount down
    } else {
      disk.used_percent = usedPercent(st);
      disk.total_bytes = st.blocks * st.bsize;
      disk.free_bytes = st.bavail * st.bsize;
      const before = disk.limited;
      disk.limited = decideLimit({ used_percent: disk.used_percent, limit: diskLimit(), limited: disk.limited });
      if (disk.limited && !before) {
        await appendEvent(store, { kind: 'disco', severity: 'warn',
          message: `recordings interrupted: disk at ${disk.used_percent}% (limit ${diskLimit()}%)` });
      }
    }
    if (disk.limited) { for (const profile of [...ingest.workers.keys()]) stopIngest(profile); }
    else await rearmIngest();
    return { ...disk };
  }

  // boot: measure the disk BEFORE rearming — with the limit already exceeded, nothing starts.
  await remediateDisk();
  const diskTimer = setInterval(() => { remediateDisk().catch(() => {}); }, 60000);
  diskTimer.unref();
  // Hub publication (spec 2026-10-16): no process of ours. The Hub pulls the camera on demand; the API
  // only registers each role's path and reconciles when the Hub restarts.
  // one-off repair of an old registration (spec 2026-10-16): runs before the first publication, otherwise
  // the Hub receives the URL with the wrong port at boot
  try {
    const repaired = await repairPort(store);
    if (repaired.repaired.length) console.log(`port repair: ${repaired.repaired.length} camera(s)`);
  } catch (e) {
    console.error('reparo de porta failed: ' + e.message);
  }
  async function publishAll() {
    if (conf.rtsp !== true) return { published: [] };
    await primeCredentials();   // the source of each path is built synchronously from this map
    return reconcile(hubApi, { store, deps, conf });
  }
  let reconcileTimer = null;
  if (conf.rtsp === true) {
    await publishAll().catch((e) => console.error('hub: failed to publish on boot: ' + e.message));
    reconcileTimer = setInterval(() => {
      publishAll().catch((e) => console.error('hub: reconcile failed: ' + e.message));
    }, conf.hubReconcileMs);
    reconcileTimer.unref(); // ponytail: does not hold the process in tests
  }

  // spec 2026-10-19: retention became GLOBAL (Settings > Recordings) and its value now lives in
  // config.yaml (`recordings.retention_days`).
  // ponytail: a single way to run retention — the manual route and the scheduler use the same
  const runRetentionNow = async () => {
    const out = runRetention({ hours: await index.all(), maxBytes: conf.retentionBytes,
      daysFor: () => config.recordings.retention_days });
    if (out.deleted) {
      // the index is DERIVED: whoever deletes recordings has to forget them, otherwise it answers for a
      // file that no longer exists. Plan T10: the rows go with the files (day rows left without an hour
      // fall with them), so the next boot does not hydrate what this pass removed.
      const paths = out.files;
      index.forget(paths);
      if (store.media) {
        await store.media.forget(paths).catch((e) => console.error('media: retention rows ' + e.message));
      }
    }
    await appendEvent(store, { kind: 'retention', message: `retention: ${out.deleted} hours, ${out.bytesFreed} bytes` });
    return out;
  };
  // ponytail: the scheduler runs ALWAYS (the 3-day default is always a limit); unref()
  // so it does not hold the process in tests
  const retentionTimer = setInterval(() => { runRetentionNow().catch(() => {}); }, 3600e3);
  retentionTimer.unref();
  // events retention (config.yaml `events.retention_days`): an hourly prune, no other ceiling
  const eventsTimer = setInterval(() => {
    pruneEvents(store, config.events.retention_days).catch((e) => console.error('events prune: ' + e.message));
  }, 3600e3);
  eventsTimer.unref();

  // config.yaml hot reload (spec 2026-10-20 §7): retention, disk limit and events retention apply on
  // the spot; a new archive_dir does NOT move the recordings of a running server (restart required).
  const stopWatcher = watchConfigFile(configPath, {
    onValid: (next) => {
      const rootChanged = next.recordings.archive_dir !== archiveRoot;
      config = next;
      remediateDisk().catch((e) => console.error('config reload: disk ' + e.message));
      runRetentionNow().catch((e) => console.error('config reload: retention ' + e.message));
      pruneEvents(store, next.events.retention_days).catch((e) => console.error('config reload: events ' + e.message));
      if (rootChanged) {
        console.warn(`config.yaml: recordings.archive_dir changed to ${next.recordings.archive_dir}`
          + ` — restart required (still recording to ${archiveRoot})`);
        appendEvent(store, { kind: 'config_restart_required', severity: 'warn',
          message: `recordings.archive_dir changed to ${next.recordings.archive_dir}: restart required` })
          .catch((e) => console.error('config restart event: ' + e.message));
      }
    },
    onInvalid: (err) => {
      console.error('config.yaml invalid, previous value kept: ' + err.message);
      appendEvent(store, { kind: 'config_invalid', severity: 'error',
        message: `config.yaml invalid: ${err.message}` })
        .catch((e) => console.error('config invalid event: ' + e.message));
    },
  });

  // ponytail: the public list comes from the POLICY inventory itself (D8) — a new route cannot
  // become public by sitting in a second list; `rtsp/auth` is public because mediamtx calls it without
  // a session, and the origin gate (loopback) lives in the handler.
  const PUBLIC = new Set(PUBLIC_ROUTES);
  const devices = deviceRoutes(store, deps);
  const handlers = {
    'GET /api/v1/health': async () => ({ ok: true, version: VERSION }),
    'POST /api/v1/auth/login': async (body = {}, req) => {
      // §9: the rate limit keys by ACCOUNT (the username INFORMED — exists or not, so it does not become
      // an existence oracle) and by ORIGIN (real IP, only trustworthy behind a trusted proxy).
      const ip = originIp(req, conf);
      const keys = [`account:${String(body.username || '')}`, `origin:${ip}`];
      const wait = loginLimiter.delayMs(keys);
      if (wait) await new Promise((r) => setTimeout(r, wait));   // progressive delay, without blocking the loop
      const s = await login(store, body.username, body.password);
      if (!s) {
        loginLimiter.failed(keys);
        // ponytail: the message carries the informed user, never the password
        await appendEvent(store, { kind: 'auth', severity: 'error', message: `login failed: ${body.username}` });
        audit({ actor: String(body.username || ''), action: 'login.failed', target_type: 'user',
          target_id: String(body.username || ''), outcome: 'negado', metadata: { ip } });
        // GENERIC response: identical for a wrong password, a nonexistent account and a blocked account
        throw new AppError('invalid_credentials');
      }
      loginLimiter.succeeded(keys);
      audit({ actor: s.username, action: 'login.ok', target_type: 'user', target_id: s.username, outcome: 'ok' });
      return s;
    },
    ...devices,
    ...archiveRoutes(store, deps),
    ...layoutRoutes(store),
    ...restreamRoutes(store, deps),
    ...liveRoutes(store, deps, conf),
    ...groupRoutes(store),
    'GET /api/v1/profiles': async () => store.catalog.profiles.listAll(),
    ...onvifRoutes(store, deps),
    ...ptzRoutes(store, deps),
    ...userRoutes(store),
    ...authSessionsRoutes(store),
    ...accessRoutes(store),
    ...eventRoutes(store),
    // spec 2026-10-19: global settings (read = camera.view; write = settings.manage). config.yaml is the
    // only source: the route reads it through the live `config`, writes through the atomic writer.
    ...settingsRoutes(store, { archiveRoot: currentRoot, disk: () => ({ ...disk }), remediate: remediateDisk,
      config: () => config,
      writeConfig: (next) => { config = writeConfigFile(configPath, next); return config; } }),
    // ponytail: on-demand retention; the route capability is `retention.manage` (rbac.js POLICY)
    'POST /api/v1/retention/run': async () => runRetentionNow(),
  };
  // ponytail: archive and publication react only to profile creation, for ALL the camera profiles (not only main)
  if (conf.rtsp === true) {
    const addDevice = devices['POST /api/v1/devices'];
    handlers['POST /api/v1/devices'] = async (body) => {
      const out = await addDevice(body);
      // Multi-channel (spec decision 4): ONE addition creates N cameras — each child is published to the
      // Hub and, when it is born recording, its ingest starts (the single-camera path is the array of 1).
      const cameras = out && out.device ? out.cameras : [out];
      // the add may have sealed a new credential: the synchronous source map is refreshed once
      await primeCredentials();
      for (const cam of cameras) {
        const { primary } = await rolesOf(cam);
        // ponytail: the path must exist in the Hub BEFORE ingest fetches the stream; a Hub that is down
        // must NOT break the registration — reconciliation reapplies the path on the next cycle
        if (conf.rtsp === true) {
          await publishCamera(hubApi, { store, deps, conf, cam })
            .catch((e) => console.error('hub: failed to publish ' + cam.id + ': ' + e.message));
        }
        // a new camera is born OFF (absent = false): the wrapper only starts a worker if the registration
        // already creates the camera recording — today it does not, and the tab is what turns it on.
        if (primary && cam.recording === true) startIngest(primary.id, {
          source: deps.hubUrl(cam.id), outDir: path.join(currentRoot(), primary.id),
        });
      }
      return out;
    };

  }

  // ponytail: deleting a camera has to stop its ffmpeg — the ids are read BEFORE the delete,
  // because after the mutation the camera (and the profiles) no longer exist. It sits OUTSIDE the
  // rtsp gate: stopping the worker does not depend on the Hub (execution finding — the stop was not
  // running with rtsp off).
  // Discarding a camera's MEDIA (stop both workers + remove the paths from the Hub) lives in its own
  // function because the DEVICE DELETE (spec 2026-10-17, 1.3g) calls it per child: without it the ffmpeg
  // of a deleted DVR's children would keep recording outside the state (orphan file, out of retention's
  // reach) and the paths would stay published in the Hub.
  const discardMedia = async (cameraId, roles) => {
    for (const role of ['primary', 'secondary']) {
      const p = roles[role];
      if (p && ingest) stopIngest(p.id);
    }
    if (conf.rtsp === true) {
      await removeCamera(hubApi, cameraId)
        .catch((e) => console.error('hub: failed to remove ' + cameraId + ': ' + e.message));
    }
  };

  const delCamera = devices['DELETE /api/v1/cameras/:id'];
  handlers['DELETE /api/v1/cameras/:id'] = async (params) => {
    const cam = await store.catalog.cameras.get(params.id);
    // the roles are read BEFORE the delete: afterwards the camera profiles already left the state and
    // `rolesOf` would answer null (measured defect: the ffmpeg worker kept running)
    const roles = cam ? await rolesOf(cam) : { primary: null, secondary: null };
    const out = await delCamera(params);
    // spec §5: the camera grants vanish with it — `camera_grants.camera_id` is ON DELETE CASCADE, so the
    // database already took them (no custom profile can point at the void).
    await discardMedia(params.id, roles);
    return out;
  };

  // 1.3g: the DVR takes its N children. Each child's roles are read BEFORE the device handler (it
  // deletes the children from state and afterwards there would be no way to know which profiles to stop).
  const delDevice = devices['DELETE /api/v1/devices/:id'];
  handlers['DELETE /api/v1/devices/:id'] = async (params) => {
    const listed = await store.catalog.cameras.listCatalog();
    const children = [];
    for (const c of listed.filter((row) => row.device_id === params.id)) {
      children.push({ id: c.id, roles: await rolesOf(c) });
    }
    const out = await delDevice(params);
    for (const f of children) await discardMedia(f.id, f.roles);
    return out;
  };

  // switch effect (Recording tab): the route validates and persists, main starts/stops the worker of this
  // camera's PRIMARY. Both calls are idempotent in the manager (start with an id that already exists does
  // nothing; stop without a worker does nothing too), so a PATCH that only renames is harmless.
  // It sits OUTSIDE `if (conf.rtsp === true)` on purpose: the camera is what owns recording.
  const patchCamera = devices['PATCH /api/v1/cameras/:id'];
  handlers['PATCH /api/v1/cameras/:id'] = async (body) => {
    // disk gate (spec 2026-10-19): with the limit reached no NEW recording can be turned ON; turning it
    // off and the other fields stay free. The 409 is the contract with the UI (the switch reverts with the warning).
    if (body && body.recording === true && disk.limited) {
      throw new AppError('recording_limit_reached');
    }
    const cam = await patchCamera(body);
    const { primary } = await rolesOf(cam);
    if (!primary) return cam;
    // spec 2026-10-27 (camera ativa): deactivating stops recording NOW (worker + motion detector);
    // the `recording` flag survives in the column, so reactivating falls into the branches below and
    // rearms the saved mode. The Hub drops `/id` and `/id/sub`: same publication cycle the reconcile
    // timer runs (Task 1.2 already removed inactive paths from `desiredPaths`) — no new timer. The
    // catch keeps a Hub outage from turning a persisted PATCH into a 500.
    if (cam.ativa === false) {
      await motion.disarm(cam.id).catch(() => {});
      stopIngest(primary.id);
      await publishAll().catch((e) => console.error('hub: republish after deactivate failed: ' + e.message));
      return cam;
    }
    const outDir = path.join(currentRoot(), primary.id);
    // Spec 2026-10-23: the mode decides who opens the session. Both paths are idempotent in the manager.
    if (cam.recording !== true) {
      await motion.disarm(cam.id).catch(() => {});
      stopIngest(primary.id);
      return cam;
    }
    // spec 2026-10-27: same single source: the camera's meta (patchCamera returns the FLAT camera,
    // whose top-level recording_mode is the meta key flattened by cameraOut).
    if (cam.recording_mode !== 'motion') {
      await motion.disarm(cam.id).catch(() => {});
      startIngest(primary.id, { source: deps.hubUrl(cam.id), outDir });
      return cam;
    }
    stopIngest(primary.id);
    await armMotion({ cameraId: cam.id, profileId: primary.id, outDir })
      .catch((e) => console.error(`motion: falha ao armar ${cam.id}: ${e.message}`));
    return cam;
  };

  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };
  // Coded errors (task 4.2): an AppError carries status + interpolated message; anything else is a 500.
  const sendError = (res, e) => {
    if (e instanceof AppError) return send(res, e.status, { error: e.message, code: e.code, params: e.params });
    // ponytail: transitional bridge — `server/api/*` and `server/lib/*` still throw `'NNN: text'` until
    // phase 5 migrates them (124 call sites measured); dropping this now would turn their statuses into 500.
    const legacy = /^(\d{3}):\s*(.*)$/.exec(e.message || '');
    if (legacy) return send(res, +legacy[1], { error: legacy[2] });
    send(res, 500, { error: (e && e.message) || 'Internal error' });
  };
  const fail = (res, code, params) => sendError(res, new AppError(code, params));

  // ponytail: binary routes outside the JSON map; browser <img>/<video> send no header,
  // so besides Bearer they accept ?token= (media element limitation, on these routes)
  // ponytail: a missing `ts` means "window ending at now" (spec 5.3). The empty value has to become
  // `undefined`, never 0: `Number(null)` = 0 would land in 1970 and the playlist would come out empty.
  const tsFromUrl = (url) => (url.searchParams.has('ts') ? Number(url.searchParams.get('ts')) : undefined);

  // spec 2026-10-19 (task 3.1, 5.4): the transcoded playlist path. The engine schedules the window
  // chunks; the playlist waits ONLY for the FIRST one with the engine's awaitChunk (errors bubble up
  // as coded AppErrors). The following ones enter only if already parsed (`chunkInfo` is non-blocking,
  // the SAME fmp4index as the player; empty frags = not parsed yet) — a pending chunk stays OUT of the
  // playlist: never wait for the ceiling in here (review note: the serial wait locked the playlist for
  // N x 30 s on a cold window). Waiting for a chunk belongs to the chunk ROUTE (long-poll on the URI);
  // the player requests the playlist again on refresh and a VOD that covers less than the window is
  // valid text.
  async function transcodedPlaylist({ profile, ts, de, ate, requested, token, client, previewRate = 0, sourceFps = 25 }) {
    if (requested !== 'h264') throw new AppError('codec_unsupported', { codec: requested });
    const modern = deps.transcoder.chunkSeconds < 60;
    let sources;
    if (modern) {
      sources = [];
      for (const h of await deps.indice.hours(profile, de, ate)) {
        const frags = await deps.indice.fragments(profile, h.identity || h.name);
        const coverage = [];
        for (const f of frags) {
          const end = f.t1 ?? f.t0 + (f.duration || (frags.length > 1 ? frags.at(-2).t1 - frags.at(-2).t0 : 1));
          const last = coverage.at(-1);
          if (last && Math.abs(last[1] - f.t0) < 0.01) last[1] = end;
          else coverage.push([f.t0, end]);
        }
        const stat = await fs.promises.stat(h.file);
        sources.push({ arquivoHora: h.identity, identity: h.identity, filePath: h.file,
          anchor: h.anchor, generation: `${h.anchor}:${h.initFim}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, coverage });
      }
    }
    const legacyPlan = planChunks({ de, ate });
    // fail-closed like `pathOf`: only what the INDEX indexed becomes a source; if an hour is
    // missing, the engine itself answers with its own 404.
    if (!sources) sources = [...new Set(legacyPlan.map((c) => c.arquivoHora))]
      .map((arquivoHora) => ({ arquivoHora, filePath: deps.indice.pathOf(profile, path.basename(arquivoHora)) }))
      .filter((f) => f.filePath);
    const owner = /^[a-zA-Z0-9-]{16,64}$/.test(client || '') ? `${sessionKey(token)}:${client}` : undefined;
    const outputFps = previewRate ? Math.max(1, Math.round(sourceFps / previewRate)) : undefined;
    const filters = previewRate ? ["scale=w='min(960,iw)':h=-2", `fps=${outputFps}`] : [];
    const scheduled = await deps.transcoder.ensureWindow({ profile: profile, ts, janela: { de, ate }, sources: sources,
      client: owner, filters, outputFps, representation: previewRate ? `h264-preview-${previewRate}` : 'h264' });
    const plan = scheduled.plan || legacyPlan;
    const hlsChunks = [];
    for (const [i, c] of plan.entries()) {
      const address = c.id || c.ini;
      let info = deps.transcoder.chunkInfo(profile, address);
      if (!info || !info.frags.length) {
        if (i > 0) continue;                                   // pending: stays out (the long-poll is in the route)
        await deps.transcoder.awaitChunk({ profile: profile, ini: address });
        info = deps.transcoder.chunkInfo(profile, address);
        if (!info || !info.frags.length) throw new AppError('transcode_fragments_missing', { ini: c.ini });
      }
      hlsChunks.push({ url: `/api/v1/play/${profile}/transcode/${address}`, initFim: info.initFim,
        // fmp4index -> playlistHlsMulti: byteStart -> ini, size -> tam; dur = t1-t0 or the nominal one.
        frags: info.frags.map((f) => ({ ini: f.byteStart, tam: f.size,
          dur: f.duration || (f.t1 === null || f.t1 === undefined ? info.nominal : f.t1 - f.t0),
          ...(modern ? { t0: c.ini + f.t0, t1: c.ini + (f.t1 ?? f.t0 + (f.duration || info.nominal)) } : {}) })) });
    }
    const txt = playlistHlsMulti({ chunks: hlsChunks, token, de, ate, temporal: modern });
    if (!txt) throw new AppError('fragment_window_empty');
    return previewRate ? txt.replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-OVMS-REPRESENTATION:preview\n') : txt;
  }

  const BIN = [
    // spec 2026-10-23 (batch download): the ZIP is a stream, so it lives in BIN and not in the map of
    // handlers (which answer JSON). `out.stream` is the contract of the binary branch.
    { route: 'GET /api/v1/exports/zip', re: /^\/api\/v1\/exports\/zip$/, params: () => ({}),
      run: (m, url) => openExportZip(store, url.searchParams.get('ids')) },
    { route: 'GET /api/v1/exports/:id/file',
      re: /^\/api\/v1\/exports\/([^/]+)\/file$/, params: (m) => ({ id: decodeURIComponent(m[1]) }),
      run: (m) => exportFileHandler(store, decodeURIComponent(m[1])), stream: true },
    // spec 2026-10-18 (5.3): per-session delivery. The playlist is TEXT generated on the server (a pure
    // function of playback.js) and `file` answers `Range`/206 through the SAME media branch that already existed.
    { route: 'GET /api/v1/play/:profile_id/playlist.m3u8',
      re: /^\/api\/v1\/play\/([^/]+)\/playlist\.m3u8$/, params: (m) => ({ profile_id: decodeURIComponent(m[1]) }),
      run: async (m, url) => {
        const profile = decodeURIComponent(m[1]);
        const ts = tsFromUrl(url);
        const { de, ate } = windowFor({ ts, janela: Number(url.searchParams.get('janela')) || DEFAULT_WINDOW });
        const hours = await deps.indice.hours(profile, de, ate);
        if (!hours.length) throw new AppError('recording_at_instant_missing');
        const token = url.searchParams.get('token') || '';
        // spec 2026-10-19 (task 3.1): `videoCodec` != source codec -> playlist of h264 chunks.
        // Without the param (or asking for the codec the source ALREADY has) the text is the SAME as today.
        const requested = url.searchParams.get('videoCodec');
        const rate = Number(url.searchParams.get('previewRate'));
        const preview = process.env.OPENVMS_PLAYBACK_PREVIEW === '1' && url.searchParams.get('quality') === 'preview'
          && rate === 4;
        if (requested || preview) {
          const target = await deps.indice.fileAt(profile, ts) || hours[0];
          const file = deps.indice.pathOf(profile, target.identity || target.name);
          if (!file) throw new AppError('hour_file_missing');
          const source = await deps.transcoder.codecOfSource(file);
          if (requested && requested !== source.name || preview) {
            const txt = await transcodedPlaylist({ profile, ts, de, ate, requested: requested || 'h264', token,
              client: url.searchParams.get('client'), previewRate: preview ? rate : 0, sourceFps: source.fps || 25 });
            return { bytes: Buffer.from(txt, 'utf8'), contentType: 'application/vnd.apple.mpegurl' };
          }
        }
        const chunks = [];
        for (const hour of hours) {
          const identity = hour.identity || hour.name;
          const frags = await deps.indice.fragments(profile, identity);
          chunks.push({ url: `${encodeURIComponent(identity)}/file`, initFim: hour.initFim,
            frags: frags.map((f, i) => ({ ini: f.byteStart, tam: f.size, t0: f.t0, t1: f.t1,
              dur: f.duration || (f.t1 == null ? (i > 0 ? f.t0 - frags[i - 1].t0 : 1) : f.t1 - f.t0) })) });
        }
        const txt = playlistHlsMulti({ chunks, de, ate, token, temporal: true });
        if (!txt) throw new AppError('fragment_window_empty');
        return { bytes: Buffer.from(txt, 'utf8'), contentType: 'application/vnd.apple.mpegurl' };
      } },
    // spec 2026-10-19 (task 3.1): the transcode session chunk. Long-poll up to the engine ceiling
    // (a pending chunk waits until `waitMs` -> 503). `ini` restricted to `\d+` in the regex; profile/ini
    // are revalidated at the engine chokepoint (`chunkPath` -> 400) — the route is only the first sieve.
    { route: 'GET /api/v1/play/:profile_id/transcode/:ini',
      re: /^\/api\/v1\/play\/([^/]+)\/transcode\/(\d+|[a-f0-9]{64})$/,
      params: (m) => ({ profile_id: decodeURIComponent(m[1]), ini: m[2] }),
      run: async (m) => {
        const { filePath, bytes, release } = await deps.transcoder.awaitChunk({ profile: decodeURIComponent(m[1]), ini: m[2], pin: true });
        // LRU eviction between awaitChunk and the stream: re-stat right now (ENOENT becomes 404 — never a
        // createReadStream crash in the middle of the response).
        return { path: filePath, bytes, release, contentType: 'video/mp4' };
      }, stream: true },
    { route: 'GET /api/v1/play/:profile_id/:arquivo/file',
      re: /^\/api\/v1\/play\/([^/]+)\/([^/]+)\/file$/,
      params: (m) => ({ profile_id: decodeURIComponent(m[1]), arquivo: decodeURIComponent(m[2]) }),
      run: async (m) => {
        // Fail-closed: the name only resolves against what the INDEX indexed — never build a path from
        // the URL (`../`, an unknown name and someone else's profile all give 404).
        const file = deps.indice.pathOf(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (!file) throw new AppError('hour_file_missing');
        return { path: file, bytes: (await fs.promises.stat(file)).size, contentType: 'video/mp4' };
      }, stream: true },
  ];

  // ponytail: JSON routes with a path param (scans/:id, profiles per camera, onvif); no router framework
  const DYN = [
    { method: 'GET', re: /^\/api\/v1\/discovery\/scans\/([^/]+)$/, key: 'GET /api/v1/discovery/scans/:id',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'GET', re: /^\/api\/v1\/cameras\/([^/]+)\/profiles$/, key: 'GET /api/v1/cameras/:id/profiles',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'POST', re: /^\/api\/v1\/cameras\/([^/]+)\/profiles$/, key: 'POST /api/v1/cameras/:id/profiles',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'DELETE', re: /^\/api\/v1\/cameras\/([^/]+)\/profiles$/, key: 'DELETE /api/v1/cameras/:id/profiles',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'POST', re: /^\/api\/v1\/devices\/([^/]+)\/onvif$/, key: 'POST /api/v1/devices/:id/onvif',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    // DEVICE resync (spec decision 3) — `:id` is the device; the /onvif route above takes a CAMERA id.
    // `devices/channels` does not enter here: it is a static route (exact key in handlers) and the regexes
    // here are anchored, so neither `/channels` nor `/sync` are captured by the /onvif entry.
    { method: 'POST', re: /^\/api\/v1\/devices\/([^/]+)\/sync$/, key: 'POST /api/v1/devices/:id/sync',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    // spec 2026-10-17 (item 1.3): the DVR as a folder. The regexes are anchored, so `/channels`, `/sync`
    // and `/onvif` are not captured by these two — and the `:id` is the DEVICE's, never a camera's (that
    // one stays in /cameras/:id).
    { method: 'PATCH', re: /^\/api\/v1\/devices\/([^/]+)$/, key: 'PATCH /api/v1/devices/:id',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'DELETE', re: /^\/api\/v1\/devices\/([^/]+)$/, key: 'DELETE /api/v1/devices/:id',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'GET', re: /^\/api\/v1\/cameras\/([^/]+)\/config$/, key: 'GET /api/v1/cameras/:id/config',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'POST', re: /^\/api\/v1\/cameras\/([^/]+)\/onvif-refresh$/, key: 'POST /api/v1/cameras/:id/onvif-refresh',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'POST', re: /^\/api\/v1\/cameras\/([^/]+)\/manufacturer$/, key: 'POST /api/v1/cameras/:id/manufacturer',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'GET', re: /^\/api\/v1\/cameras\/([^/]+)\/ptz$/, key: 'GET /api/v1/cameras/:id/ptz',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'POST', re: /^\/api\/v1\/cameras\/([^/]+)\/ptz\/move$/, key: 'POST /api/v1/cameras/:id/ptz/move',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'POST', re: /^\/api\/v1\/cameras\/([^/]+)\/ptz\/stop$/, key: 'POST /api/v1/cameras/:id/ptz/stop',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    // spec 2026-10-18: zoom into the area marked with Shift+drag. Two sibling routes — the box and its
    // revert (`ptzUnzoom` from Nx). The regexes are anchored: they do not match `/ptz/move` nor `/ptz/positions`.
    { method: 'POST', re: /^\/api\/v1\/cameras\/([^/]+)\/ptz\/viewport-zoom$/, key: 'POST /api/v1/cameras/:id/ptz/viewport-zoom',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'POST', re: /^\/api\/v1\/cameras\/([^/]+)\/ptz\/viewport-unzoom$/, key: 'POST /api/v1/cameras/:id/ptz/viewport-unzoom',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    // spec 2026-10-17: saved positions of the PTZ panel (OpenVMS-local, not device presets).
    // `positions/goto` comes BEFORE the generic `positions` — find takes the FIRST match.
    { method: 'POST', re: /^\/api\/v1\/cameras\/([^/]+)\/ptz\/positions\/goto$/, key: 'POST /api/v1/cameras/:id/ptz/positions/goto',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'GET', re: /^\/api\/v1\/cameras\/([^/]+)\/ptz\/positions$/, key: 'GET /api/v1/cameras/:id/ptz/positions',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'POST', re: /^\/api\/v1\/cameras\/([^/]+)\/ptz\/positions$/, key: 'POST /api/v1/cameras/:id/ptz/positions',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'PATCH', re: /^\/api\/v1\/cameras\/([^/]+)\/ptz\/positions$/, key: 'PATCH /api/v1/cameras/:id/ptz/positions',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'DELETE', re: /^\/api\/v1\/cameras\/([^/]+)\/ptz\/positions$/, key: 'DELETE /api/v1/cameras/:id/ptz/positions',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    // ponytail: cameras/:id with no suffix — does not match /cameras/:id/profiles (anchored regex)
    { method: 'PATCH', re: /^\/api\/v1\/cameras\/([^/]+)$/, key: 'PATCH /api/v1/cameras/:id',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'DELETE', re: /^\/api\/v1\/cameras\/([^/]+)$/, key: 'DELETE /api/v1/cameras/:id',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'PATCH', re: /^\/api\/v1\/groups\/([^/]+)$/, key: 'PATCH /api/v1/groups/:id',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'DELETE', re: /^\/api\/v1\/groups\/([^/]+)$/, key: 'DELETE /api/v1/groups/:id',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    // spec 2026-10-17 (§10): registration and access profiles get the `:param` shape. The regexes are
    // anchored and no other entry matches `/users/<x>` or `/profiles/access/<x>`; `mine` is a STATIC route
    // (exact key in `handlers`) and therefore does not enter here.
    { method: 'PATCH', re: /^\/api\/v1\/users\/([^/]+)$/, key: 'PATCH /api/v1/users/:username',
      params: (m) => ({ username: decodeURIComponent(m[1]) }) },
    // §10 (F3): the admin password reset. The regex is anchored — it does not match `users/<x>` (that one
    // accepts a single segment) nor the legacy format.
    { method: 'POST', re: /^\/api\/v1\/users\/([^/]+)\/reset-password$/, key: 'POST /api/v1/users/:username/reset-password',
      params: (m) => ({ username: decodeURIComponent(m[1]) }) },
    // spec 2026-10-18 (4.6): rename a user. Anchored regex — does not match `users/<x>` nor
    // `reset-password`.
    { method: 'POST', re: /^\/api\/v1\/users\/([^/]+)\/rename$/, key: 'POST /api/v1/users/:username/rename',
      params: (m) => ({ username: decodeURIComponent(m[1]) }) },
    { method: 'DELETE', re: /^\/api\/v1\/users\/([^/]+)$/, key: 'DELETE /api/v1/users/:username',
      params: (m) => ({ username: decodeURIComponent(m[1]) }) },
    { method: 'PATCH', re: /^\/api\/v1\/profiles\/access\/([^/]+)$/, key: 'PATCH /api/v1/profiles/access/:id',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'DELETE', re: /^\/api\/v1\/profiles\/access\/([^/]+)$/, key: 'DELETE /api/v1/profiles/access/:id',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
    { method: 'GET', re: /^\/api\/v1\/profiles\/access\/([^/]+)\/grants$/, key: 'GET /api/v1/profiles/access/:id/grants',
      params: (m) => ({ id: decodeURIComponent(m[1]) }) },
  ];

  // spec §6: LISTING filtered by scope and camera payload without credential or admin URL for whoever
  // does not manage. The cut lives here because devices.js does not read the session and this is already
  // the main shape (the POST /devices and DELETE /cameras/:id wrappers).
  const CAMERA_LISTS = new Set(['GET /api/v1/cameras', 'GET /api/v1/devices', 'GET /api/v1/profiles']);
  const CAMERA_PAYLOAD = new Set([...CAMERA_LISTS, 'GET /api/v1/cameras/:id/profiles']);
  const postProcess = async (route, out, ctx) => {
    if (!CAMERA_PAYLOAD.has(route)) return out;
    if (route === 'GET /api/v1/cameras') {
      // spec 2026-10-27 (task 2.2): the client hides PTZ per camera — the SAME grant rule as the
      // dispatcher, answered by cameraControlFlags. Managers get the annotation too (they see all;
      // no sanitize for them, as before); non-managers keep the `view` cut and the sanitizer.
      let visible = out;
      if (!ctx.gerencia) {
        const ok = new Set(await filterAuthorizedCameras(store, ctx.session, ctx.user, out.map((c) => c.id), 'view'));
        visible = out.filter((c) => ok.has(c.id));
      }
      const ctl = await cameraControlFlags(store, ctx.session, ctx.user, visible.map((c) => c.id));
      return visible.map((c) => {
        const cam = { ...c, can_control: ctl.has(c.id) };   // annotated BEFORE the sanitizer
        return ctx.gerencia ? cam : sanitize(cam);
      });
    }
    if (ctx.gerencia) return out;
    if (route === 'GET /api/v1/profiles') {
      const ok = new Set(await filterAuthorizedCameras(store, ctx.session, ctx.user, out.map((p) => p.camera_id), 'view'));
      return out.filter((p) => ok.has(p.camera_id)).map(sanitize);
    }
    if (route === 'GET /api/v1/devices') {
      const cameras = await store.catalog.cameras.listCatalog();
      const ok = new Set(await filterAuthorizedCameras(store, ctx.session, ctx.user, cameras.map((c) => c.id), 'view'));
      const withChild = cameras.filter((c) => ok.has(c.id)).map((c) => c.device_id);
      return out.filter((d) => withChild.includes(d.id)).map(sanitize);
    }
    return sanitize(out);   // GET /api/v1/cameras/:id/profiles already went through the camera in the engine
  };

  // D8 (§4): a registered route without an access policy breaks boot. Runs AFTER all route tables
  // (handlers/BIN/DYN keep the declared keys) and BEFORE the server accepts connections.
  // ponytail: the call sits HERE, after `BIN`, and not next to `postProcess` — `const BIN` is in TDZ
  // above this point and `requirePolicy` reads it (measured divergence, see the report).
  requirePolicy([...Object.keys(handlers), ...BIN.map((b) => b.route)]);

  // §8: revoking the ACL cuts the stream IN FLIGHT. The profiles route does not know the Hub; the
  // dispatcher computes the affected paths and tells the watcher to expel their consumers (preserving the
  // service credential — ingest reads the same path). The `credential_version` already raised on those
  // routes takes care of the token/session; this takes care of the Hub session that is already reading.
  const cut = (paths) => hubState.disconnectConsumers(paths, { preserve: publishCred && publishCred.username })
    .catch((e) => console.error('watcher: failed to cut consumers: ' + e.message));
  const postAccess = handlers['POST /api/v1/profiles/access'];
  handlers['POST /api/v1/profiles/access'] = async (body, req, ctx) => {
    const out = await postAccess(body, req, ctx);
    await cut((body && body.grants || []).map((g) => g.camera_id));
    return out;
  };
  const patchAccess = handlers['PATCH /api/v1/profiles/access/:id'];
  handlers['PATCH /api/v1/profiles/access/:id'] = async (body, req, ctx) => {
    const before = body && body.id ? await store.access.camerasWithLevel(body.id, 'view') : [];
    const after = (body && body.grants || []).map((g) => g.camera_id);
    const out = await patchAccess(body, req, ctx);
    await cut([...before, ...after]);
    return out;
  };
  const patchUser = handlers['PATCH /api/v1/users/:username'];
  handlers['PATCH /api/v1/users/:username'] = async (body, req, ctx) => {
    const u = body && body.username ? await store.access.userGet(body.username) : null;
    const paths = u && u.profile_id ? await store.access.camerasWithLevel(u.profile_id, 'view') : [];
    const out = await patchUser(body, req, ctx);
    await cut(paths);
    // §9: block/unblock (the PATCH that changes `status`) and deletion are their own events
    const statusChanged = body && body.status && u && u.status !== body.status;
    const action = statusChanged ? (body.status === 'disabled' ? 'user.blocked' : 'user.unblocked') : 'user.updated';
    audit({ actor: (ctx && ctx.session && ctx.session.username) || 'unknown', action,
      target_type: 'user', target_id: body.username, outcome: 'ok',
      ...(body && body.profile_id ? { metadata: { profile_id: body.profile_id } } : {}) });
    return out;
  };
  const delUser = handlers['DELETE /api/v1/users/:username'];
  handlers['DELETE /api/v1/users/:username'] = async (body, req, ctx) => {
    const u = body && body.username ? await store.access.userGet(body.username) : null;
    const paths = u && u.profile_id ? await store.access.camerasWithLevel(u.profile_id, 'view') : [];
    const out = await delUser(body, req, ctx);
    await cut(paths);
    audit({ actor: (ctx && ctx.session && ctx.session.username) || 'unknown', action: 'user.deleted',
      target_type: 'user', target_id: body.username, outcome: 'ok' });
    return out;
  };

  // §9 (F3): administrative actions are audited. The actor is ALWAYS the calling session (never the body),
  // and the target is the resource — no credential, no token, no password.
  const auditAfter = (key, action, targetOf, extraOf) => {
    const before = handlers[key];
    handlers[key] = async (body, req, ctx) => {
      const out = await before(body, req, ctx);
      audit({ actor: (ctx && ctx.session && ctx.session.username) || 'unknown', action,
        target_type: targetOf.type, target_id: targetOf.id(out, body, ctx), outcome: 'ok',
        ...(extraOf ? { metadata: extraOf(out, body, ctx) } : {}) });
      return out;
    };
  };
  auditAfter('POST /api/v1/auth/logout', 'logout', { type: 'user', id: (_out, _body, ctx) => ctx.session.username });
  auditAfter('POST /api/v1/auth/change-password', 'user.password.changed', { type: 'user', id: (out) => out.username });
  auditAfter('POST /api/v1/users', 'user.created', { type: 'user', id: (out) => out.username });
  // spec 2026-10-18 (4.6): the target is the NEW name (the `out` already comes back renamed) and the old one
  // travels in `metadata.before` — the trail keeps the swap, not only the final state.
  auditAfter('POST /api/v1/users/:username/rename', 'user.renamed',
    { type: 'user', id: (out) => out.username }, (_out, body) => ({ before: body.username }));
  auditAfter('POST /api/v1/users/:username/reset-password', 'user.password.reset',
    { type: 'user', id: (out) => out.username }, () => ({ sessions_killed: true }));
  auditAfter('POST /api/v1/profiles/access', 'profile.created', { type: 'profile', id: (out) => out.id });
  auditAfter('PATCH /api/v1/profiles/access/:id', 'profile.grants.changed', { type: 'profile', id: (out) => out.id });
  auditAfter('DELETE /api/v1/profiles/access/:id', 'profile.deleted', { type: 'profile', id: (_out, body) => body.id });

  // §7.1.5 + §8: the reset also cuts the user's media IN FLIGHT. The `revogar` in users.js already drops
  // the sessions and raises the version; the media token of the path belongs to the Hub watcher — reading
  // the paths BEFORE and cutting AFTER is the same shape as the other wrappers.
  const resetPassword = handlers['POST /api/v1/users/:username/reset-password'];
  handlers['POST /api/v1/users/:username/reset-password'] = async (body, req, ctx) => {
    const u = body && body.username ? await store.access.userGet(body.username) : null;
    const paths = u && u.profile_id ? await store.access.camerasWithLevel(u.profile_id, 'view') : [];
    const out = await resetPassword(body, req, ctx);
    await cut(paths);
    return out;
  };

  // §9 (F3): HTTPS mandatory outside loopback and Origin validation. CORS is no longer a fixed
  // object — with an allowed `Origin` it echoes THAT origin (E7/A7); without `Origin` it keeps the `*`.
  const server = http.createServer(async (req, res) => {
    // 1) transport: outside loopback (where the front nginx terminates TLS) only https gets in
    if (requiresHttps(req, conf)) { fail(res, 'https_required'); return; }
    // 2) origin: refused BEFORE any authorization (and before OPTIONS)
    if (!originAllowed(req, conf)) { fail(res, 'origin_not_allowed'); return; }
    const cors = corsHeaders(req, conf);
    // §7.1.4 (F4): with a pending password change the server only serves SESSION routes. The exempt set
    // comes from POLICY itself (`cap === 'session'`: me, change-password, logout and mine) — a second route
    // list would be the "route that became public by being elsewhere" that D8 forbids. It applies to the
    // API and, right below, to the MEDIA of the BIN branch.
    const passwordChangePending = (user, route) => !!(user && user.must_change_password === true
      && POLICY[route] && POLICY[route].cap !== 'session');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    // §9: the media token travels in `?token=` (a `<video>` limitation, E9) — it must not become a
    // Referer or an access log.
    res.setHeader('referrer-policy', 'no-referrer');
    const url = new URL(req.url, 'http://localhost');
    const bin = req.method === 'GET' && BIN.find((b) => b.re.test(url.pathname));
    if (bin) {
      const match = bin.re.exec(url.pathname);
      const auth = req.headers.authorization || '';
      const token = (auth.startsWith(BEARER) ? auth.slice(BEARER.length) : '') || url.searchParams.get('token') || '';
      // ponytail: media requires ONLY a session in the header (the `<video>` sends no header). The
      // validation is the SAME as the JSON routes: active user + `credential_version` equal to the
      // session's — disabling, granting or demoting kills the stream in flight (spec §6).
      const media = await checkSession(store, token);
      if (!media || !liveSession(media)) { fail(res, 'not_authenticated'); return; }
      const mediaUser = await store.access.userGet(media.username);
      if (passwordChangePending(mediaUser, bin.route)) {
        fail(res, 'password_change_required');
        return;
      }
      try {
        // §8: media read from disk goes through the SAME engine — playback = camera.view on the profile,
        // export = camera.manage (D2).
        await authorizeRoute(store, media, mediaUser, bin.route, bin.params(match));
        const out = await bin.run(match, url);
        const base = { 'content-type': out.contentType || 'application/octet-stream', ...cors,
          ...(out.disposition ? { 'content-disposition': out.disposition } : {}) };
        if (out.stream) { res.writeHead(out.status || 200, base); out.stream.pipe(res); return; }
        if (bin.stream) { await mediaResponse(req, res, out, base); return; }
        res.writeHead(200, { ...base, 'content-length': out.bytes.length });
        res.end(out.bytes);
      } catch (e) {
        sendError(res, e);
      }
      return;
    }
    const key = `${req.method} ${url.pathname}`;
    let roleKey = key;
    let handler = handlers[key];
    let pathParams = {};
    if (!handler) {
      const dynamicRoute = DYN.find((d) => d.method === req.method && d.re.test(url.pathname));
      // ponytail: the RBAC key is the declared route (with :param), not the raw path
      if (dynamicRoute) {
        handler = handlers[dynamicRoute.key];
        roleKey = dynamicRoute.key;
        pathParams = dynamicRoute.params(dynamicRoute.re.exec(url.pathname));
      }
    }
    try {
      if (!handler) { fail(res, 'route_not_found'); return; }
      // ponytail: the arguments come BEFORE the authorization because the resource camera may be in the
      // BODY (the read token resolves the camera through `profile_id` — spec §6).
      let args;
      if (req.method === 'GET') {
        // ponytail: query arrives as a string; numeric values are coerced here so the handler contract is typed
        args = Object.fromEntries([...url.searchParams].map(([k, v]) => [k, v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v]));
      } else {
        const raw = await readBody(req);
        args = raw ? JSON.parse(raw) : {};
      }
      // `headers` travels in the input so a GET can compare its validator (GET /api/v1/cameras reads
      // If-None-Match); handlers ignore it otherwise.
      const input = { ...args, ...pathParams, headers: req.headers };
      const auth = req.headers.authorization || '';
      const token = auth.startsWith(BEARER) ? auth.slice(BEARER.length) : '';
      // ponytail: session + capability + camera scope in one call; 401/403/404 bubble up through the
      // coded error hook below.
      const session = PUBLIC.has(key) ? null : await checkSession(store, token);
      // the user row is read BEFORE the authorization: `authorizeRoute` resolves the profile through it
      const user = session ? await store.access.userGet(session.username) : null;
      if (!PUBLIC.has(key)) await authorizeRoute(store, session, user, roleKey, input);
      // `session_id` is the HASH key of the token (the SAME one that indexes the `sessions` table) — the
      // REAL session identifier, which separates two tabs/browsers of the SAME user. `username` alone is
      // per ACCOUNT: whoever needs per-session memory (the PTZ pre-zoom) uses this field.
      const ctx = { session, user, session_id: session ? sessionKey(token) : null,
        profile: (user && user.profile_id) || null,
        gerencia: !!(session && await can(store, session, user, 'camera.manage.global')) };
      // §7.1.4 (F4): the barrier applies to every route that is not `session` — the 403 leaves BEFORE the
      // handler and reveals nothing about the resource.
      if (passwordChangePending(ctx.user, roleKey)) throw new AppError('password_change_required');
      // ponytail: req goes as the 2nd argument (the existing handlers ignore it) because the rtsp/auth
      // loopback gate needs the origin TCP; `ctx` goes as the 3rd (the session profile).
      let out = await handler(input, req, ctx);
      if (ctx.session) out = await postProcess(roleKey, out, ctx);
      // ETag contract (spec section 6): the client sends it back as If-None-Match on the next poll.
      if (roleKey === 'GET /api/v1/cameras') res.setHeader('ETag', `"${await store.catalog.catalogRev()}"`);
      send(res, 200, out);
    } catch (e) {
      sendError(res, e);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(conf.port, resolve);
  });

  // Regression 2026-10-20 (rollback in production): the LISTEN comes first, then the boot pins the
  // CURRENT day of every recording profile from `media_hours`, and ONLY THEN the 500 ms timer runs.
  // Without the pin the first tick found an empty day-cache and (the old code) readdir'd and
  // re-opened the whole day of every profile on the NFS share — the event loop froze before the
  // first /health. A failed pin never takes the listen down: `scanProfile` refuses to hydrate from
  // disk while the window is unloaded and retries the async load on every tick.
  const pinDaysAndStartTimer = (async () => {
    const primaries = (await recordingTargets()).map((t) => t.roles.primary.id);
    await index.pinCurrentDays(primaries);
  })();
  pinDaysAndStartTimer.then(
    // a server closed while the pin was in flight must not restart the timer after `stop()`
    () => { if (!closed) index.start(); },
    (err) => { console.error('media: day pin failed: ' + err.message); if (!closed) index.start(); },
  );

  // Plan T4/T9: discovery runs AFTER the listen, and no boot query touches `media_hours` up front. The
  // PostgreSQL store uses the incremental scanner: it walks with readdir + stat and hydrates ONLY the
  // days it reads from `media_hours` (one windowed query per profile/day, never the archive); the
  // in-memory store has no rows, so the full walk is still its fallback.
  {
    const scan = store.media ? createMediaScanner({ index, media: store.media, base: currentRoot() }) : null;
    const boot = scan ? scan.run().then((out) => {
      console.log(`media: scanned ${out.days} days, ${out.opened} hours reindexed, ${out.removed} rows removed`);
      return mediaPersist.flush();
    }) : index.loadAsync();
    boot.catch((err) => console.error('media: scan failed: ' + err.message));
  }

  let closed = false;
  return {
    port: server.address().port,
    store,
    // Compatibility view for the legacy HTTP tests; undefined on PostgreSQL (never used in production).
    state: store.state,
    ingest,
    get indice() { return index; },
    playbackMetrics: playbackResources.snapshot,
    disco: () => ({ ...disk }),
    remediarDisco: remediateDisk,
    raizAtual: currentRoot,
    async close() {
      if (closed) return;
      closed = true;
      if (ingest) ingest.stop();
      transcoderAbort.abort();   // kills the in-flight transcoder ffmpeg (same rule as the workers)
      index.stop();
      playbackResources.close();
      await mediaIo.close();
      // last write-behind pass: what the scan saw is in PostgreSQL before the pool goes away
      if (mediaPersist) await mediaPersist.close();
      stopWatcher();
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      if (eventsTimer) clearInterval(eventsTimer);
      clearInterval(diskTimer);
      server.close();
      // the injected store belongs to the caller (tests close it themselves); the one opened here ends now
      if (!injected) await store.close();
    },
  };
}

module.exports = { startServer };

// CLI bootstrap: `node server/main.js` (before this the file only exported and exited silently)
if (require.main === module) {
  const conf = loadConfig(process.env);
  startServer({ ...conf, adminUser: process.env.OPENVMS_ADMIN_USER || 'admin',
    adminPassword: process.env.OPENVMS_ADMIN_PASSWORD,
    configPath: process.env.OPENVMS_CONFIG || path.join(process.cwd(), 'config.yaml') })
    .then((srv) => {
      console.log(`OpenVMS server v${VERSION} em http://0.0.0.0:${srv.port} (data: ${conf.dataDir})`);
      const stop = () => { srv.ingest && srv.ingest.stop(); srv.close(); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => { console.error('failed to start:', e.message); process.exit(1); });
}


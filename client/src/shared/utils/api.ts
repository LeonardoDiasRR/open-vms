// Thin OpenVMS HTTP client (M1). Only native fetch/URLSearchParams.
const scheme = 'Bearer '; // ponytail: prefix concatenated at runtime (avoids credential redaction in the writing tools)

// ponytail: the status is glued onto the Error (same shape the components already read by narrowing)
const httpError = (status: number, data: unknown) => Object.assign(
  new Error((data as { error?: string } | null)?.error || `http ${status}`), { status });

// Query string of the paged reads: only what was actually sent — an empty search is ABSENT, not `q=`.
function qs(o: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

// Handler response types: the return is no longer `any` (which forced the component callback to be
// annotated — TS7006) and now sustains the Pick<ApiClient, ...>.
export type Address = { ip: string; port?: number; scheme?: string; informada?: boolean };
export type Onvif = { manufacturer?: string; model?: string; firmware?: string; mac?: string; endpoint?: string; synced_at?: string };
export type Manual = { manufacturer: string; rtsp_primary?: string; rtsp_secondary?: string; reported_at?: string };
export type Camera = {
  id: string;
  name: string;
  state: string;
  added_via?: string;
  error_code?: string;
  created_at?: string;
  updated_at?: string;
  addresses?: Address[];
  profile_ids: string[];
  group_id?: string;
  recording?: boolean;
  recording_profile_id?: string | null;
  onvif?: Onvif;
  manual?: Manual | null;
  credential_ref?: string;
  device_id?: string | null;
  channel?: number | null;
  physical_id?: string;
  // Per-camera control grant from GET /cameras. OPTIONAL so old fixtures/payloads keep compiling.
  can_control?: boolean;
  // Spec 2026-10-27 (camera ativa): absent = active; only `ativa === false` means inactive.
  ativa?: boolean;
  // Spec 2026-10-30 (multi-server): o hook etiqueta a fatia de cada servidor; additive — os
  // payloads do backend nunca carregam o campo.
  server_id?: string;
};
// Parent device (spec 2026-10-17): the child camera lives inside it (device_id) and carries the
// device channel.
export type Device = {
  id: string; name: string; kind?: string; addresses?: Address[]; channels?: number[];
  credential_ref?: string; onvif?: Onvif | null; created_at?: string;
  group_id?: string | null; // spec 2026-10-17 (1.3d): the DVR may live inside a folder
  server_id?: string;       // spec 2026-10-30 (multi-server): etiqueta do hook, additive
};
// One row of the wizard channel checklist: `has_stream` comes from the OPTIONS probe on the channel
// (decision 3).
export type Channel = { channel: number; has_stream: boolean; reason?: string | null };
export type DeviceChannels = { multichannel: boolean; sources: number; channels: Channel[] };
// POST /devices returns the camera (single) OR the parent device with its children (multi-channel).
// ponytail: `addCamera` stays annotated as `Camera` — the multi path (E6) has no consumer in the
// client and adopting the union on its own would break 16 accesses already pinned in api.test.ts.
// When a screen reads the id of the device that was born, change the return to this type and
// narrow the callers.
export type AddResponse = Camera | { device: Device; cameras: Camera[]; onvif?: unknown; onvif_error?: string | null };
export type StreamProfile = {
  id: string;
  camera_id: string;
  name: string;
  source_url?: string;
  recording_mode?: string;
  created_at?: string;
  onvif_token?: string;
  width?: number | null;
  height?: number | null;
};
// GET /cameras/:id/config — the modal read; the SAME response comes back from onvif-refresh and
// from POST manufacturer.
export type CameraConfig = {
  id: string;
  name: string;
  state?: string;
  group_id?: string;
  recording: boolean;
  addresses?: Address[];
  manufacturer?: string;
  manufacturer_source?: string;
  synced_at?: string;
  onvif?: Onvif;
  onvif_error?: string;
  manual: Manual | null;
  rtsp: { primary?: string; secondary?: string };
  profiles?: { name: string; source_url?: string; width?: number; height?: number }[];
};
// spec 2026-10-19 (Settings > Recordings): the global config lives in the state under the `settings` key.
export type DiskStatus = {
  path: string; used_percent: number | null; total_bytes: number | null;
  free_bytes: number | null; limited: boolean; error?: string | null;
};
export type Settings = {
  archive_dir_effective: string;
  retention_days: number; disk_max_percent: number; disk: DiskStatus;
};
export type Brand = { name: string };
export type Group = { id: string; name: string; parent_id?: string | null; created_at?: string; server_id?: string };
export type Cell = { id: string; col: number; row: number; colspan: number; rowspan: number; content?: { kind: string; camera_id: string } | null };
export type Layout = { id: string; name: string; cells?: Cell[]; created_ts?: number; updated_ts?: number };
export type Bucket = { t: number; fraction: number };
// Recording segment returned by the timeline (spec 2026-10-17): `url` is the API route, relative —
// the disk path never leaves the server and the client adds base and token, as it does on export.
export type FileSegment = { start_ts: number; end_ts: number; bytes: number; url: string };
export type Timeline = {
  profile_id?: string;
  from?: number;
  to?: number;
  bucket_seconds: number;
  buckets: Bucket[];
  gaps?: { stream_profile_id?: string; from_ts: number; to_ts: number }[];
  segments: number;
  segmentos?: FileSegment[];
  gravando?: { from: number; to: number } | null;
};
// spec 2026-10-19 (video export): asynchronous job. States: 'queued' | 'exporting' | 'ready' |
// 'error' ('done' survives in old jobs of the pre-migration state.json — the UI handles both).
// `path` is gone: the disk path never leaves the server. `state: string` (not a union) on purpose —
// the labels are a map and the type test is not the guardian of the API shape.
export type ExportJob = { id: string; stream_profile_id?: string; camera_name?: string; name?: string; description?: string;
  from_ts: number; to_ts: number; state: string; progress?: number; bytes?: number;
  created_at?: string; error?: string };
// PTZ (spec 2026-10-16): capability the SERVER proved (the client does not guess) + command vector.
export type PtzCapability = {
  supported: boolean;
  panTilt?: boolean;
  zoom?: boolean;
  continuous?: boolean;
  // The recording gate is PER AXIS (spec 2026-10-17, section 3): a camera with only continuous zoom
  // still saves a pan/tilt position. `absolute` remains the AND of both, for compatibility.
  absolutePanTilt?: boolean;
  absoluteZoom?: boolean;
  absolute: boolean;
  token?: string | null;
  error?: string | null;
  synced_at?: string;
};
export type PtzVector = { pan: number; tilt: number; zoom: number };
// OpenVMS saved position (spec 2026-10-17): the list is local, so the identity is the server `id`
// and the name is free (the `Position N` rule belongs to the server, amendment E1).
export type PtzPosition = { id: number; name: string };
export type ScanScope = { ips: string[]; ports?: number[]; source?: string };
export type ScanStart = { scan_id: string; state: string; scope?: ScanScope | null; started_ts: string };
export type Scan = { id: string; kind?: string; state: string; scope?: ScanScope | null; started_ts: string; found?: number; finished_ts?: string; error?: string };
export type Discovery = {
  id: string;
  ip: string;
  openPorts?: number[];
  xaddr?: string | null;
  name?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  // How the server PROVED the host is a camera ('verified' | 'credential_required' | 'invalid_credential' |
  // 'rtsp') — the wire values of server/lib/camera-gate.js. Without a status the cell stays empty
  // (candidate recorded before the gate).
  status?: string | null;
  scan_id?: string;
  outcome?: string;
  seen_count?: number;
  // gate stamp (spec 2026-10-17): the GetVideoSources count; >= 2 is a DVR candidate
  videoSources?: number;
  first_seen_at?: string;
};
// spec 2026-10-19 (onboarding §5.1): first_run is additive and OPTIONAL in the type — the server
// always sends it, and the optional lets old auth fixtures compile unchanged (oracle §6).
export type Session = { token: string; expires_at: number; username: string; profile_id: string; must_change_password: boolean; first_run?: boolean; capabilities: string[] };
export type Me = { username: string; profile_id: string | null; status: string | null; must_change_password: boolean; first_run?: boolean; capabilities: string[] };
export type PasswordChange = { token: string; expires_at: number; username: string; must_change_password: boolean };
// `profile_name` only comes from the paged list (the JOIN of spec 2026-10-20 §5): a created/patched
// user does not carry it, so it is optional.
export type User = { username: string; profile_id: string; profile_name?: string; status: string; must_change_password: boolean; created_at?: string };
export type Grant = { camera_id: string; level: 'view' | 'control' };
// ACCESS profile (spec §5) — do not confuse with `StreamProfile`, which is a VIDEO profile (`/api/v1/profiles`).
// The LIST item carries `grants_count`, never the grants: the editor asks for them on demand
// (`accessProfileGrants`). `AccessProfileFull` is what create/PATCH answer.
export type AccessProfile = { id: string; name: string; kind: 'system' | 'custom'; grants_count: number; created_at?: string; updated_at?: string };
export type AccessProfileFull = AccessProfile & { grants: Grant[] };
// spec 2026-10-20 §5: `total` is the count of the FILTERED set, `items` is the page.
export type Page<T> = { items: T[]; total: number; limit: number; offset: number };
// The sort keys are a CLOSED list per route on the server (anything else is 400 sort_invalid). They
// stay `string` here: the table's sort key is the column key, and casting it buys nothing.
export type ListQuery = { limit?: number; offset?: number; q?: string; sort?: string; dir?: 'asc' | 'desc' };
export type UsersQuery = ListQuery & { status?: 'active' | 'disabled' };
export type AccessProfilesQuery = ListQuery & { kind?: 'system' | 'custom' };
export type PasswordReset = { username: string; temporary_password: string; must_change_password: boolean };
export type Event = { id: string; ts: number; kind: string; severity: string; message?: string; camera_id?: string | null; profile_id?: string | null };
export type Rtsp = { enabled: boolean; port: number; active: string[] };
export type Health = { ok: boolean; version: string };
export type OnvifSync = { device: Onvif | null; profiles: StreamProfile[]; errors: { token: string; error: string }[] };

export class ApiClient {
  base: string;
  token: string | null;
  // Conditional read of GET /api/v1/cameras (spec §6): the validator of the last 200 and the list that
  // came with it. A 304 answers with the very list in hand — the callers never see the difference.
  // ponytail: per instance, and cleared on every login/logout: the list is filtered by the PROFILE, so
  // another session must not inherit it.
  camerasEtag: string | null = null;
  camerasCache: Camera[] | null = null;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/$/, '');
    this.token = null;
  }

  // `reqRaw` is the same call WITHOUT the throw: it exists for the one CONDITIONAL read (cameras +
  // If-None-Match, spec §6), which needs the status and the ETag of the answer.
  async reqRaw(method: string, path: string, body?: unknown, extra?: Record<string, string>):
  Promise<{ status: number; etag: string | null; data: unknown }> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...extra,
        ...(this.token ? { authorization: scheme + this.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // 304 carries no body: parse only what came; a stubbed fetch may not carry headers at all
    const text = await res.text();
    const etag = res.headers && typeof res.headers.get === 'function' ? res.headers.get('etag') : null;
    return { status: res.status, etag: etag ?? null, data: text ? JSON.parse(text) : null };
  }

  async req<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
    const r = await this.reqRaw(method, path, body, extra);
    if (r.status < 200 || r.status >= 300) {
      throw httpError(r.status, r.data);
    }
    return r.data as T;
  }

  async login(username: string, password: string) {
    const s = await this.req<Session>('POST', '/api/v1/auth/login', { username, password });
    this.token = s.token;
    this.camerasEtag = null; this.camerasCache = null; // the previous session's list must not come back
    return s;
  }

  // ponytail: the session is just the token in memory; real expiry happens on the server
  logout() { this.token = null; this.camerasEtag = null; this.camerasCache = null; }


  // F4 (spec §10): the own-session routes and administration. The names follow the file convention
  // (`req` is thin); `accessProfiles` carries "access" so it does not collide with `profiles()`,
  // which is VIDEO profiles, nor with `deleteProfile`, which deletes a camera profile.
  me() { return this.req<Me>('GET', '/api/v1/auth/me'); }
  async changePassword(current: string, password: string) {
    const t = await this.req<PasswordChange>('POST', '/api/v1/auth/change-password', { current, password });
    this.token = t.token; // §7.1.6: the change invalidates the old token; the instance adopts the new one (like login)
    return t;
  }

  // spec 2026-10-20 §5: server-side table — filter, order and page in the database.
  users(query: UsersQuery = {}) { return this.req<Page<User>>('GET', `/api/v1/users${qs(query)}`); }
  createUser(body: { username: string; password: string; profile_id: string }) {
    return this.req<User>('POST', '/api/v1/users', body);
  }
  patchUser(username: string, body: { profile_id?: string; status?: 'active' | 'disabled' }) {
    return this.req<User>('PATCH', `/api/v1/users/${encodeURIComponent(username)}`, body);
  }
  // spec 2026-10-18 (4.6): rename is its own route, in the reset-password format. The new name goes
  // in `new_username`.
  renameUser(username: string, newUsername: string) {
    return this.req<User>('POST', `/api/v1/users/${encodeURIComponent(username)}/rename`, { new_username: newUsername });
  }
  deleteUser(username: string) {
    return this.req<{ deleted: string }>('DELETE', `/api/v1/users/${encodeURIComponent(username)}`);
  }
  resetPassword(username: string) {
    return this.req<PasswordReset>('POST', `/api/v1/users/${encodeURIComponent(username)}/reset-password`);
  }

  accessProfiles(query: AccessProfilesQuery = {}) { return this.req<Page<AccessProfile>>('GET', `/api/v1/profiles/access${qs(query)}`); }
  // spec §5: the list does not carry the grants; the editor asks for them here, on demand.
  accessProfileGrants(id: string) {
    return this.req<Grant[]>('GET', `/api/v1/profiles/access/${encodeURIComponent(id)}/grants`);
  }
  createAccessProfile(body: { name: string; grants?: Grant[] }) {
    return this.req<AccessProfileFull>('POST', '/api/v1/profiles/access', body);
  }
  patchAccessProfile(id: string, body: { name?: string; grants?: Grant[] }) {
    return this.req<AccessProfileFull>('PATCH', `/api/v1/profiles/access/${encodeURIComponent(id)}`, body);
  }
  deleteAccessProfile(id: string) {
    return this.req<{ deleted: string }>('DELETE', `/api/v1/profiles/access/${encodeURIComponent(id)}`);
  }

  health() { return this.req<Health>('GET', '/api/v1/health'); }
  // spec §6: CONDITIONAL read. The ETag of the last 200 goes back as If-None-Match and a 304 answers
  // with the list already in hand, so a poll that changed nothing costs no body. The validator is the
  // catalog revision, which is GLOBAL — hence the cache is dropped on login/logout.
  async cameras(): Promise<Camera[]> {
    const r = await this.reqRaw('GET', '/api/v1/cameras', undefined,
      this.camerasEtag ? { 'if-none-match': this.camerasEtag } : undefined);
    if (r.status === 304) return this.camerasCache ?? [];
    if (r.status < 200 || r.status >= 300) throw httpError(r.status, r.data);
    this.camerasEtag = r.etag;
    this.camerasCache = r.data as Camera[];
    return this.camerasCache;
  }
  startScan(body: { kind?: string; scope?: ScanScope; credential?: { username: string; password: string } }) { return this.req<ScanStart>('POST', '/api/v1/discovery/scan', body); } // answers at once {scan_id, state:'running'}
  scanStatus(id: string) { return this.req<Scan>('GET', `/api/v1/discovery/scans/${encodeURIComponent(id)}`); }
  discoveryResults() { return this.req<Discovery[]>('GET', '/api/v1/discovery/results'); }
  addCamera(body: { name: string; addresses?: Address[]; source?: string; credential?: { username: string; password: string }; profiles?: { name: string; source: string; recording_mode?: string }[]; recording_mode?: string; added_via?: string; device?: { kind: string }; channels?: number[] }) { return this.req<Camera>('POST', '/api/v1/devices', body); }
  // Multi-channel device (spec 2026-10-17): the parent catalog, the on-demand classification and the resync.
  devices() { return this.req<Device[]>('GET', '/api/v1/devices'); }
  deviceChannels(body: { ip: string; port?: number | null; credential: { username: string; password: string } }) {
    return this.req<DeviceChannels>('POST', '/api/v1/devices/channels', body);
  }
  syncDevice(id: string) { return this.req<{ device: Device; cameras: Camera[]; missing: string[]; channels: number[] }>('POST', `/api/v1/devices/${encodeURIComponent(id)}/sync`); }
  // spec 2026-10-17 (item 1.3): the DVR behaves like a folder — the three tree operations.
  renameDevice(id: string, name: string) { return this.req<Device>('PATCH', `/api/v1/devices/${encodeURIComponent(id)}`, { name }); }
  moveDevice(id: string, group_id: string | null) { return this.req<Device>('PATCH', `/api/v1/devices/${encodeURIComponent(id)}`, { group_id }); }
  deleteDevice(id: string) { return this.req<{ deleted: string; cameras: string[] }>('DELETE', `/api/v1/devices/${encodeURIComponent(id)}`); }
  // spec 2026-10-19: ASYNCHRONOUS SEND — returns the job in 'queued' at once; progress runs in the worker.
  exportRange(body: { stream_profile_id: string; from: number; to: number; description: string }) { return this.req<ExportJob>('POST', '/api/v1/archive/export', body); }
  exports() { return this.req<ExportJob[]>('GET', '/api/v1/exports'); }
  // spec 2026-10-23 (deletion/batch download): the deletion batch and the package URL. The URL carries the
  // token in the query for the same reason as the media routes (the browser downloads without a header).
  deleteExports(ids: string[]) { return this.req<{ deleted: string[]; missing: string[] }>('DELETE', '/api/v1/exports', { ids }); }
  exportsZipUrl(ids: string[]) {
    return `${this.base}/api/v1/exports/zip?ids=${ids.map(encodeURIComponent).join(',')}&token=${encodeURIComponent(this.token ?? '')}`;
  }
  layouts() { return this.req<Layout[]>('GET', '/api/v1/layouts'); }
  saveLayout(layout: { id?: string | null; name: string; cells: Cell[] }) { return this.req<Layout>('POST', '/api/v1/layouts', layout); } // upsert; null id is a new layout (the server draws one); returns the saved layout
  deleteLayouts(ids: string[]) { return this.req<{ deleted: string[] }>('DELETE', '/api/v1/layouts', { ids }); } // batch; one id = [id]
  rtsp() { return this.req<Rtsp>('GET', '/api/v1/rtsp'); } // re-streaming state: {enabled, port, active}

  timeline({ stream_profile_id, from, to, bucket_seconds = 60 }: { stream_profile_id?: string; from: number; to: number; bucket_seconds?: number }) {
    const qs = new URLSearchParams({ stream_profile_id: String(stream_profile_id), from: String(from), to: String(to), bucket_seconds: String(bucket_seconds) });
    return this.req<Timeline>('GET', `/api/v1/archive/timeline?${qs}`);
  }

  events({ since = 0, limit = 100 }: { since?: number; limit?: number } = {}) {
    const qs = new URLSearchParams({ since: String(since), limit: String(limit) });
    return this.req<{ events: Event[]; server_ts: number }>('GET', `/api/v1/events?${qs}`);
  }

  // Live read token for WebRTC (spec 2026-10-16): the browser does not have the operator
  // password, so it asks for the WHEP URL and a short token bound to the profile path. The token
  // goes in the QUERY of the signaling POST — that is how mediamtx hands it to the callback.
  liveToken(profileId: string) {
    return this.req<{ whep_url: string; token: string; expires_in: number }>(
      'POST', '/api/v1/live/token', { profile_id: profileId });
  }

  profiles() { return this.req<StreamProfile[]>('GET', '/api/v1/profiles'); }
  cameraProfiles(id: string) { return this.req<StreamProfile[]>('GET', `/api/v1/cameras/${encodeURIComponent(id)}/profiles`); }
  cameraConfig(id: string) { return this.req<CameraConfig>('GET', `/api/v1/cameras/${encodeURIComponent(id)}/config`); }
  cameraBrands() { return this.req<Brand[]>('GET', '/api/v1/camera-brands'); }
  cameraOnvifRefresh(id: string, body?: { probe?: boolean }) { return this.req<CameraConfig>('POST', `/api/v1/cameras/${encodeURIComponent(id)}/onvif-refresh`, body ?? {}); }
  // PTZ: on-demand capability (the server probes the device and caches it), movement and stop
  // `refresh` asks for revalidation (spec 2026-10-17, section 2): live opens with the re-measured capability
  ptzCapability(id: string, refresh?: boolean) {
    return this.req<PtzCapability>('GET', `/api/v1/cameras/${encodeURIComponent(id)}/ptz${refresh ? '?refresh=1' : ''}`);
  }
  ptzMove(id: string, v: PtzVector) { return this.req<{ ok: boolean }>('POST', `/api/v1/cameras/${encodeURIComponent(id)}/ptz/move`, v); }
  ptzStop(id: string) { return this.req<{ ok: boolean }>('POST', `/api/v1/cameras/${encodeURIComponent(id)}/ptz/stop`); }
  // Saved positions (spec 2026-10-17): the list, save, go/rename/delete.
  // The read is viewer; the other four are operator (the server refuses with 403 and the mode disarms).
  // The body carries `position` (the position `id`), NEVER `id`: the server router mixes path params
  // and the camera `id` would win the body key (amendment E6).
  ptzPositions(id: string) { return this.req<{ positions: PtzPosition[]; error?: string | null }>('GET', `/api/v1/cameras/${encodeURIComponent(id)}/ptz/positions`); }
  ptzSavePosition(id: string) { return this.req<{ id: number; name: string }>('POST', `/api/v1/cameras/${encodeURIComponent(id)}/ptz/positions`); }
  ptzGoToPosition(id: string, position: number) { return this.req<{ ok: boolean }>('POST', `/api/v1/cameras/${encodeURIComponent(id)}/ptz/positions/goto`, { position }); }
  ptzRenamePosition(id: string, position: number, name: string) { return this.req<{ id: number; name: string }>('PATCH', `/api/v1/cameras/${encodeURIComponent(id)}/ptz/positions`, { position, name }); }
  ptzDeletePosition(id: string, position: number) { return this.req<{ ok: boolean }>('DELETE', `/api/v1/cameras/${encodeURIComponent(id)}/ptz/positions`, { position }); }
  // Zoom into the marked area (spec 2026-10-18): the box goes normalized against the SHOWN video and
  // `aspect` is the one of the displayed frame — the cell may be on the secondary profile, whose
  // format differs from the primary, and the server cannot know which one is on screen (amendment E3).
  ptzZoomArea(id: string, box: { left: number; top: number; right: number; bottom: number; aspect: number }) {
    return this.req<{ ok: boolean }>('POST', `/api/v1/cameras/${encodeURIComponent(id)}/ptz/viewport-zoom`, box);
  }
  // NX's `ptzUnzoom` (spec 5.4): back to the position before the first area zoom of the session.
  ptzUndoZoom(id: string) { return this.req<{ ok: boolean }>('POST', `/api/v1/cameras/${encodeURIComponent(id)}/ptz/viewport-unzoom`); }
  setCameraManufacturer(id: string, name: string) { return this.req<CameraConfig>('POST', `/api/v1/cameras/${encodeURIComponent(id)}/manufacturer`, { name }); }
  addProfile(id: string, body: { name: string; source: string; recording_mode?: string }) { return this.req<StreamProfile>('POST', `/api/v1/cameras/${encodeURIComponent(id)}/profiles`, body); }
  deleteProfile(id: string, profileId: string) { return this.req<{ deleted: string }>('DELETE', `/api/v1/cameras/${encodeURIComponent(id)}/profiles`, { profile_id: profileId }); }
  onvifSync(id: string) { return this.req<OnvifSync>('POST', `/api/v1/devices/${encodeURIComponent(id)}/onvif`); }
  groups() { return this.req<Group[]>('GET', '/api/v1/groups'); }
  createGroup(body: { name: string; parent_id?: string | null }) { return this.req<Group>('POST', '/api/v1/groups', body); }
  updateGroup(id: string, body: { name?: string; parent_id?: string | null }) { return this.req<Group>('PATCH', `/api/v1/groups/${encodeURIComponent(id)}`, body); }
  deleteGroup(id: string) { return this.req<{ deleted: string }>('DELETE', `/api/v1/groups/${encodeURIComponent(id)}`); }
  renameCamera(id: string, name: string) { return this.req<Camera>('PATCH', `/api/v1/cameras/${encodeURIComponent(id)}`, { name }); }
  moveCamera(id: string, group_id: string | null) { return this.req<Camera>('PATCH', `/api/v1/cameras/${encodeURIComponent(id)}`, { group_id }); }
  settings() { return this.req<Settings>('GET', '/api/v1/settings'); }
  settingsPatch(body: { retention_days?: number; disk_max_percent?: number }) {
    return this.req<Settings>('PATCH', '/api/v1/settings', body);
  }
  // Spec 2026-10-23: the recording mode and the sensitivity travel in the same camera PATCH.
  // Spec 2026-10-27: `ativa` (camera ativa) travels in the same PATCH.
  setCameraOptions(id: string, body: { recording?: boolean; recording_mode?: 'continuous' | 'motion'; motion_sensitivity?: number; ativa?: boolean }) {
    return this.req<Camera>('PATCH', `/api/v1/cameras/${encodeURIComponent(id)}`, body);
  }
  deleteCamera(id: string) { return this.req<{ deleted: string }>('DELETE', `/api/v1/cameras/${encodeURIComponent(id)}`); }
}

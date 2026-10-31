'use strict';
// ponytail: env-only config, no schema/validation (M1)
// NOTE: 7001 is the Nx Witness port (a real conflict on this reference host) -> default 7101
const DEFAULT_PORT = 7101;
function loadConfig(env = process.env) {
  return {
    port: +env.OPENVMS_PORT || DEFAULT_PORT,
    dataDir: env.OPENVMS_DATA_DIR || './data',
    // root of the recordings (NFS share in production). Default: <dataDir>/archive — historical behavior.
    archiveDir: env.OPENVMS_ARCHIVE_DIR || '',
    wsddMulticast: '239.255.255.250',
    wsddPort: 3700,
    segmentSeconds: +env.OPENVMS_SEGMENT || 300, // 5 min chunk (spec 2026-10-16: 30 min delayed the 1st playable piece)
    hello: env.OPENVMS_HELLO,
    live: env.OPENVMS_LIVE === '1',
    // Hub (spec 2026-10-16): paths published by the API and HLS read by the proxy, both on loopback
    hubApiUrl: env.OPENVMS_HUB_API || 'http://127.0.0.1:9997',
    // Hub WebRTC (spec 2026-10-16): public base and the mediamtx listener port. Without
    // OPENVMS_WEBRTC_URL the base comes from the request's own host (see server/api/live.js).
    webrtcUrl: env.OPENVMS_WEBRTC_URL || null,
    webrtcPort: +env.OPENVMS_WEBRTC_PORT || 8890,
    hubStartTimeout: env.OPENVMS_HUB_START_TIMEOUT || '10s',
    hubCloseAfter: env.OPENVMS_HUB_CLOSE_AFTER || '10s',
    hubReconcileMs: +env.OPENVMS_HUB_RECONCILE_MS || 30000,
    // ponytail: OPENVMS_RETENTION_DAYS and OPENVMS_INGEST are gone (spec 2026-10-15) — the retention
    // days and the recording on/off switch are PER CAMERA (Recording tab), defaulting to 3 days.
    retentionBytes: +env.OPENVMS_RETENTION_BYTES || 0,
    rtsp: env.OPENVMS_RTSP !== '0', // ponytail: mandatory feature — on by default; OPENVMS_RTSP=0 disables it
    rtspPort: +env.OPENVMS_RTSP_PORT || 8554,
    rtspPublish: env.OPENVMS_RTSP_PUBLISH || 'rtsp://127.0.0.1:8554',
    // F3 (spec §9): the real IP only behind a trusted proxy, and Origin/CORS with an optional extra list.
    // The front nginx arrives over loopback and does NOT need trustProxy (its origin is already local).
    trustProxy: env.OPENVMS_TRUST_PROXY === '1',
    allowedOrigins: String(env.OPENVMS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    pgUrl: env.OPENVMS_PG_URL || null,
  };
}
module.exports = { loadConfig, DEFAULT_PORT };

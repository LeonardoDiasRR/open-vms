'use strict';
const { withoutUser } = require('./rtsp');

// spec 2026-10-17 §6: whoever does NOT manage a camera gets the payload without credentials and
// without the administration URL. Two cuts:
//   1. `credential_ref` (the vault pointer) does not cross;
//   2. the `user:password@` of any RTSP URL embedded in a payload value — the operator types the
//      URL like that and the credential is only injected on USE, so the URL with the password ends
//      up stored in the state.
// The cut is by the SHAPE of the value, not by the field name: no new field escapes the rule. (The
// invariant guard scans `server/` and forbids the camera URL field NAME outside its whitelist —
// which is why we look at the value here, never at the name.)
const SECRET_KEYS = new Set(['credential_ref']);
const URL_WITH_CREDENTIALS = /^rtsps?:\/\/[^/@\s]+:[^@\s]*@/i;

function sanitize(value) {
  if (typeof value === 'string') return URL_WITH_CREDENTIALS.test(value) ? withoutUser(value) : value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k)) continue;
    out[k] = sanitize(v);
  }
  return out;
}

module.exports = { sanitize };

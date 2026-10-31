'use strict';
const crypto = require('node:crypto');
const { AppError } = require('./errors');
// mirrors the state machine in ENTIDADES.md
const VALID_TRANSITIONS = {
  provisioning: ['online', 'offline', 'error'],
  online: ['degraded', 'offline', 'error'],
  degraded: ['online', 'offline'],
  offline: ['online', 'error'],
  error: ['provisioning'],
};
function newCamera(fields) {
  return { id: crypto.randomUUID(), added_via: 'manual', ...fields,
    state: 'provisioning', error_code: null, created_at: new Date().toISOString() };
}
// camera_addresses.address is a text column: the store keeps the address object as JSON and a row
// written by hand may hold a bare host. Both read as the { ip, port, scheme, informada } the routes use.
function addressOf(a) {
  if (a && typeof a === 'object') return a;
  try {
    const v = JSON.parse(a);
    return v && typeof v === 'object' ? v : { ip: String(a) };
  } catch { return { ip: String(a) }; }
}
function transition(camera, to, errorCode) {
  if (!(VALID_TRANSITIONS[camera.state] || []).includes(to)) {
    throw new AppError('camera_transition_invalid', { from: camera.state, to });
  }
  return { ...camera, state: to, error_code: errorCode ?? null, updated_at: new Date().toISOString() };
}
module.exports = { newCamera, transition, VALID_TRANSITIONS, addressOf };

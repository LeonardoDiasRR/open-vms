'use strict';
const crypto = require('node:crypto'), fs = require('node:fs');
// ponytail: stdlib AES-256-GCM (the argon2/libsodium from the TRD stay for M2+)
function seal(secret, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function open(token, key) {
  const raw = Buffer.from(token.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
function loadMasterKey(p) {
  if (fs.existsSync(p)) return fs.readFileSync(p);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(p, key, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return key;
}
module.exports = { seal, open, loadMasterKey };

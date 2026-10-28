'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Append-only audit in JSONL, OUTSIDE the state document (A2): one record per event inside
// `state.json` would bloat the whole document (rewritten on every mutation). F3 (spec §9) also
// records login/failure/logout/reset/change/grant/block — which is why the record is an ALLOWLIST
// plus REDACTION: credentials and tokens never get in, not even by mistake from a future producer.
const AUDIT_FILE = 'audit.jsonl';
const FIELDS = ['actor', 'action', 'target_type', 'target_id', 'outcome', 'metadata'];
const SECRET = /(password|secret|token|hash|cred|authorization)/i;

// ponytail: swaps the VALUE for a marker and keeps the KEY — the record shows a secret field was
// there (useful for auditing) without storing the secret.
function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 3) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

// ponytail: synchronous append — the volume is administrative actions (dozens per day), not
// traffic; one JSON line per event, with the id and the timestamp generated here.
function record(dir, event) {
  if (!dir) return null;
  const e = { id: crypto.randomUUID(), at: new Date().toISOString() };
  for (const c of FIELDS) {
    if (event[c] === undefined) continue;
    e[c] = c === 'metadata' ? redact(event.metadata) : String(event[c]);
  }
  fs.appendFileSync(path.join(dir, AUDIT_FILE), JSON.stringify(e) + '\n');
  return e;
}

module.exports = { record, AUDIT_FILE, FIELDS };

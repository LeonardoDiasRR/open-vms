'use strict';
const { withCredential } = require('./rtsp');
const { randomBytes } = require('node:crypto');
const { seal, open } = require('./credentials');

// Hub SERVICE credential: with it the proxy reads the HLS and the ingest reads the RTSP. Publishing
// the cameras is now the Hub's own job (source + sourceOnDemand), not one of our ffmpegs.
const CRED_ID = 'cred:rtsp-publish';
const PUB_USER = 'ovms-publisher';

// Hub address (spec 2026-10-14). The Hub is the only one that pulls the camera; every internal
// consumer reads from here. The path is composed per segment: `cam/sub` keeps the slash, because
// encoding the whole path would become `cam%2Fsub` and would not match the published path.
function hubPath(publishBase, relPath) {
  const base = String(publishBase || '').replace(/\/+$/, '');
  const parts = String(relPath || '').split('/').filter(Boolean).map(encodeURIComponent);
  return `${base}/${parts.join('/')}`;
}

// ponytail: reuses withCredential from lib/rtsp.js (it already escapes user and password)
function hubUrl(publishBase, cred, relPath) {
  return withCredential(hubPath(publishBase, relPath), cred);
}

function hubApiUrl(base) {
  return String(base || 'http://127.0.0.1:9997').replace(/\/+$/, '');
}

// Random and sealed in the vault (AES-256-GCM); the clear text never reaches the database.
async function ensureCredential(store, key) {
  const current = await store.catalog.credentials.get(CRED_ID);
  if (current && current.secret) return { username: current.username, password: open(current.secret, key) };
  const password = randomBytes(24).toString('hex');
  await store.catalog.credentials.put(CRED_ID, { username: PUB_USER, secret: seal(password, key) });
  return { username: PUB_USER, password };
}

module.exports = { hubPath, hubUrl, hubApiUrl, ensureCredential, CRED_ID, PUB_USER };

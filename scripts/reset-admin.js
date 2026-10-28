#!/usr/bin/env node
'use strict';
// F3 (spec §9): admin recovery is a LOCAL CLI — there is no public recovery endpoint in the
// server (the route is not in the route registry and boot would reject it without a policy, D8).
// The CLI refuses to run while the server is up (the in-memory state would overwrite the file),
// requires OS write privilege on the state file, generates the new password (never in argv — A4),
// audits its own event and kills ALL sessions.
const fs = require('node:fs');
const path = require('node:path');
const { openState } = require('../server/lib/db');
const { loadConfig } = require('../server/lib/config');
const { hashPasswordSync, generateTemporaryPassword } = require('../server/lib/password');
const { record } = require('../server/lib/audit');

async function serverIsUp(base, fetchImpl) {
  try {
    const r = await fetchImpl(`${base}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    return !!(r && r.ok);
  } catch {
    // ponytail: connection refused/timeout = no server. Not an error, it is the expected condition.
    return false;
  }
}

async function resetAdmin({ dataDir, username = 'admin', base = null, fetchImpl = fetch, log = console.log } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const target = base || `http://127.0.0.1:${loadConfig(process.env).port}`;
  if (await serverIsUp(target, fetchImpl)) {
    throw new Error('server is up: stop the API before resetting (the in-memory state wins over disk)');
  }
  const file = path.join(dataDir, 'state.json');
  try { fs.accessSync(file, fs.constants.W_OK); }
  catch { throw new Error(`no write privilege on ${file}`); }
  // `openState` runs the SAME boot migration: the CLI never writes an old document back.
  const state = openState(dataDir);
  if (!state.get().users[username]) throw new Error(`user ${username} does not exist`);
  const temporary = generateTemporaryPassword();
  const secret = hashPasswordSync(temporary);
  state.mutate((m) => {
    const u = m.users[username];
    u.secret_hash = secret;
    u.status = 'active';
    u.must_change_password = true;
    u.credential_version = Number(u.credential_version || 0) + 1;
    m.sessions = {};   // A5: with the server down no live session is legitimate
  });
  record(dataDir, { actor: 'cli:reset-admin', action: 'user.password.reset', target_type: 'user',
    target_id: username, outcome: 'ok', metadata: { source: 'cli', sessions_killed: true,
      temporary_password: temporary } });
  log(`temporary password for ${username}: ${temporary}`);
  log('the change will be required on the next login; active sessions were dropped.');
  return { username, temporary_password: temporary, must_change_password: true };
}

module.exports = { resetAdmin, serverIsUp };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const value = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const dataDir = value('--data-dir') || loadConfig(process.env).dataDir;
  resetAdmin({ dataDir, username: value('--user') || 'admin', base: value('--base') })
    .catch((e) => { console.error('reset failed: ' + e.message); process.exit(1); });
}

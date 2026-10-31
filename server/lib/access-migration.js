'use strict';
const { createSystemProfiles, ROLE_MAP } = require('./access');

// One-way migration from the ordinal model (role) to the profile model (spec 2026-10-17 §11), in
// the same pattern as `walls -> layouts` in db.js: it runs on load and is IDEMPOTENT through the
// schema version, and the caller persists ONCE. Interrupted halfway, the disk stays in the old
// COMPLETE state (the store's `.tmp` + rename guarantees it) — never mixed.
const SCHEMA_VERSION = 2;

function migrateAccess(doc, now = new Date().toISOString()) {
  if (Number(doc.schema_version || 0) >= SCHEMA_VERSION) return { changed: false, events: [], disabled: [] };
  const events = [];
  const disabled = [];
  createSystemProfiles(doc, now);
  for (const u of Object.values(doc.users || {})) {
    const profile = ROLE_MAP[u.role];
    if (!profile) {
      // A5: no role or an invalid role -> disabled + audit record. The `role || 'viewer'` fallback
      // dies here. profile_id stays at the weakest one because the user NEVER points at a missing
      // profile (§5) — the `status` is what blocks access.
      u.profile_id = 'viewer';
      u.status = 'disabled';
      disabled.push(u.username);
      events.push({
        actor: 'migration', action: 'user.disabled', target_type: 'user', target_id: u.username,
        outcome: 'ok', metadata: { reason: u.role ? 'invalid role' : 'no role', role: u.role || null },
      });
    } else {
      u.profile_id = profile;
      u.status = u.status === 'disabled' ? 'disabled' : 'active';
    }
    delete u.role;
    u.credential_version = Number(u.credential_version || 0) + 1;
    u.updated_at = now;
  }
  // A4: every session drops at once — that is what makes the profile/ACL switch safe without
  // converting any session.
  doc.sessions = {};
  doc.schema_version = SCHEMA_VERSION;
  // The event order cannot depend on the key order of the input document (which is arbitrary): the
  // audit is fail-closed and has to be reproducible between runs.
  events.sort((a, b) => a.target_id.localeCompare(b.target_id));
  return { changed: true, events, disabled };
}

module.exports = { migrateAccess, SCHEMA_VERSION, ROLE_MAP };

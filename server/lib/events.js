'use strict';
// Events live in the store now: retention is the config key `events.retention_days` and runs as a
// prune job, so there is no in-memory ceiling to trim against.
async function appendEvent(store, { kind, severity = 'info', message, camera_id = null, profile_id = null }) {
  // ponytail: ts strictly increasing in seconds - `events` orders by ts DESC, and a random uuid
  // tiebreaker would shuffle two events written in the same second.
  const now = Math.floor(Date.now() / 1000);
  const [last] = await store.ops.events.list({ limit: 1 });
  // Number(): `events.ts` is a bigint, which pg hands back as a string - `+ 1` would concatenate.
  const lastTs = last ? Number(last.ts) : 0;
  return store.ops.events.append({
    ts: lastTs >= now ? lastTs + 1 : now,
    kind,
    severity,
    message,
    camera_id,
    profile_id,
  });
}

async function listEvents(store, { since = 0, limit = 100 } = {}) {
  return store.ops.events.list({ since, limit });
}

async function pruneEvents(store, days) {
  return store.ops.events.prune(days);
}

module.exports = { appendEvent, listEvents, pruneEvents };

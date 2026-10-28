'use strict';
const { listEvents } = require('../lib/events');
const { AppError } = require('../lib/errors');
// ponytail: thin read route over listEvents — no SSE, no subscription; the UI polls.
// Events live in the store now, and retention is the `events.retention_days` prune job, so there is
// no in-memory ceiling to clamp the page against.
function eventRoutes(store) {
  return {
    'GET /api/v1/events': async ({ since = 0, limit = 100 } = {}) => {
      let events;
      try {
        // the store coerces the query strings and validates the limit (1..1000)
        events = await listEvents(store, { since, limit });
      } catch (e) {
        // a bad limit is the caller's mistake: the published code leaves as 400, not as a 500
        if (e.code !== 'limit_invalid') throw e;
        throw Object.assign(new AppError(e.code), { status: 400 });
      }
      return { events, server_ts: Math.floor(Date.now() / 1000) };
    },
  };
}
module.exports = { eventRoutes };

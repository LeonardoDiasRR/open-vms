'use strict';
const { transition } = require('./cameras');
const { appendEvent } = require('./events');
const { pathState, listSessions, kickSession } = require('./hub-config');

// The camera state describes what the HUB does (spec 2026-10-16). No polling: the signal comes from
// the mediamtx auth callback (read attempt) and from ONE delayed check per camera.
const SUB_SUFFIX = '/sub';
const SLACK_S = 5; // window of case 2 = Hub startTimeout + this slack

function cameraForPath(relPath) {
  const p = String(relPath || '');
  return p.endsWith(SUB_SUFFIX) ? p.slice(0, -SUB_SUFFIX.length) : p;
}

function windowMs(conf) {
  const s = Number(String((conf && conf.hubStartTimeout) || '10s').replace(/s$/, ''));
  return ((Number.isFinite(s) ? s : 10) + SLACK_S) * 1000;
}

function createStateWatcher({ store, conf, hubApi, read = pathState }) {
  const pending = new Map(); // camera ID -> single check timer (<id> and <id>/sub count as one)
  const window = windowMs(conf);

  // Read-then-write instead of one atomic mutation: the dedupe lives on the row just read, so the
  // event still fires only on a real change. ponytail: no lock — two checks of the same camera are
  // already deduped by `pending`, and the next read sees whatever won this race.
  const apply = async (relPath, target, errorCode, message) => {
    const id = cameraForPath(relPath);
    const cam = await store.catalog.cameras.get(id);
    if (!cam || cam.state === target) return false; // unknown or already in this state: nothing changes
    // error -> online has no direct edge: it goes through provisioning before the same write
    const next = cam.state === 'error' && target === 'online'
      ? transition(transition(cam, 'provisioning'), 'online')
      : transition(cam, target, errorCode);
    await store.catalog.cameras.setStates([{ id, state: next.state, error_code: next.error_code }]);
    await appendEvent(store, {
      kind: 'camera', severity: target === 'online' ? 'info' : 'error', message, camera_id: id,
    });
    return true;
  };

  const verify = async (relPath) => {
    // the primary first: ready on it, the /sub needs no other query
    const ready = (await read(hubApi, relPath)) || (await read(hubApi, relPath + SUB_SUFFIX));
    return ready
      ? apply(relPath, 'online', null, 'camera online')
      : apply(relPath, 'offline', 'timeout', 'camera offline: no video in the window');
  };

  return {
    // AUTHORIZED read: schedules a check (the Hub window ends before we look)
    readAttempt(relPath) {
      const id = cameraForPath(relPath);
      if (!id || pending.has(id)) return; // reads of the SAME camera = ONE check
      const t = setTimeout(() => { pending.delete(id); verify(relPath).catch(() => {}); }, window);
      t.unref?.(); // like the PTZ dead-man: the watcher does not hold the process
      pending.set(id, t);
    },
    // read REFUSED by credential (401 from our callback, with a user/service credential or a token)
    // The auth callback fires this and forgets, so a failed write must not surface as an unhandled
    // rejection in the request that is already answering mediamtx.
    readRefused(relPath, reason) {
      return apply(relPath, 'error', 'auth_failed', `camera error: ${reason || 'auth_failed'}`)
        .catch(() => {});
    },
    // §8: revoking access cuts the stream IN PROGRESS. The WHEP session does not carry the OpenVMS
    // user identity (`user` comes empty), so the cut is BY PATH: it expels every consumer of the
    // given paths and PRESERVES the service credential (the ingest worker reads the same path).
    async disconnectConsumers(paths, { preserve } = {}) {
      const targets = new Set((paths || []).map(cameraForPath));
      const kicked = [];
      for (const s of await listSessions(hubApi)) {
        if (!targets.has(cameraForPath(s.path))) continue;
        if (preserve && s.user === preserve) continue;
        await kickSession(hubApi, s.type, s.id).catch(() => {});
        kicked.push(s.id);
      }
      return kicked;
    },
    // exposed so the test can measure the window without depending on the clock
    windowMs: window,
  };
}

module.exports = { createStateWatcher, cameraForPath, windowMs };

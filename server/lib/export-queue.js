'use strict';
// spec 2026-10-19 (video-export): the queue of export jobs. Pure logic: `run` is injected (in
// main.js it is a real worker_thread; in the test, a Promise). The queue knows no worker, no ffmpeg
// and no file system: only the ceiling, the order and the job state in `store.ops.exports`.

// createExportQueue({ limit, run, store }):
//  - submit(jobId, payload): keeps the payload outside the database and tries to start;
//  - when `active < limit`, it fires run(jobId, payload, onProgress);
//  - onProgress(pct) writes state 'exporting' + progresso (monotonicity is the worker's job);
//  - Promise resolving -> 'ready' (+path, bytes, progresso 100); rejecting -> 'error' + message;
//  - when it ends the slot frees itself and the queue advances (recursive drain).
// ponytail: 'queued'/'exporting'/'ready'/'error' are persisted job states the client already reads
function createExportQueue({ limit, run, store }) {
  const queue = [];
  const payloads = new Map(); // jobId -> { fragments, dest } — the payload never enters the database
  const writes = new Map(); // jobId -> promise chain of the writes already queued for that job
  let active = 0;

  // One chain per job: two puts in flight could commit out of order and regress `progresso`.
  function write(jobId, fields) {
    const chain = (writes.get(jobId) || Promise.resolve())
      .catch(() => {}) // a failed write must not swallow the next state
      .then(() => store.ops.exports.put(jobId, fields));
    writes.set(jobId, chain);
    return chain;
  }

  function drain() {
    while (active < limit && queue.length) {
      const jobId = queue.shift();
      const payload = payloads.get(jobId);
      active++;
      Promise.resolve()
        .then(() => run(jobId, payload, (progresso) => {
          write(jobId, { state: 'exporting', progresso }).catch(() => {});
        }))
        .then((out) => write(jobId, { state: 'ready', progresso: 100, path: out.path, bytes: out.bytes }))
        .catch((e) => write(jobId, { state: 'error', error: e && e.message ? e.message : String(e) }))
        .catch(() => {}) // a database error must not leak the slot: the job still has to leave the queue
        .finally(() => { active--; writes.delete(jobId); payloads.delete(jobId); drain(); });
    }
  }
  return {
    submit(jobId, payload) { payloads.set(jobId, payload); queue.push(jobId); drain(); },
    get active() { return active; },
  };
}

// Boot: workers die with the process; a persisted job that never finished lies about its state.
// Runs once at boot (main.js), before any queue exists; the repository owns the transition.
async function sweepPendingJobs(store) {
  await store.ops.exports.sweepPending();
}

module.exports = { createExportQueue, sweepPendingJobs };

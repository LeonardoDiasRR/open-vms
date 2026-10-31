'use strict';
// Write-behind of the media index (plan 2026-10-20, T5). Recording changes the index; this queue turns
// those changes into one UPSERT per profile a couple of seconds later. The index is DERIVED from disk:
// a failed write is logged and retried on the next change, and it never reaches the recorder, the HTTP
// handler or the process.
const DEBOUNCE_MS = 2000;

function createMediaPersist({ media, index, debounceMs = DEBOUNCE_MS, log = console }) {
  const dirty = new Set();
  let timer = null;
  let busy = false;

  // Writes every profile marked since the last pass. Returns how many rows went out.
  async function flush() {
    if (busy || !dirty.size) return 0;
    busy = true;
    const profiles = [...dirty];
    dirty.clear();
    let written = 0;
    try {
      for (const profile of profiles) {
        written += await media.upsertHours(index.snapshot(profile));
        // Persisted: the fragments of the hours that are not being recorded go back to the database
        // only (plan 2026-10-20). The index keeps their coverage and count.
        index.release(profile);
      }
      return written;
    } catch (err) {
      for (const profile of profiles) dirty.add(profile);   // disk is the truth: retry on the next change
      log.warn('media: persist failed: ' + err.message);
      return 0;
    } finally {
      busy = false;
    }
  }

  // Called by the index hook. Cheap on purpose: it runs inside the 500 ms scan.
  function touch(profile) {
    if (!profile) return;
    dirty.add(profile);
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, debounceMs);
    if (timer.unref) timer.unref();
  }

  // Shutdown: what is pending is written before the pool goes away.
  async function close() {
    if (timer) clearTimeout(timer);
    timer = null;
    await flush();
  }

  return { touch, flush, close, get pending() { return dirty.size; } };
}

module.exports = { createMediaPersist, DEBOUNCE_MS };

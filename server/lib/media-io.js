'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

// A bounded pool owns all synchronous MP4/NFS reads. Coalescing is per file and resume offset.
function createMediaIo({ concurrency = 2, maxQueued = 64, timeoutMs = 15000,
  workerFile = path.join(__dirname, 'media-io-worker.js') } = {}) {
  const queue = [], pending = new Map(), slots = new Set(), latencies = [];
  let serial = 0, closed = false, failures = 0;
  function settle(slot, error, out) {
    const task = slot.task; if (!task) return;
    clearTimeout(slot.timer); slot.task = null; pending.delete(task.key);
    latencies.push(performance.now() - task.started); if (latencies.length > 256) latencies.shift();
    if (error) { failures++; task.reject(error); } else task.resolve(out);
  }
  function spawn() {
    const slot = { worker: new Worker(workerFile), task: null, timer: null };
    slots.add(slot); slot.worker.unref();
    slot.worker.on('message', message => {
      if (!slot.task || slot.task.id !== message.id) return;
      settle(slot, message.error ? Object.assign(new Error(message.error), { code: message.code }) : null, message.out);
      pump();
    });
    slot.worker.on('error', error => { settle(slot, error); });
    slot.worker.on('exit', () => {
      settle(slot, new Error('media worker exited')); slots.delete(slot);
      if (!closed) pump();
    });
    slot.worker.unref();
    return slot;
  }
  function pump() {
    if (closed) return;
    while (queue.length) {
      const slot = [...slots].find(s => !s.task && !s.retiring) || (slots.size < concurrency ? spawn() : null);
      if (!slot) return;
      slot.task = queue.shift(); slot.task.started = performance.now();
      slot.timer = setTimeout(() => {
        settle(slot, new Error('media worker timeout'));
        // Do not create another NFS reader until this thread actually terminates.
        slot.retiring = true; void slot.worker.terminate();
      }, timeoutMs);
      slot.worker.postMessage(slot.task.payload);
    }
  }
  function scan(file, options = {}) {
    if (closed) return Promise.reject(new Error('media pool closed'));
    const key = JSON.stringify([file, options]);
    if (pending.has(key)) return pending.get(key);
    if (queue.length >= maxQueued) return Promise.reject(new Error('media queue full'));
    const id = ++serial;
    const promise = new Promise((resolve, reject) => queue.push({ id, key, resolve, reject,
      payload: { id, file, options }, started: performance.now() }));
    pending.set(key, promise); pump(); return promise;
  }
  async function close() {
    closed = true;
    for (const task of queue.splice(0)) { pending.delete(task.key); task.reject(new Error('media pool closed')); }
    for (const slot of slots) settle(slot, new Error('media pool closed'));
    await Promise.all([...slots].map(s => s.worker.terminate()));
  }
  return { scan, close, stats: () => {
    const sorted = [...latencies].sort((a, b) => a - b);
    return { active: [...slots].filter(s => s.task).length, queued: queue.length, failures,
      parse_p95_ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0 };
  } };
}

module.exports = { createMediaIo };

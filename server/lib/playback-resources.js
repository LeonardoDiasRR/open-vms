'use strict';
const { monitorEventLoopDelay } = require('node:perf_hooks');

function monitorPlaybackResources({ io, transcoder, log = console.log, everyMs = 30000 }) {
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  const snapshot = () => ({ kind: 'playback.resources', at: Date.now(),
    event_loop_p95_ms: delay.percentile(95) / 1e6, rss_bytes: process.memoryUsage().rss,
    io: io.stats(), transcoder: transcoder.stats?.() });
  const timer = setInterval(() => { log(JSON.stringify(snapshot())); delay.reset(); }, everyMs);
  timer.unref();
  return { snapshot, close: () => { clearInterval(timer); delay.disable(); } };
}

module.exports = { monitorPlaybackResources };

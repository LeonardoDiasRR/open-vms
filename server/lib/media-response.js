'use strict';
const fs = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('./errors');

function byteRange(header, bytes) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !(match[1] || match[2])) return false;
  const first = match[1] ? Number(match[1]) : Math.max(0, bytes - Number(match[2]));
  const last = match[1] && match[2] ? Math.min(Number(match[2]), bytes - 1) : bytes - 1;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || first > last || first >= bytes) return false;
  return { first, last };
}

async function mediaResponse(req, res, out, headers) {
  let handle;
  try {
    const range = byteRange(req.headers.range, out.bytes);
    if (range === false) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${out.bytes}` }); res.end(); return;
    }
    handle = await fs.open(out.path, 'r');
    if (req.aborted || res.destroyed) return;
    const base = { ...headers, 'accept-ranges': 'bytes' };
    const bounds = range || { first: 0, last: out.bytes - 1 };
    res.writeHead(range ? 206 : 200, { ...base, 'content-length': Math.max(0, bounds.last - bounds.first + 1),
      ...(range ? { 'content-range': `bytes ${bounds.first}-${bounds.last}/${out.bytes}` } : {}) });
    if (!out.bytes) { res.end(); return; }
    await pipeline(handle.createReadStream({ start: bounds.first, end: bounds.last, autoClose: false }), res);
  } catch (e) {
    if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
    if (e.code === 'ENOENT') throw new AppError(out.release ? 'media_temporarily_unavailable' : 'hour_file_missing');
    throw e;
  } finally { await handle?.close().catch(() => {}); out.release?.(); }
}

module.exports = { byteRange, mediaResponse };

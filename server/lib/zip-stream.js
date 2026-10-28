'use strict';
// spec 2026-10-23 (batch deletion/download, section 4): ZIP in STREAMING mode, with no dependency.
// STORE (mp4 does not compress) + data descriptor (bit 3): size and CRC are only known at the end of the
// copy. Constant memory: one 64 KB buffer per read, backpressure through `drain`.
const fs = require('node:fs');
const { once } = require('node:events');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf, seed = 0) {
  let c = seed ^ -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

// Does not close the stream: whoever writes decides when to end (the route calls `out.end()` on the pipe).
async function writeZip(out, entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('zip entries empty');
  const central = [];
  let offset = 0;
  const write = async (buf) => {
    if (buf.length === 0) return;
    offset += buf.length;
    if (!out.write(buf)) await once(out, 'drain');
  };

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const stat = fs.statSync(e.path); // ENOENT propagates to the caller
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x08, 6);
    h.writeUInt16LE(0, 8); h.writeUInt16LE(0, 10);
    h.writeUInt16LE(dosTime(stat.mtime), 12); h.writeUInt16LE(dosDate(stat.mtime), 14);
    h.writeUInt32LE(0, 16); h.writeUInt32LE(0, 18); h.writeUInt32LE(0, 20);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    const startOffset = offset;
    await write(h); await write(name);

    let crc = 0, size = 0;
    const fd = fs.openSync(e.path, 'r');
    try {
      for (;;) {
        // a NEW buffer per block: the stream keeps the chunk reference, so with backpressure
        // the next readSync would overwrite bytes not yet sent (measured: wrong CRC in the ZIP).
        const chunk = Buffer.allocUnsafe(64 * 1024);
        const n = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (!n) break;
        const piece = chunk.subarray(0, n);
        crc = crc32(piece, crc); size += n;
        await write(piece);
      }
    } finally { fs.closeSync(fd); }

    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc, 4);
    d.writeUInt32LE(size, 8); d.writeUInt32LE(size, 12);
    await write(d);
    central.push({ name, crc, size, offset: startOffset, time: dosTime(stat.mtime), date: dosDate(stat.mtime) });
  }

  const cdIni = offset;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0x08, 8); h.writeUInt16LE(0, 10);
    h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14);
    h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.size, 20); h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28); h.writeUInt16LE(0, 30); h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36); h.writeUInt32LE(0, 38);
    h.writeUInt32LE(c.offset, 42);
    await write(h); await write(c.name);
  }
  const cdTam = offset - cdIni;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdTam, 12); end.writeUInt32LE(cdIni, 16); end.writeUInt16LE(0, 20);
  await write(end);
  return { entries: central.length, bytes: offset };
}

module.exports = { writeZip, crc32 };

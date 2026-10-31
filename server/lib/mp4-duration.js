'use strict';

// Walk only metadata containers; never inspect compressed mdat payloads.
function children(buf, start = 0, end = buf.length) {
  const out = [];
  for (let off = start; off + 8 <= end;) {
    let size = buf.readUInt32BE(off), header = 8;
    if (size === 1) { if (off + 16 > end) break; size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    if (!size) size = end - off;
    if (size < header || off + size > end) break;
    out.push({ type: buf.toString('ascii', off + 4, off + 8), body: off + header, end: off + size });
    off += size;
  }
  return out;
}

function defaultDuration(buf) {
  let result = 0;
  const walk = (start, end) => {
    for (const box of children(buf, start, end)) {
      if (box.type === 'trex' && box.body + 16 <= box.end) result = buf.readUInt32BE(box.body + 12);
      if (box.type === 'moov' || box.type === 'mvex') walk(box.body, box.end);
    }
  };
  walk(0, buf.length); return result;
}

function fragmentDuration(buf, fallback = 0) {
  let duration = 0;
  const moof = children(buf).find(b => b.type === 'moof');
  for (const traf of moof ? children(buf, moof.body, moof.end).filter(b => b.type === 'traf') : []) {
    const boxes = children(buf, traf.body, traf.end);
    let nominal = fallback;
    const tfhd = boxes.find(b => b.type === 'tfhd');
    if (tfhd && tfhd.body + 8 <= tfhd.end) {
      const flags = buf.readUInt32BE(tfhd.body) & 0xffffff;
      const pos = tfhd.body + 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
      if (flags & 8 && pos + 4 <= tfhd.end) nominal = buf.readUInt32BE(pos);
    }
    for (const trun of boxes.filter(b => b.type === 'trun')) {
      if (trun.body + 8 > trun.end) continue;
      const flags = buf.readUInt32BE(trun.body) & 0xffffff, count = buf.readUInt32BE(trun.body + 4);
      let p = trun.body + 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
      const step = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
      if (count > 1000000 || p + count * step > trun.end) continue;
      if (!(flags & 0x100)) { duration += count * nominal; continue; }
      for (let i = 0; i < count; i++, p += step) duration += buf.readUInt32BE(p);
    }
  }
  return duration;
}

module.exports = { defaultDuration, fragmentDuration };

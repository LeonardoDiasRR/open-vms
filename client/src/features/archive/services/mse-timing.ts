// Read only clock boxes. MSE retains all sample DTS/PTS and composition offsets in segments mode.
function find(bytes: Uint8Array, name: string): number {
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if ([...name].every((c, j) => bytes[i + j] === c.charCodeAt(0))) return i + 4;
  }
  return -1;
}

export function mediaTimescale(bytes: Uint8Array): number {
  const p = find(bytes, 'mdhd');
  if (p < 0) throw new Error('init:timescale');
  const pos = p + (bytes[p] === 1 ? 20 : 12);
  if (pos + 4 > bytes.length) throw new Error('init:timescale');
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(pos);
  if (!n) throw new Error('init:timescale');
  return n;
}

export function decodeTime(data: ArrayBuffer, timescale: number): number {
  const bytes = new Uint8Array(data), p = find(bytes, 'tfdt');
  if (p < 0) throw new Error('fragment:timestamp');
  const view = new DataView(data);
  const n = bytes[p] === 1 ? Number(view.getBigUint64(p + 4)) : view.getUint32(p + 4);
  if (!Number.isSafeInteger(n)) throw new Error('fragment:timestamp');
  return n / timescale;
}

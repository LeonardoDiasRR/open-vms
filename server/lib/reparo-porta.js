'use strict';
// One-time boot repair (spec 2026-10-16): before this fix, discovery signup wrote the fixed port 554
// into the address and the RTSP URLs even when discovery had used another port. This module uses
// what discovery saved (`scans[].scope.ports` and `found`) to fix the URLs already written.
// The rule is narrow on purpose: only the camera whose address stayed on 554 and whose discovery of
// the SAME IP asked for a port other than 554 and found a device. It does NOT look at whether the
// port was operator-informed: signups older than this fix do not carry that flag, and they are
// exactly the ones needing repair.
// In the relational store the address row is the endpoint text (`camera_addresses.address`): a bare
// host means 554 and `host:port` carries it, so the repair rewrites the first address, the
// `profiles.source_url` and `meta.manual`.
const { withPort } = require('./rtsp');
const { addressOf } = require('./cameras');

// Ports the ONVIF "ladder" sweeps (server/lib/onvif.js): finding a device on them proves HTTP/ONVIF
// is there, not that RTSP is. Without this exclusion, an open 80 scan became "RTSP on 80".
const ONVIF_PORTS = new Set([80, 443, 8080, 8899, 8000]);

// A row without a port means the default 554; `port` (object row) or `host:5003` (text row) carries it.
function addressPort(address) {
  const v = addressOf(address);
  if (v.port !== undefined && v.port !== null && v.port !== '') return Number(v.port) || 554;
  const m = /:(\d+)$/.exec(String(v.ip || ''));
  return m ? Number(m[1]) : 554;
}

function addressHost(address) {
  return String(addressOf(address).ip || '').replace(/:\d+$/, '');
}

// The repaired endpoint keeps the SHAPE of the row it replaces: the store writes JSON objects (an
// object in the memory fallback, its text in PostgreSQL) and a hand-written row is `host[:port]`.
function repairedEndpoint(row, ip, port) {
  if (row && typeof row === 'object') return { ...row, ip, port };
  if (typeof row === 'string' && row.trim().startsWith('{')) return JSON.stringify({ ...addressOf(row), ip, port });
  return `${ip}:${port}`;
}

function discoveryPort(ip, scans) {
  const candidates = scans
    .filter((s) => s && s.state === 'done' && Number(s.found) > 0 && s.scope && (s.scope.ips || []).includes(ip))
    .map((s) => ({ when: Date.parse(s.finished_ts) || 0,
      port: (s.scope.ports || []).find((p) => Number(p) !== 554) }))
    .filter((c) => Number(c.port) > 0 && !ONVIF_PORTS.has(Number(c.port)))
    .sort((a, b) => b.when - a.when);
  return candidates.length ? Number(candidates[0].port) : null;
}

// Positive proof that the camera answers on 554: if any scan of the same IP found a device with 554
// among the tested ports, then 554 is NOT wrong and the repair must not touch it.
function hasProofOf554(ip, scans) {
  return scans.some((s) => s && s.state === 'done' && Number(s.found) > 0 &&
    s.scope && (s.scope.ips || []).includes(ip) && (s.scope.ports || []).map(Number).includes(554));
}

async function repairPort(store) {
  const { cameras, profiles } = store.catalog;
  const scans = await store.ops.scans.list();
  const repaired = [];
  for (const listed of await cameras.listCatalog()) {
    const addresses = await cameras.addresses(listed.id);
    if (!addresses.length) continue;
    if (addressPort(addresses[0]) !== 554) continue;
    const cam = await cameras.get(listed.id);
    const ip = addressHost(addresses[0]);
    const own = await profiles.listByCamera(listed.id);
    const manual = (cam.meta || {}).manual || null;
    const hasFiveFiveFour = own.some((p) => String(p.source_url || '').includes(':554')) ||
      String((manual || {}).rtsp_primary || '').includes(':554');
    if (!hasFiveFiveFour) continue;
    const port = discoveryPort(ip, scans);
    if (!port) continue;
    if (hasProofOf554(ip, scans)) continue;
    // The address is the endpoint the rest of the code reads: repair it in the same pass, keeping
    // whatever other addresses the camera has.
    const repairedAddresses = [repairedEndpoint(addresses[0], ip, port), ...addresses.slice(1)];
    await cameras.replaceAddresses(listed.id, repairedAddresses);
    for (const p of own) {
      if (p.onvif_token) continue; // ONVIF hands out the URL: it is not ours to rewrite
      const url = withPort(p.source_url, port);
      if (url !== p.source_url) await profiles.update(p.id, { source_url: url });
    }
    if (manual && (manual.rtsp_primary || manual.rtsp_secondary)) {
      const next = { ...manual };
      if (next.rtsp_primary) next.rtsp_primary = withPort(next.rtsp_primary, port);
      if (next.rtsp_secondary) next.rtsp_secondary = withPort(next.rtsp_secondary, port);
      await cameras.update(listed.id, { meta: { ...(cam.meta || {}), manual: next } });
    }
    repaired.push(listed.id);
  }
  return { repaired };
}

module.exports = { repairPort };

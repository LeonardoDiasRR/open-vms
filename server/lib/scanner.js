'use strict';
const net = require('node:net');
const { AppError } = require('./errors');
const ipToInt = (ip) => ip.split('.').reduce((a, o) => (a << 8) + +o, 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
function cidrIps(cidr) {
  const [ip, prefix] = cidr.split('/').map((v, i) => (i ? +v : v));
  const count = 2 ** (32 - (prefix ?? 32));
  if (count > 1024) throw new AppError('cidr_too_large');
  const base = (ipToInt(ip) >>> (32 - (prefix ?? 32))) << (32 - (prefix ?? 32)) >>> 0;
  return Array.from({ length: count }, (_, i) => intToIp((base + i) >>> 0));
}
const OCTET = String.raw`(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const RE_IP = new RegExp(String.raw`^${OCTET}(\.${OCTET}){3}$`);
const RE_CIDR = new RegExp(String.raw`^${OCTET}(\.${OCTET}){3}/(3[0-2]|[12]?\d)$`);
// DNS host name: labels [a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])? joined by dots; a single label is
// only a host when it carries a hyphen (LAN-style names), so bare words like "localhost" stay out.
const RE_LABEL = String.raw`[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?`;
const RE_HOST_DOTTED = new RegExp(String.raw`^(?:${RE_LABEL}\.)+${RE_LABEL}$`);
const RE_LABEL_ONLY = new RegExp(String.raw`^${RE_LABEL}$`);
function isHostname(v) {
  // total <=253 and no label >63: the DNS limits; garbage like spaces/dots/empty labels fails the regex
  if (v.length > 253 || v.split('.').some((l) => l.length > 63)) return false;
  // a dot makes it a domain; a single label only counts when it carries a hyphen (LAN-style names)
  return v.includes('.') ? RE_HOST_DOTTED.test(v) : (v.includes('-') && RE_LABEL_ONLY.test(v));
}
// ponytail: accepts a single string, an array or a mix; CIDR expanded through cidrIps
function expandIps(input) {
  const out = [];
  for (const raw of Array.isArray(input) ? input : [input]) {
    const v = String(raw ?? '').trim();
    if (RE_CIDR.test(v)) {
      try { out.push(...cidrIps(v)); } catch (e) { throw e instanceof AppError ? e : new AppError('invalid_range', { value: v }); }
    } else if (RE_IP.test(v) || net.isIP(v) === 6 || isHostname(v)) out.push(v);
    else throw new AppError('invalid_range', { value: v });
  }
  if (out.length > 1024) throw new AppError('range_too_large');
  return out;
}
function tryConnect(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
async function scanRange({ ips, ports = [], timeoutMs = 500, concurrency = 128, connect = tryConnect } = {}) {
  const hosts = expandIps(ips);
  const tasks = [];
  for (const ip of hosts) for (const p of ports) tasks.push({ ip, p });
  const open = new Map(hosts.map((ip) => [ip, []]));
  let next = 0;
  // ponytail: index queue; at most `concurrency` simultaneous sockets (avoids EMFILE on /22 x 6 ports)
  const worker = async () => {
    while (next < tasks.length) {
      const { ip, p } = tasks[next++];
      if (await connect(ip, p, timeoutMs)) open.get(ip).push(p);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return hosts.map((ip) => ({ ip, openPorts: open.get(ip).sort((a, b) => a - b) }))
    .filter((r) => r.openPorts.length > 0);
}
module.exports = { cidrIps, expandIps, scanRange };

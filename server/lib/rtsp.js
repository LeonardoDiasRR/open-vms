'use strict';
const { AppError } = require('./errors');

// Injects user:[REDACTED] into the RTSP URL at use time (ffmpeg); the URL with the password is NEVER
// persisted — it only exists in the worker memory. Other sources and URLs that already carry a user
// come back untouched.
function withCredential(source, cred) {
  if (!cred || !cred.username) return source;
  if (typeof source !== 'string' || !/^rtsp:\/\//i.test(source)) return source;
  const rest = source.slice(source.indexOf('//') + 2);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  if (host.includes('@')) return source; // the URL already carries a user; do not overwrite it
  const password = cred.password ? `:${encodeURIComponent(cred.password)}` : '';
  return `rtsp://${encodeURIComponent(cred.username)}${password}@${rest}`;
}

// Redacts user:[REDACTED] from messages/text streams (ffmpeg stderr echoes the input URL).
function withoutCredential(texto) {
  return String(texto).replace(/\/\/[^/\s@]+:[^@\s]*@/g, '//***:***@');
}

// Canonical RTSP paths per brand — fallback when the ONVIF GetStreamUri did not answer.
// Each row cites its source; a brand without a documented source does NOT enter (no invented path).
// Hikvision: measured through GetStreamUri on the DS-2DE4225IW-DE(E) + manufacturer docs.
// Dahua/Imou: getscw.com/decoding/rtsp (subtype 0|1).
// Intelbras: iSpy/Camlytics/SmartVision — the VIP line uses Dahua's realmonitor format.
// Axis: official axis.com FAQ ("base RTSP streaming URL") — the secondary has no canonical path.
// Bosch: STDN "RTSP usage with Bosch VIP Devices" — rtsp_tunnel = stream 1, ?inst=2 = stream 2.
// TP-Link VIGI: official tp-link.com 3718 FAQ — stream1|stream2 on 554.
// Uniview: official uniview.com PDF "How to Get the URLs for Uniview IPC and NVR" — media/video1|2.
// VIVOTEK: camera-sdk/VisioForge base — live.sdp primary, live2.sdp secondary.
const BRANDS = [
  { name: 'Hikvision', test: /hikvision|hiwatch/i, primary: '/Streaming/Channels/101', secondary: '/Streaming/Channels/102' },
  { name: 'Dahua', test: /dahua|imou/i, primary: '/cam/realmonitor?channel=1&subtype=0', secondary: '/cam/realmonitor?channel=1&subtype=1' },
  { name: 'Intelbras', test: /intelbras/i, primary: '/cam/realmonitor?channel=1&subtype=0', secondary: '/cam/realmonitor?channel=1&subtype=1' },
  { name: 'Axis', test: /axis/i, primary: '/axis-media/media.amp', secondary: null },
  { name: 'Bosch', test: /bosch/i, primary: '/rtsp_tunnel', secondary: '/rtsp_tunnel?inst=2' },
  { name: 'TP-Link VIGI', test: /tp-link|vigi/i, primary: '/stream1', secondary: '/stream2' },
  { name: 'Uniview', test: /uniview|\bunv\b/i, primary: '/media/video1', secondary: '/media/video2' },
  { name: 'VIVOTEK', test: /vivotek/i, primary: '/live.sdp', secondary: '/live2.sdp' },
];

// Swaps (or adds) the port of an RTSP URL. A null port returns the URL untouched: whoever did not
// give a port leaves the decision to ONVIF or to the table's 554.
function withPort(url, port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) return url;
  const s = String(url || '');
  if (!/^rtsp:\/\//i.test(s)) return s;
  const i = s.indexOf('//') + 2;
  const rest = s.slice(i);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? '' : rest.slice(slash);
  const noPort = host.replace(/:\d+$/, '');
  return `rtsp://${noPort}:${p}${tail}`;
}

function urlForBrand({ manufacturer = '', model = '', ip, port }) {
  if (!ip) throw new AppError('ip_required');
  const m = BRANDS.find((x) => x.test.test(`${manufacturer} ${model}`)) || { primary: '/', secondary: null };
  const p = Number(port) || 554;
  return { primary: `rtsp://${ip}:${p}${m.primary}`, secondary: m.secondary ? `rtsp://${ip}:${p}${m.secondary}` : null };
}

// Source saved by the wizard when nobody gave a path: 'rtsp://host[:port]' with an empty path or '/'.
// A URL with a user or with a path is the user's deliberate choice.
function isPlaceholder(source) {
  return /^rtsp:\/\/([^@\s]+@)?[^/\s]+(:\d+)?\/?$/i.test(String(source || ''));
}

// Display version: cuts the 'user:password@' without changing the rest of the URL.
function withoutUser(url) {
  if (typeof url !== 'string') return null;
  const i = url.indexOf('//');
  if (i === -1) return url;
  const rest = url.slice(i + 2);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  if (!host.includes('@')) return url;
  return url.slice(0, i + 2) + host.slice(host.lastIndexOf('@') + 1) + (slash === -1 ? '' : rest.slice(slash));
}

// true when the brand has a canonical path in the table; without it, the generic 'rtsp://ip:554/'
// would mask authoritative sources (e.g. Dahua realmonitor without a match)
function isKnownBrand({ manufacturer = '', model = '' } = {}) {
  return BRANDS.some((x) => x.test.test(`${manufacturer} ${model}`));
}

// display names for the "Report manufacturer" combobox (a new row in the table = a new brand there)
function listBrands() { return BRANDS.map((m) => ({ name: m.name })); }

// canonical name -> table row (case-insensitive, tolerates spaces); null = outside the table (the 400 base)
function brandByName(name) {
  const n = String(name || '').trim().toLowerCase();
  return BRANDS.find((x) => x.name.toLowerCase() === n) || null;
}

module.exports = { withCredential, withoutCredential, urlForBrand, isPlaceholder, withoutUser, isKnownBrand, listBrands, brandByName, withPort };

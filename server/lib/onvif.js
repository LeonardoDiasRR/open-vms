'use strict';
const crypto = require('node:crypto');
const { AppError } = require('./errors');

// ponytail: regex XML parsing, same style as server/lib/wsdd.js (no full parser)
// generic namespace prefix: any device may answer ns2:/ns1:/etc (never an allowlist)
const NS = '(?:\\w+:)?';
const SOAP = 'http://www.w3.org/2003/05/soap-envelope';
const ADDR = 'http://www.w3.org/2005/08/addressing';
const TDS = 'http://www.onvif.org/ver10/device/wsdl';
const TRT = 'http://www.onvif.org/ver10/media/wsdl';
const TT = 'http://www.onvif.org/ver10/schema';
const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const PW_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const NONCE_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';
// PTZ service (ver20): PTZ actions use the SAME /onvif/device_service endpoint, with the tptz
// namespace. The full action URI goes in the header (measured against the real camera: that is what
// the device accepts).
const TPTZ = 'http://www.onvif.org/ver20/ptz/wsdl';
// Fault that ASKS for authorization. No HTTP numbers on purpose: "HTTP 401" is no proof of ONVIF —
// any HTTP service answers 401 on /onvif/device_service. The proof is the device answering SOAP.
const RE_AUTH = /not ?authoriz|unauthoriz|authoriz|authentication fail|invalid (password|username|credential)/i;

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// WS-Security digest: base64(sha1(nonce || created || password))
function passwordDigest(nonce, created, pass) {
  return crypto.createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(pass)]))
    .digest('base64');
}

function buildEnvelope({ action, body, user, pass }) {
  let header = '';
  if (user) {
    const nonce = crypto.randomBytes(16);
    const created = new Date().toISOString();
    header = '<s:Header>' +
      (action ? `<a:Action s:mustUnderstand="1">${escapeXml(action)}</a:Action>` : '') +
      `<Security xmlns="${WSSE}"><UsernameToken>` +
      `<Username>${escapeXml(user)}</Username>` +
      `<Password Type="${PW_TYPE}">${passwordDigest(nonce, created, pass || '')}</Password>` +
      `<Nonce EncodingType="${NONCE_TYPE}">${nonce.toString('base64')}</Nonce>` +
      `<Created>${created}</Created>` +
      '</UsernameToken></Security></s:Header>';
  } else if (action) {
    header = `<s:Header><a:Action s:mustUnderstand="1">${escapeXml(action)}</a:Action></s:Header>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="${SOAP}" xmlns:a="${ADDR}" xmlns:tds="${TDS}" xmlns:trt="${TRT}" xmlns:tt="${TT}" xmlns:tptz="${TPTZ}">
${header}
<s:Body>${body}</s:Body>
</s:Envelope>`;
}

function soap(action, profileToken) {
  if (action === 'GetDeviceInformation') return '<tds:GetDeviceInformation/>';
  if (action === 'GetProfiles') return '<trt:GetProfiles/>';
  // GetVideoSources (spec 2026-10-17, fact 2): one <trt:VideoSources> per channel WITH a camera. It
  // is the count that decides whether the device is multi-channel — XMEye OMITS VideoSourceToken in
  // the profiles (fact 3), so grouping profiles by token does NOT work on this device.
  if (action === 'GetVideoSources') return '<trt:GetVideoSources/>';
  if (action === 'GetStreamUri') {
    if (!profileToken) throw new AppError('onvif_profile_token_required');
    return '<trt:GetStreamUri><trt:StreamSetup>' +
      '<tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>' +
      '</trt:StreamSetup>' +
      `<trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken></trt:GetStreamUri>`;
  }
  if (action === 'GetNetworkInterfaces') return '<tds:GetNetworkInterfaces><tds:Info>true</tds:Info></tds:GetNetworkInterfaces>';
  throw new AppError('onvif_action_unsupported', { action });
}

// ponytail: XML is TEXT. A query in a Uri arrives with `&amp;` and stops being XML when it becomes a value.
// One pass, five named entities, no numeric ones, no full parser.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) => (s == null ? s
  : String(s).replace(/&(amp|lt|gt|quot|apos);/gi, (m, e) => ENTITIES[e.toLowerCase()]));

function tag(xml, name) {
  const m = xml.match(new RegExp('<' + NS + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + NS + name + '>'));
  return m ? decodeXml(m[1].trim()) : null;
}
const num = (s) => (s == null || s === '' ? null : parseInt(s, 10));

function parseProfiles(xml) {
  const out = [];
  const re = new RegExp('<' + NS + 'Profiles\\b([^>]*)>([\\s\\S]*?)<\\/' + NS + 'Profiles>', 'g');
  let m;
  while ((m = re.exec(xml))) {
    out.push({
      token: (m[1].match(/token\s*=\s*["']([^"']*)["']/) || [])[1] || null,
      name: tag(m[2], 'Name'),
      width: num(tag(m[2], 'Width')),
      height: num(tag(m[2], 'Height')),
    });
  }
  return out;
}

// One token per VideoSource. Reads BOTH forms of the attribute because the manufacturer omits it
// (XMEye already omits VideoSourceToken in the profiles, measured fact 3): the element's `token` and
// the child <tt:SourceToken>. A token missing from both => the source is dropped (no invented identity).
function parseVideoSources(xml) {
  const out = [];
  const re = new RegExp('<' + NS + 'VideoSources\\b([^>]*)>([\\s\\S]*?)<\\/' + NS + 'VideoSources>', 'g');
  let m;
  while ((m = re.exec(xml))) {
    const attr = (m[1].match(/token\s*=\s*["']([^"']*)["']/) || [])[1] || null;
    const child = tag(m[2], 'SourceToken');
    const token = attr || (child ? child.trim() : null);
    if (token) out.push(token);
  }
  return out;
}

function parseDeviceInfo(xml) {
  return {
    manufacturer: tag(xml, 'Manufacturer'),
    model: tag(xml, 'Model'),
    firmware: tag(xml, 'FirmwareVersion'),
  };
}

// first non-empty HwAddress: cameras with more than one interface usually list a virtual one
// without a MAC before the real ethernet
function parseNetworkInterfaces(xml) {
  for (const m of xml.matchAll(/<(?:[\w]+:)?HwAddress[^>]*>([\s\S]*?)<\/(?:[\w]+:)?HwAddress>/g)) {
    const v = m[1].trim();
    if (v) return { mac: v };
  }
  return { mac: null };
}

// Attributes of <tptz:ServiceCapabilities ...>: become a name->boolean map (MoveStatus, StatusPosition...).
function parsePtzCapabilities(xml) {
  const m = xml.match(/<(?:tptz:|tt:)?(?:Service)?Capabilities\b([^>]*?)\/?>/);
  const caps = {};
  for (const par of String(m ? m[1] : '').matchAll(/([\w:]+)="([^"]*)"/g)) caps[par[1]] = par[2] === 'true';
  return { caps };
}

// GetNodes: the device declares the space by the element NAME (<tt:ContinuousPanTiltVelocitySpace>)
// and/or by the generic URI inside it (<tt:URI>.../PanTiltSpaces/VelocityGenericSpace</tt:URI>).
// Reads BOTH: the real camera sends both forms, and there are devices that send only one. Without a
// CONTINUOUS VELOCITY space there is nothing the client instrument can do — which is why
// `supported` requires a continuous pan/tilt OR zoom space.
function parsePtzNodes(xml) {
  const names = [...xml.matchAll(/<tt:(\w+Space)\b[^>]*>/g)].map((m) => m[1]);
  const uris = [...xml.matchAll(/<tt:URI>([^<]+)<\/tt:URI>/g)].map((m) => m[1].trim());
  return { spaces: [...new Set([...names, ...uris])] };
}

// ponytail: the device may answer only the <tt:URI> (without the element naming the space). The
// generic URI IS the same space as the named element — PanTiltSpaces/VelocityGenericSpace =
// ContinuousPanTiltVelocitySpace — so the canonical name comes from the URI and `has()` compares
// name with name. An unknown URI comes back as is.
function spaceName(uri) {
  const m = uri.match(/\/tptz\/(PanTilt|Zoom)Spaces\/(Position|Velocity|Translation)GenericSpace$/);
  if (!m) return uri;
  return ({ Position: 'Absolute', Velocity: 'Continuous', Translation: 'Relative' }[m[2]]) + m[1] + m[2] + 'Space';
}

// PTZ capability + media profile token. The ONVIF token is NOT our profile name: it comes from the
// device GetProfiles (measured: the real camera only answers PTZ with Profile_1, not with `main`).
async function ptzCapability({ xaddr, user, pass, timeoutMs = 5000 }) {
  const base = { xaddr, user, pass, timeoutMs };
  const { caps } = await onvifCall({ ...base, action: TPTZ + '/GetServiceCapabilities', body: '<tptz:GetServiceCapabilities/>' });
  const { spaces } = await onvifCall({ ...base, action: TPTZ + '/GetNodes', body: '<tptz:GetNodes/>' }).catch(() => ({ spaces: [] }));
  const profiles = await onvifCall({ ...base, action: 'GetProfiles' }).catch(() => []);
  const has = (name) => spaces.some((u) => spaceName(u) === name || u.includes(name));
  return {
    supported: has('ContinuousPanTiltVelocitySpace') || has('ContinuousZoomVelocitySpace'),
    panTilt: has('ContinuousPanTiltVelocitySpace') || has('AbsolutePanTiltPositionSpace'),
    zoom: has('ContinuousZoomVelocitySpace') || has('AbsoluteZoomPositionSpace'),
    continuous: has('ContinuousPanTiltVelocitySpace'),
    // The recording gate is PER AXIS (spec 2026-10-17, section 3): a camera with continuous-only
    // zoom still knows how to go to a pan/tilt position.
    absolutePanTilt: has('AbsolutePanTiltPositionSpace'),
    absoluteZoom: has('AbsoluteZoomPositionSpace'),
    // ponytail: `absolute` (both axes) stays for compatibility; what decides now is per axis
    absolute: has('AbsolutePanTiltPositionSpace') && has('AbsoluteZoomPositionSpace'),
    caps, spaces,
    token: (profiles[0] && profiles[0].token) || null,
  };
}

// Normalized velocity -1..1, always with a decimal point (the device rejects "0,6" and "1e-3").
function continuousMoveBody(token, { pan, tilt, zoom }) {
  const n = (v) => (Math.max(-1, Math.min(1, Number(v) || 0))).toFixed(3);
  return `<tptz:ContinuousMove><tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>`
    + `<tptz:Velocity><tt:PanTilt x="${n(pan)}" y="${n(tilt)}"/>`
    + `<tt:Zoom x="${n(zoom)}"/></tptz:Velocity></tptz:ContinuousMove>`;
}

async function ptzMove({ xaddr, user, pass, token, pan, tilt, zoom, timeoutMs = 5000 }) {
  return onvifCall({ xaddr, user, pass, timeoutMs, action: TPTZ + '/ContinuousMove',
    body: continuousMoveBody(token, { pan, tilt, zoom }) });
}

async function ptzStop({ xaddr, user, pass, token, timeoutMs = 5000 }) {
  const body = `<tptz:Stop><tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>`
    + '<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>';
  return onvifCall({ xaddr, user, pass, timeoutMs, action: TPTZ + '/Stop', body });
}

// ---- local positions (spec 2026-10-17) ----
// GetStatus returns WHERE THE CAMERA IS. The values and the `space` come out of here as TEXT, with no
// conversion and no rounding: it is what the device returned and what it will get back in
// AbsoluteMove (spec 4.1).
function parsePtzStatus(xml) {
  const pt = /<(?:[\w]+:)?PanTilt\b([^>]*)>?/.exec(xml);
  const zm = /<(?:[\w]+:)?Zoom\b([^>]*)>?/.exec(xml);
  const attr = (block, name) => (String(block || '').match(new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']')) || [])[1] || null;
  return {
    pan: attr(pt && pt[1], 'x'), tilt: attr(pt && pt[1], 'y'), spacePanTilt: attr(pt && pt[1], 'space'),
    zoom: attr(zm && zm[1], 'x'), spaceZoom: attr(zm && zm[1], 'space'),
  };
}

async function ptzPosition({ xaddr, user, pass, token, timeoutMs = 5000 }) {
  return onvifCall({ xaddr, user, pass, timeoutMs, action: TPTZ + '/GetStatus',
    body: `<tptz:GetStatus><tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken></tptz:GetStatus>` });
}

// AbsoluteMove: the camera goes to the EXACT position. `Speed` is deliberately omitted (spec 10.2):
// the device uses its own default, as it did with GotoPreset. The values already are the device
// text — `escapeXml` without `Number()`.
function absoluteMoveBody(token, { pan, tilt, zoom, spacePanTilt, spaceZoom }) {
  // The axis the position does NOT have leaves the body (spec 2026-10-17, section 3):
  // `escapeXml(null)` would become `x="null"` and the device would refuse the whole move.
  const panTilt = pan != null && tilt != null
    ? `<tt:PanTilt x="${escapeXml(pan)}" y="${escapeXml(tilt)}" space="${escapeXml(spacePanTilt)}"/>` : '';
  const zoomOnly = zoom != null ? `<tt:Zoom x="${escapeXml(zoom)}" space="${escapeXml(spaceZoom)}"/>` : '';
  return `<tptz:AbsoluteMove><tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>`
    + '<tptz:Position>' + panTilt + zoomOnly + '</tptz:Position></tptz:AbsoluteMove>';
}

async function ptzGotoAbsolute({ xaddr, user, pass, token, pan, tilt, zoom, spacePanTilt, spaceZoom, timeoutMs = 5000 }) {
  return onvifCall({ xaddr, user, pass, timeoutMs, action: TPTZ + '/AbsoluteMove',
    body: absoluteMoveBody(token, { pan, tilt, zoom, spacePanTilt, spaceZoom }) });
}

function parseStreamUri(xml) {
  return tag(xml, 'Uri');
}

function faultText(xml) {
  const f = xml.match(/<(?:[\w]+:)?Fault\b[\s\S]*?<\/(?:[\w]+:)?Fault>/);
  if (!f) return null;
  const t = f[0].match(/<(?:[\w]+:)?Text[^>]*>([\s\S]*?)<\/(?:[\w]+:)?Text>/) ||
    f[0].match(/<(?:[\w]+:)?Value[^>]*>([\s\S]*?)<\/(?:[\w]+:)?Value>/);
  return ((t ? t[1] : f[0].replace(/<[^>]+>/g, ' ')).trim().replace(/\s+/g, ' ').slice(0, 200)) || 'Fault';
}

async function onvifCall({ xaddr, action, user, pass, profileToken, body: rawBody, timeoutMs = 5000 }) {
  // ponytail: `body` is the raw body (PTZ); without it, the body comes from the usual `soap()` table
  const xml = buildEnvelope({ action, body: rawBody || soap(action, profileToken), user, pass });
  let res, body;
  try {
    res = await fetch(xaddr, {
      method: 'POST',
      headers: { 'content-type': 'application/soap+xml; charset=utf-8' },
      body: xml,
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await res.text();
  } catch (err) {
    throw new AppError('onvif_call_failed', { action, reason: (err && err.message) || err });
  }
  // ponytail: read the Fault BEFORE the status — devices answer a Fault with HTTP 500 and the
  // manufacturer message (e.g. "Sender not Authorized") is more useful than "HTTP 500"
  const fault = faultText(body);
  if (fault) {
    const e = new AppError('onvif_call_failed', { action, reason: fault });
    // The MARK lives on the error, not on the consumer: discovery needs to tell "the device spoke
    // SOAP and refused the credential" (proof of a camera) from "nobody is listening there".
    if (RE_AUTH.test(fault)) e.kind = 'auth';
    throw e;
  }
  if (res.status > 399) throw new AppError('onvif_http_failed', { action, status: res.status });
  // PTZ (spec 2026-10-16): a read returns data; a command returns {ok} (the answer is empty by
  // norm). These branches come BEFORE `return parseStreamUri` — the action is the full URI, not the
  // short name.
  if (/\/GetServiceCapabilities$/.test(action)) return parsePtzCapabilities(body);
  if (/\/GetNodes$/.test(action)) return parsePtzNodes(body);
  if (/\/GetStatus$/.test(action)) return parsePtzStatus(body);
  if (/\/(ContinuousMove|Stop|AbsoluteMove)$/.test(action)) return { ok: true };
  if (action === 'GetProfiles') return parseProfiles(body);
  if (action === 'GetDeviceInformation') return parseDeviceInfo(body);
  if (action === 'GetNetworkInterfaces') return parseNetworkInterfaces(body);
  if (action === 'GetVideoSources') return parseVideoSources(body);
  return parseStreamUri(body);
}

module.exports = { passwordDigest, buildEnvelope, parseProfiles, parseVideoSources, parseDeviceInfo, parseStreamUri, parseNetworkInterfaces, onvifCall,
  TPTZ, parsePtzCapabilities, parsePtzNodes, continuousMoveBody, ptzCapability, ptzMove, ptzStop,
  parsePtzStatus, ptzPosition, absoluteMoveBody, ptzGotoAbsolute };

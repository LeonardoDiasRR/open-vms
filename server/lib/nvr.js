'use strict';
const crypto = require('node:crypto');

// Multi-channel device rules (spec 2026-10-17). Pure on purpose: the profile->channel mapping and the
// child identity are what the whole wave uses, and neither may depend on the network.

// XMEye/Dahua profile name: MediaProfile_Channel<N>_MainStream|SubStream1. It is a FALLBACK: XMEye
// omits VideoSourceToken in the profiles (measured fact 3), so the name is the only cheap map left
// when the URL does not carry the parameter.
const NAME_RE = /Channel(\d+)_(Main|Sub)Stream/i;

// The AUTHORITATIVE map: channel=<N>&subtype=<M> in the GetStreamUri URL (measured fact 4).
function channelFromUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return { channel: null, subtype: null }; }
  const c = parseInt(u.searchParams.get('channel'), 10);
  const s = parseInt(u.searchParams.get('subtype'), 10);
  return { channel: Number.isInteger(c) ? c : null, subtype: Number.isInteger(s) ? s : null };
}

function profileChannel(profile) {
  const p = String((profile && profile.source_url) || '');
  if (p) {
    const fromUrl = channelFromUrl(p);
    if (fromUrl.channel !== null) return fromUrl;
  }
  const m = NAME_RE.exec(String((profile && profile.name) || ''));
  return m ? { channel: Number(m[1]), subtype: /sub/i.test(m[2]) ? 1 : 0 } : { channel: null, subtype: null };
}

// Groups the profiles per channel: subtype 0 = primary, 1 = secondary (spec decision 2). A profile
// with no derivable channel stays OUT (it does not invent one); a channel that only has the sub
// becomes primary with what it has.
function profileChannels(profiles) {
  const map = new Map();
  for (const p of profiles || []) {
    const { channel, subtype } = profileChannel(p);
    if (channel === null) continue;
    if (!map.has(channel)) map.set(channel, { channel, primary: null, secondary: null });
    const c = map.get(channel);
    if (subtype === 1 && !c.secondary) c.secondary = p;
    else if (!c.primary) c.primary = p;
    else if (!c.secondary) c.secondary = p;
  }
  return [...map.values()].sort((a, b) => a.channel - b.channel);
}

// 2+ sources = multi-channel (spec decision 2). 0 or 1 = the single-camera behavior as always.
const classifySources = (sources) => (Array.isArray(sources) && sources.length >= 2 ? 'nvr' : 'camera');

// STABLE identity of the child (amendment E1): the IP+channel pair, not the VideoSource token — the
// token does not exist in the profile (fact 3) and matching by order would break the identity when a
// channel appears in the middle.
const physicalIdOf = (ip, channel) => `${ip}|${channel}`;

function newDevice(fields) {
  return { id: crypto.randomUUID(), kind: 'nvr', onvif: null, channels: [], ...fields,
    created_at: new Date().toISOString() };
}

module.exports = { NAME_RE, channelFromUrl, profileChannel, profileChannels, classifySources, physicalIdOf, newDevice };

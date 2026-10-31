'use strict';

// F3 (spec §9): HTTPS required outside loopback/exposure and Origin/CORS validation. They are PURE
// predicates over the request — the main.js dispatcher only consumes them, which is why they are
// testable without a real socket (`req.socket.remoteAddress` in a local test is always loopback).
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

const peerOf = (req) => String((req && req.socket && req.socket.remoteAddress) || '');
const headerOf = (req, name) => String((req && req.headers && req.headers[name]) || '');

// The client IP for rate limiting: the direct peer, or the FIRST of the chain when the peer is a
// trusted proxy (loopback + `trustProxy`). Outside that the XFF is attacker data and is ignored.
function originIp(req, conf = {}) {
  const peer = peerOf(req);
  if (!conf.trustProxy || !LOOPBACK.has(peer)) return peer;
  const first = headerOf(req, 'x-forwarded-for').split(',')[0].trim();
  return first || peer;
}

// Outside loopback (where the front nginx terminates TLS) only https gets in. Behind a trusted
// proxy the `x-forwarded-proto` counts — the only way a proxy on another machine can declare TLS.
function requiresHttps(req, conf = {}) {
  const peer = peerOf(req);
  if (LOOPBACK.has(peer)) return false;
  if (conf.trustProxy && headerOf(req, 'x-forwarded-proto').split(',')[0].trim() === 'https') return false;
  return true;
}

// Without Origin (curl, mediamtx) it passes. Loopback, SAME origin and the explicit list pass. The
// same-origin comparison ignores the PORT: nginx rewrites `Host: $host` without a port
// (deploy/nginx.conf).
function originAllowed(req, conf = {}) {
  const origin = headerOf(req, 'origin');
  if (!origin) return true;
  if (LOCAL_ORIGIN.test(origin)) return true;
  if ((conf.allowedOrigins || []).includes(origin)) return true;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const mine = headerOf(req, 'host');
  if (!mine) return false;
  return host === mine || host.split(':')[0] === mine.split(':')[0];
}

// ponytail: auth via the Bearer header (not a cookie) — with an Origin it returns the SPECIFIC
// origin (never `*`, which would let any site read the response); without one it keeps today's `*`.
function corsHeaders(req, conf = {}) {
  const origin = headerOf(req, 'origin');
  return {
    'access-control-allow-origin': origin && originAllowed(req, conf) ? origin : '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '600',
  };
}

module.exports = { originIp, requiresHttps, originAllowed, corsHeaders, LOOPBACK, LOCAL_ORIGIN };

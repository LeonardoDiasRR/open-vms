'use strict';
const net = require('node:net');
const crypto = require('node:crypto');

// Ports that never speak ONVIF over HTTP: 554 is RTSP, 3702 is WS-Discovery, 443 is self-signed HTTPS.
const PORTS_WITHOUT_ONVIF = new Set([554, 3702, 443]);
// Fallback ladder: a camera that only opened 554 usually has ONVIF HTTP on one of these.
const COMMON_ONVIF_PORTS = [80, 8080, 8899, 8000];
// A credential refusal is proof of a camera when it came as SOAP (Fault). A bare HTTP 401 proves nothing.
const RE_AUTH = /not ?authoriz|unauthoriz|authoriz|authentication fail|invalid (password|username|credential)/i;
const DEFAULT_TIMEOUT = 2000;

// xaddr order: the WS-Discovery xaddr, the ports the scan opened (minus those without ONVIF)
// and finally the common port ladder, without repeats.
function hostXaddrs(host) {
  const out = [];
  if (host.xaddr) out.push(host.xaddr);
  for (const p of host.openPorts || []) {
    if (!PORTS_WITHOUT_ONVIF.has(p)) out.push(`http://${host.ip}:${p}/onvif/device_service`);
  }
  for (const p of COMMON_ONVIF_PORTS) {
    const u = `http://${host.ip}:${p}/onvif/device_service`;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

// The MARK of the proof. `kind` comes from lib/onvif.js; the regex covers the error that only
// carries a message.
function isAuthFailure(error) {
  if (!error) return false;
  if (error.kind === 'auth') return true;
  return RE_AUTH.test(String(error.message || ''));
}

// RTSP OPTIONS: the proof of a camera that exists without ONVIF and without credentials —
// OPTIONS is the method RTSP serves anonymously.
function probeRtsp(ip, port, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    let buf = '';
    let done = false;
    // ponytail: 'close' is mandatory — whoever does not speak RTSP usually DROPS the socket on
    // receiving OPTIONS, and a socket destroyed by the peer emits neither 'error' nor the idle
    // callback: without this line the probe hangs forever and the scan never ends.
    const finish = (ok) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('error', () => finish(false));
    sock.once('close', () => finish(false));
    sock.once('connect', () => { sock.write(`OPTIONS rtsp://${ip}:${port}/ RTSP/1.0\r\nCSeq: 1\r\n\r\n`); });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (/^RTSP\/1\.[01] (200|401|403)/i.test(buf)) finish(true);
    });
  });
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// The Authorization value for a WWW-Authenticate challenge: Digest RFC 2617 (with or without qop) or
// Basic. Measured in the field (2026-10-23): the Hikvision DS-2DE4225IW-DE answers
// `Digest realm="IP Camera(...)", nonce=..., stale="FALSE"` with NO qop — the no-qop path is the one
// that fires on that model.
function rtspAuthHeader(challenge, method, uri, user, pass) {
  if (!/^Digest /i.test(challenge)) {
    if (!/Basic /i.test(challenge)) return null;
    return { value: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
  }
  const params = {};
  for (const kv of challenge.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,]+))/g)) {
    params[kv[1]] = kv[2] !== undefined ? kv[2] : kv[3].trim();
  }
  if (!params.realm || !params.nonce) return null;
  const ha1 = md5(`${user}:${params.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const out = { username: user, realm: params.realm, nonce: params.nonce, uri };
  if (params.qop) {
    const qop = params.qop.split(',')[0].trim();
    const cnonce = crypto.randomBytes(8).toString('hex');
    const nc = '00000001';
    out.response = md5(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    out.qop = qop; out.nc = nc; out.cnonce = cnonce;
  } else {
    out.response = md5(`${ha1}:${params.nonce}:${ha2}`);
  }
  if (params.opaque) out.opaque = params.opaque;
  const inner = Object.entries(out)
    .map(([k, v]) => (['qop', 'nc'].includes(k) ? `${k}=${v}` : `${k}="${v}"`)).join(', ');
  return { value: `Digest ${inner}` };
}

// Credential probe of the RTSP branch (spec 2026-10-23, decision D1): the anonymous OPTIONS proves the
// camera, never the credential. ONE authenticated DESCRIBE per host — the recorder locks after about
// 30 refusals (fact 6) and the scan already cuts at 5 (amendment E10). 'ok' | 'refused' | 'unknown'.
// A device that REFUSES BY SILENCE (amendment E8, measured 2026-10-23 on 10.195.96.239/240/241): with
// the right credential it answers the authenticated DESCRIBE with 200 in about 50 ms; with a wrong one
// it answers nothing for 8 s while the same socket keeps answering OPTIONS with 200. Silence on a live
// socket is a refusal. A device that goes quiet on the DESCRIBE regardless of the credential would be a
// false negative, hence the liveness OPTIONS below — it never authenticates, so it burns no attempt.
const AUTH_SILENCE_MS = 800;

function probeRtspAuth(ip, port, user, pass, timeoutMs = DEFAULT_TIMEOUT, url = null) {
  return new Promise((resolve) => {
    const uri = url || `rtsp://${ip}:${port}/`;
    const sock = net.connect({ host: ip, port });
    let buf = '';
    let done = false;
    let sentAuth = false;
    let askedAlive = false;
    let timer = null;
    // the clock is this setTimeout chain, not the socket inactivity: the liveness step needs a partial budget
    const arm = (ms, fn) => { if (timer) clearTimeout(timer); timer = setTimeout(fn, ms); };
    const finish = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); sock.destroy(); resolve(r); };
    sock.setTimeout(0);
    // RST depois do DESCRIBE autenticado é recusa ativa (mediu 2026-10-30: o mediamtx responde o 401 do
    // Basic errado e dá RST — o 'error' chega antes do 'data' e perderia a recusa). 'close' limpo e
    // qualquer erro ANTES da autenticação seguem 'unknown': o gate não pune o que não decidiu.
    sock.once('error', (e) => finish(sentAuth && e.code === 'ECONNRESET' ? 'refused' : 'unknown'));
    sock.once('close', () => finish('unknown'));
    const describe = (auth) =>
      `DESCRIBE ${uri} RTSP/1.0\r\nCSeq: 2\r\n${auth ? 'Authorization: ' + auth.value + '\r\n' : ''}Accept: application/sdp\r\n\r\n`;
    sock.once('connect', () => { sock.write(describe(null)); arm(timeoutMs, () => finish('unknown')); });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const m = /^RTSP\/1\.[01] (\d{3})/i.exec(buf);
      if (!m) return;
      const cod = Number(m[1]);
      const cseq = Number((/\r\nCSeq:\s*(\d+)/i.exec(buf) || [])[1]);
      // the OPTIONS liveness request answered: the device is alive and ignored the authenticated DESCRIBE
      if (askedAlive && cseq === 4) return finish('refused');
      // 200 open stream; 412 authenticated and refused the SESSION (iDS-TCM403); 501 stub — all prove the credential
      if (cod === 200 || cod === 412 || cod === 501) return finish('ok');
      if (cod === 401 && !sentAuth) {
        const ch = /WWW-Authenticate:\s*(.+)\r\n/i.exec(buf);
        const hdr = ch && rtspAuthHeader(ch[1].trim(), 'DESCRIBE', uri, user, pass);
        if (!hdr) return finish('unknown');
        sentAuth = true;
        buf = '';
        sock.write(describe(hdr));
        arm(AUTH_SILENCE_MS, () => {
          if (done || askedAlive) return;
          askedAlive = true;
          buf = '';
          sock.write(`OPTIONS ${uri} RTSP/1.0\r\nCSeq: 4\r\n\r\n`);
          arm(Math.max(timeoutMs - AUTH_SILENCE_MS, 400), () => finish('unknown'));
        });
        return;
      }
      if (cod === 401 || cod === 403) return finish('refused');
      finish('unknown');
    });
  });
}

// CHANNEL probe (spec 2026-10-17, decision 3): OPTIONS on the channel URL, not on the RTSP server
// root. Measured against the DVR: a channel that exists answers 200 (or 401/403, asking for a
// credential) and an empty channel answers 404 — that is what decides "channel without stream" in
// the wizard. The XML `resolution` from GetProfiles does NOT work: a transmitting channel arrives
// with a null resolution (measured fact 5).
function probeChannel(url, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(String(url || '')); } catch { return resolve({ stream: false, reason: 'invalid url' }); }
    const sock = net.connect({ host: u.hostname, port: Number(u.port) || 554 });
    let buf = '';
    let done = false;
    // ponytail: 'close' is mandatory, for the same reason as probeRtsp — whoever does not speak
    // RTSP drops the socket
    const finish = (r) => { if (done) return; done = true; sock.destroy(); resolve(r); };
    sock.setTimeout(timeoutMs, () => finish({ stream: false, reason: 'timeout' }));
    sock.once('error', () => finish({ stream: false, reason: 'error' }));
    sock.once('close', () => finish({ stream: false, reason: 'closed' }));
    sock.once('connect', () => { sock.write(`OPTIONS ${u.pathname}${u.search} RTSP/1.0\r\nCSeq: 1\r\n\r\n`); });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const m = /^RTSP\/1\.[01] (\d{3})/i.exec(buf);
      if (m) {
        const cod = Number(m[1]);
        finish({ stream: cod === 200 || cod === 401 || cod === 403, reason: `HTTP ${cod}` });
      }
    });
  });
}

// URL do canal digitada pelo operador, quando serve o host:porta sondado. Sem ela o gate autêntica
// a raiz — e um servidor por caminho (mediamtx) responde a raiz igual com senha certa ou errada.
function channelUrlFor(host, port) {
  if (!host || !host.source) return null;
  try {
    const u = new URL(host.source);
    const pu = Number(u.port) || 554;
    return u.hostname === host.ip && pu === Number(port) ? host.source : null;
  } catch { return null; }
}

// Classifies the host: 'none' is the answer to "an open port is not a camera".
async function verifyCamera({ host, credential, onvif, rtspProbe = probeRtsp, rtspAuthProbe = probeRtspAuth, timeoutMs = DEFAULT_TIMEOUT }) {
  const hasCredential = !!(credential && credential.username && credential.password);
  const user = hasCredential ? credential.username : undefined;
  const pass = hasCredential ? credential.password : undefined;
  let lastError = null;
  for (const xaddr of hostXaddrs(host)) {
    try {
      const d = await onvif.deviceInformation({ xaddr, user, pass, timeoutMs });
      // 200 without Manufacturer/Model is no proof of ONVIF: it is some HTTP answering 200.
      if (d && (d.manufacturer || d.model)) {
        return { status: 'verified', xaddr, manufacturer: d.manufacturer ?? null, model: d.model ?? null };
      }
      lastError = new Error('response without manufacturer/model');
    } catch (e) {
      if (isAuthFailure(e)) {
        return { status: hasCredential ? 'invalid_credential' : 'credential_required',
                 xaddr, manufacturer: null, model: null };
      }
      lastError = e;
    }
  }
  for (const p of host.openPorts || []) {
    if (await rtspProbe(host.ip, p, timeoutMs)) {
      // OPTIONS is anonymous: it proves the camera, not the credential. With a credential in the scan the
      // authenticated DESCRIBE decides (spec 2026-10-23, decisions D1/D2). Without one the probe does not
      // run — a scan without credential burns no attempt and ineligible nothing.
      if (hasCredential) {
        // 2026-10-30: com URL de canal digitada, autentica o DESCRIBE no path — e o RST pos-auth do
        // mediamtx ja e 'refused' dentro do probeRtspAuth. Sem source, comportamento de sempre.
        const r = await rtspAuthProbe(host.ip, p, user, pass, timeoutMs, channelUrlFor(host, p));
        if (r === 'refused') return { status: 'invalid_credential', xaddr: null, manufacturer: null, model: null };
      }
      return { status: 'rtsp', xaddr: null, manufacturer: null, model: null };
    }
  }
  return { status: 'none', xaddr: null, manufacturer: null, model: null, error: lastError && lastError.message };
}

module.exports = { hostXaddrs, isAuthFailure, probeRtsp, rtspAuthHeader, probeRtspAuth, probeChannel, verifyCamera };

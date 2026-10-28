// ponytail: pure logic of the "Add devices" screen; the component only calls it and renders.
// The five examples are the same ones from NX Witness' tooltip (only the "Examples:" label is
// translated).
export const EXAMPLES: string[] = [
  '192.168.1.15',
  'www.example.com:8080',
  'http://example.com:7090/image.jpg',
  'rtsp://example.com:554/video',
  'udp://239.250.5.5:1234',
];

// The dash the NX Port field shows while "Default" is checked. ponytail: it lives here because the
// page and the results component write the same value.
export const HIDDEN_PORT = '—';

// default port per scheme; 554 (RTSP) is this product's camera fallback.
// ponytail: INTERNAL constant — only defaultPort reads it (no external consumer), hence no export.
const DEFAULT_PORTS: Record<string, number> = { rtsp: 554, http: 80, https: 443, udp: 1234 };
export const defaultPort = (scheme: string): number => DEFAULT_PORTS[scheme] || 554;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function ipToInt(ip: string): number {
  const p = String(ip || '').trim().split('.');
  if (p.length !== 4 || p.some((o) => !/^\d{1,3}$/.test(o) || +o > 255)) {
    throw new Error(`invalid IP: ${ip}`);
  }
  return p.reduce((a, o) => (a << 8) + +o, 0) >>> 0;
}
const intToIp = (n: number): string => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

// `informada` is the wire key of POST /devices (`addresses[].informada`), not a local name.
export type ParsedAddress = { scheme: string; host: string; port: number; source: string; informada: boolean };
export type DeviceBody = {
  name: string;
  addresses: { ip: string; port: number; scheme: string; informada: boolean }[];
  credential: { username: string; password: string };
  source: string;
  device?: { kind: 'nvr' };
  channels?: number[];
};

// Accepts a bare IP, a host, host:port and scheme links. `port` is the value of the Port field.
export function parseAddress(value: unknown, port?: string | number | null): ParsedAddress {
  const v = String(value || '').trim();
  if (!v) throw new Error('enter an address');
  if (SCHEME_RE.test(v)) {
    const u = new URL(v); // stdlib URL understands non-special schemes (rtsp/udp)
    const scheme = u.protocol.replace(':', '');
    const explicit = u.port !== '';
    // ponytail: a pasted link goes in whole as `source` — rebuilding it would lose the path (/ISAPI/...)
    return { scheme, host: u.hostname, port: Number(u.port) || defaultPort(scheme), source: v, informada: explicit };
  }
  const [host, p] = v.split(':');
  const informada = !!(Number(port) || Number(p));
  const chosen = Number(port) || Number(p) || defaultPort('rtsp');
  return { scheme: 'rtsp', host, port: chosen, source: `rtsp://${host}:${chosen}/`, informada };
}

// Inclusive IP range; the 1024 cap mirrors server/lib/scanner.js (expandIps).
export function expandRange(start: string, end: string, max = 1024): string[] {
  const a = ipToInt(start), b = ipToInt(end);
  if (b < a) throw new Error('last IP is lower than the first');
  const n = b - a + 1;
  if (n > max) throw new Error(`range too large (max ${max} IPs)`);
  return Array.from({ length: n }, (_, i) => intToIp(a + i));
}

// Body of POST /api/v1/devices from the form fields.
export function deviceBody({ name, address, port, useDefault, login, password, channels }: {
  name?: string; address?: string; port?: string | number | null;
  useDefault?: boolean; login?: string; password?: string; channels?: number[];
}): DeviceBody {
  const { scheme, host, port: resolvedPort, source, informada } = parseAddress(address, useDefault ? null : port);
  return {
    name: String(name || '').trim() || host,
    addresses: [{ ip: host, port: resolvedPort, scheme, informada }],
    credential: { username: login || '', password: password || '' },
    source,
    // With channels chosen the server creates the parent DEVICE + 1 child per channel (spec decision 4);
    // without channels the body is exactly today's and the route takes the single-camera path.
    ...(channels && channels.length ? { device: { kind: 'nvr' as const }, channels } : {}),
  };
}

// ponytail: the server says "already added" (the discovery outcome); the client does not compare IP
export const isAdded = (r: { outcome?: string }) => r.outcome === 'added';

// Candidates that belong to ONE scan. The server keeps every discovery of the instance (including
// older scans); the table may only list what the current scan found.
export function resultsForScan<T extends { scan_id?: string | null }>(
  candidates: readonly (T | null | undefined)[] | null | undefined,
  scanId: string | null | undefined,
): T[] {
  if (!scanId) return [];
  return (candidates || []).filter((c): c is T => !!c && c.scan_id === scanId);
}

// ponytail: /24 (class C) only — the highest usable IP of the same network is the .254.
// Returns null when the value is not a plain IPv4; the caller leaves the last IP field as it is.
export function subnetEnd(firstIp: unknown): string | null {
  const v = String(firstIp || '').trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v)) return null;
  const o = v.split('.').map(Number);
  if (o.some((x) => x > 255)) return null;
  return `${o[0]}.${o[1]}.${o[2]}.254`;
}

// Masks the IP fields as 999.999.999.999: digits only; the dot (or comma) advances the octet when
// it already has a digit, and a full octet (3 digits) advances on its own.
// ponytail: a paste is honoured separator by separator — slicing every 3 digits would turn
// '10.195.96.7' into '101.959.67'.
export function maskIp(text: unknown): string {
  const raw = String(text ?? '');
  const groups = ['', '', '', ''];
  let g = 0;
  for (const ch of raw) {
    if (ch === '.' || ch === ',') { if (groups[g]) g = Math.min(g + 1, 3); continue; }
    if (!/[0-9]/.test(ch)) continue;
    if (groups[g].length === 3) g = Math.min(g + 1, 3);
    if (groups[g].length === 3) continue; // fourth octet full: drop the rest
    groups[g] += ch;
  }
  // ponytail: a separator typed at the END is preserved, otherwise the octet boundary is lost: the
  // mask runs on every keystroke, so typing '192.168.0.1' would become '192.168.01' (the next digit
  // would fall into the previous octet). It is only kept when the user typed it — backspace still works.
  // ponytail: findLastIndex is ES2023 and the tsconfig lib is ES2022 — reduce finds the same last index.
  const last = groups.reduce((acc, x, i) => (x ? i : acc), -1);
  return groups.join('.').replace(/\.+$/, '') + (/[.,]$/.test(raw) && last >= 0 && last < 3 ? '.' : '');
}

// Indices (1-based) of the octets whose value is above 255. A 1- or 2-digit octet never goes past
// 99, so there is no false positive while typing: the warning only shows on the octet that really
// overflowed.
export function invalidOctets(ip: unknown): number[] {
  return String(ip ?? '').split('.')
    .map((o, i) => (o && Number(o) > 255 ? i + 1 : 0))
    .filter(Boolean);
}

// Camera ineligible for registration: the gate proved the credential does not work (ONVIF refusal, or
// the refusal of the authenticated RTSP DESCRIBE — spec 2026-10-23). The list is of ineligible ones
// (not of eligible ones) so a candidate without status is not punished — a row without proof is also
// without proof against. `credential_required` does NOT block (decision D2): a scan without credential
// proves nothing about the credential, and with one in the form the gate never emits it.
export const isCameraIneligible = (status?: string | null): boolean =>
  status === 'invalid_credential';

// Channels marked by default: all channels WITH stream; the channel without stream is born
// unchecked with a warning (spec decision 4) — the stream proof is the server's OPTIONS probe
// (`has_stream`), never the resolution of the GetProfiles XML (measured fact 5).
export const defaultChannels = (channels: { channel: number; has_stream: boolean }[]): number[] =>
  (channels || []).filter((c) => c.has_stream).map((c) => c.channel);

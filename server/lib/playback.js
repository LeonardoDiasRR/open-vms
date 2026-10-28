'use strict';
// ---- Delivery per session (spec 2026-10-18, section 5.3) --------------------------------
// Two PURE functions: the window and the playlist text. No I/O and no state — the same input
// produces the SAME playlist, and that is what the design calls a "session" (section 8: Nx keeps
// client state on the server; here there is nothing to clean up, and the response is cacheable).
const DEFAULT_WINDOW = 120;   // spec 5.3: default window of 120 s
const MAX_ENTRIES = 300;      // spec 5.3: ceiling of entries per playlist (seek swaps the window)
const OPEN_GRACE = 10;        // s: same tolerance `coverageEnd` gives an open hour (fmp4index)

// Window [de, ate) in epoch. A missing `ts` = window ENDING at `agora` (the "live of the past");
// with `ts`, the window STARTS there — what the operator asked to play from that point on.
function windowFor({ ts, janela: width = DEFAULT_WINDOW, agora: now = Math.floor(Date.now() / 1000) } = {}) {
  const w = Number(width) > 0 ? Number(width) : DEFAULT_WINDOW;
  if (ts === undefined || ts === null || !Number.isFinite(Number(ts))) return { de: now - w, ate: now };
  return { de: Number(ts), ate: Number(ts) + w };
}

// HLS playlist with the init segment by byte range (`EXT-X-MAP`) and each fragment by
// `EXT-X-BYTERANGE`. `frags` are the fragments of ONE hour file, with ABSOLUTE times.
// Returns `null` when the window has no fragment (the caller answers 404).
function playlistHls({ name, initFim, frags = [], de, ate, token = '', temporal = false, agora: now = Math.floor(Date.now() / 1000) }) {
  // A null `t1` means "last fragment of the file", not "still running" (defect measured 2026-10-24:
  // an old abandoned hour entered EVERY recent window). Honest end = own duration (or the spacing of
  // the fragments) + OPEN_GRACE, capped by the live edge — the same honesty `coverageEnd` gives the
  // timeline. The guard keeps the live edge answerable before the next fragment is indexed.
  const openEnd = (f, i) => Math.min(now + 1, f.t0 + (f.duration || (i > 0 ? f.t0 - frags[i - 1].t0 : 1)) + OPEN_GRACE);
  const inside = frags.filter((f, i) => f.t0 < ate && (f.t1 === null ? openEnd(f, i) : f.t1) > de)
    .slice(0, MAX_ENTRIES);
  if (!inside.length) return null;
  // The last fragment of a still-open file has no t1: its duration is the previous one's.
  const duration = (i, f) => f.duration || (f.t1 === null ? (i > 0 ? f.t0 - inside[i - 1].t0 : 1) : f.t1 - f.t0);
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const uri = `${encodeURIComponent(name)}/file${q}`;
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...inside.map((f, i) => duration(i, f))))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    // measured bug 2026-10-19: without TYPE/ENDLIST VHS treats the (closed) window as LIVE —
    // `duration Infinity`, starts at the "edge" (window end), downgrades the playlist forever
    // (2239 fetches measured in the log) and dies with MediaError 3 on the last segment.
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${uri}",BYTERANGE="${initFim}@0"`,
  ];
  for (const [i, f] of inside.entries()) {
    if (temporal) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(f.t0 * 1000).toISOString()}`);
    lines.push(`#EXTINF:${duration(i, f).toFixed(3)},`);
    lines.push(`#EXT-X-BYTERANGE:${f.size}@${f.byteStart}`);
    lines.push(uri);
  }
  return lines.join('\n') + '\n#EXT-X-ENDLIST\n';
}

// HLS playlist for SEVERAL hour files in one session (plan 2026-10-19, task 1.1). A single
// `EXT-X-MAP` (URI and BYTERANGE of the SAME chunk: the one of the first frag inside the window —
// the init is identical across hours of the same profile, but the byte range is valid in that
// chunk's file) and each frag with the byte range and the URL of ITS chunk. `chunks` = [{ url,
// initFim, frags: [{ ini, tam, dur }] }]; `dur` arrives ready (unlike playlistHls, which derives it
// from t0/t1). Frags with `t0` are filtered by the window [from, to) as in playlistHls; without
// `t0` they always enter. Empty -> ''.
// Emits `#EXT-X-DISCONTINUITY` (a line by itself) before the FIRST `#EXTINF` of each chunk that is
// not the first WITH FRAGS in the playlist (the EXT-X-MAP one is not preceded; never between frags
// of the same chunk). Why: each chunk transcoded with `-ss` BEFORE `-i` is born with tfdt starting at
// ~0 — the time base RESTARTS per file. VHS only adjusts sourceBuffer.timestampOffset on a
// timeline/discontinuity change; without the mark, chunk 2+ is silently dropped and the playhead
// sticks at the end of chunk 0 (blocker B1, measured in headless Chromium with pure MSE).
function playlistHlsMulti({ chunks = [], token = '', de, ate, temporal = false, agora: now = Math.floor(Date.now() / 1000) }) {
  const inside = [];  // [frag, url, initFim, ci] flattened in chunk order (ci = index of the chunk
  // that contributed — filtered/empty chunks leave no trace), under the entries ceiling
  for (const [ci, c] of chunks.entries()) {
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    for (const f of c.frags || []) {
      // open-ended frag: honest end = own duration + OPEN_GRACE, capped by the live edge (see playlistHls)
      if (Number.isFinite(f.t0) && !(f.t0 < ate && (f.t1 == null ? Math.min(now + 1, f.t0 + (f.dur || 1) + OPEN_GRACE) : f.t1) > de)) continue;
      inside.push([f, `${c.url}${q}`, c.initFim, ci]);
      if (inside.length === MAX_ENTRIES) break;
    }
    if (inside.length === MAX_ENTRIES) break;
  }
  if (!inside.length) return '';
  // ponytail: copies the 5 header lines of playlistHls — editing playlistHls to share them was out
  // of the task's scope; if one changes, the golden header test catches both.
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...inside.map(([f]) => f.dur)))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${inside[0][1]}",BYTERANGE="${inside[0][2]}@0"`,
  ];
  let lastChunk = inside[0][3];
  for (const [f, url, , ci] of inside) {
    if (ci !== lastChunk) {
      lines.push('#EXT-X-DISCONTINUITY');  // new timeline (tfdt restarts) — see the function header
      if (temporal) lines.push(`#EXT-X-MAP:URI="${url}",BYTERANGE="${chunks[ci].initFim}@0"`);
      lastChunk = ci;
    }
    if (temporal && Number.isFinite(f.t0)) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(f.t0 * 1000).toISOString()}`);
    lines.push(`#EXTINF:${f.dur.toFixed(3)},`);
    lines.push(`#EXT-X-BYTERANGE:${f.tam}@${f.ini}`);
    lines.push(url);
  }
  return lines.join('\n') + '\n#EXT-X-ENDLIST\n';
}

module.exports = { DEFAULT_WINDOW, MAX_ENTRIES, windowFor, playlistHls, playlistHlsMulti };


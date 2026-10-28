import { createSessionFeed } from './mse-session';
// MSE feed of the recording player (spec 2026-10-19 rev.2). Dependency-free engine: a single <video>
// fed by MediaSource. The SourceBuffer in `sequence` mode fits the fragments in APPEND order and
// ignores the internal tfdt — the per-hour-file reset (and the EXT-X-DISCONTINUITY the playlist
// marks) stops producing a jump. The feeder keeps PREFETCH seconds of buffer ahead of the playhead;
// when the playlist list ends before the window does, the feed re-requests the playlist anchored at
// the epoch already appended and keeps stitching (amendment E1 of the plan).

export const PREFETCH = 30;   // s of CLOCK kept ahead of the playhead (spec 4.3 item 2, amendment 2026-10-19)
const BUFFER_MAX = 240;       // cap of media s in the target (the player ceiling is 4x = 120 s)

// "30 s of clock" amendment (2026-10-19, operator request): the slack follows the playbackRate.
// At 1x it is 30 s of media; at 4x, 120 s. The cap only binds above the player's ceiling.
export function bufferTarget(rate: number): number {
  return Math.min(PREFETCH * Math.max(1, rate || 1), BUFFER_MAX);
}
export const EDGE_POLL_MS = 1000;    // spec 2026-10-20 (D2): edge poll in live mode
export const MAX_EMPTY = 3;          // consecutive empty re-requests, fixed window: real end

// spec 2026-10-20 (D2, amendment E1 of the plan): pure decision of the poll when the playlist brought
// nothing new. In live the playlist is the only source of truth (the wall clock cannot know whether the
// file received the data — the NFS flush is late); always 'retry'. In VOD, `empty >= MAX_EMPTY`
// is the real end ('end' closes the chain); before that, 'retry'.
export type PollAction = 'retry' | 'end';
export function nextPollAction(q: { live: boolean; fresh: number; empty: number }): PollAction {
  if (q.fresh > 0) return 'retry';
  if (q.live) return 'retry';
  return q.empty >= MAX_EMPTY ? 'end' : 'retry';
}

// spec 2026-10-21 (4.5): the hour turned into a NEW file (retaken session): the playlist now points
// at a different init. The feed must fetch and append it BEFORE the new fragments. Pure for tests:
// an empty initUrl is "nothing to fetch", never a change.
export function needsNewInit(loadedInitUrl: string, next: ParsedPlaylist): boolean {
  return !!next.initUrl && next.initUrl !== loadedInitUrl;
}

export type Frag = { url: string; dur: number; ini: number; size: number; epoch?: number; initUrl?: string; initEnd?: number };
export type ParsedPlaylist = { initUrl: string; initEnd: number; frags: Frag[]; vod: boolean; end: boolean; representation?: string };

// ---- parse (pure, spec 4.1) ----
export function parsePlaylist(txt: string, base: string): ParsedPlaylist {
  let initUrl = '';
  let initEnd = 0;
  let vod = false;
  let end = false;
  const frags: Frag[] = [];
  let dur = 0; let ini = 0; let size = 0; let epoch: number | undefined;
  let firstInit = ''; let firstInitEnd = 0;
  let representation: string | undefined;
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('#EXT-X-OVMS-REPRESENTATION:')) { representation = t.split(':')[1]; continue; }
    if (t.startsWith('#EXT-X-MAP:')) {
      const u = /URI="([^"]+)"/.exec(t);
      const b = /BYTERANGE="(\d+)@0"/.exec(t);
      if (u) initUrl = new URL(u[1], base).href;
      if (b) initEnd = Number(b[1]);
    } else if (t.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const value = Date.parse(t.slice('#EXT-X-PROGRAM-DATE-TIME:'.length)) / 1000;
      epoch = Number.isFinite(value) ? value : undefined;
    } else if (t === '#EXT-X-PLAYLIST-TYPE:VOD') vod = true;
    else if (t === '#EXT-X-ENDLIST') end = true;
    else if (t.startsWith('#EXTINF:')) dur = Number(/[\d.]+/.exec(t.slice('#EXTINF:'.length))?.[0] ?? 0);
    else if (t.startsWith('#EXT-X-BYTERANGE:')) {
      const m = /^(\d+)@(\d+)$/.exec(t.slice('#EXT-X-BYTERANGE:'.length));
      if (m) { size = Number(m[1]); ini = Number(m[2]); }
    } else if (t && !t.startsWith('#')) {
      if (!firstInit) { firstInit = initUrl; firstInitEnd = initEnd; }
      frags.push({ url: new URL(t, base).href, dur, ini, size,
        ...(epoch === undefined ? {} : { epoch, initUrl, initEnd }) });
      if (epoch !== undefined) epoch += dur;
      dur = 0; ini = 0; size = 0;
    }
  }
  return { initUrl: firstInit || initUrl, initEnd: firstInitEnd || initEnd, frags, vod, end,
    ...(representation ? { representation } : {}) };
}

// ---- codec (pure, spec 4.2) ----
const encoder = new TextEncoder();

function indexOf(bytes: Uint8Array, target: string, from = 0): number {
  // `Uint8Array.indexOf` does NOT take a needle subarray (it looks for a VALUE): search by hand.
  const needle = encoder.encode(target);
  search: for (let i = from; i + needle.length <= bytes.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (bytes[i + j] !== needle[j]) continue search;
    return i;
  }
  return -1;
}

function upToMoof(bytes: Uint8Array): number {
  // The init ends at the first top-level `moof` (ftyp+moov). If any box size is unreadable, fall
  // back to the literal search (the 2026-10-19 probe used the same fallback).
  let p = 0;
  while (p + 8 <= bytes.length) {
    const size = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    const kind = new TextDecoder().decode(bytes.subarray(p + 4, p + 8));
    if (kind === 'moof') return p;
    if (size < 8) break;
    p += size;
  }
  const i = indexOf(bytes, 'moof', 8);
  return i < 0 ? bytes.length : i - 4;
}

export function codecFromInit(bytes: Uint8Array): string[] {
  const ini = bytes.subarray(0, upToMoof(bytes));
  const out: string[] = [];
  const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(2, '0');
  const avc = indexOf(ini, 'avcC');
  if (avc >= 0) {
    // profile/compat/level at +5..+7 of the literal: +4 is the configurationVersion (at +2 you
    // read the 'avcC' itself — measured in the probe, it comes out as junk like 634301).
    out.push(`avc1.${hex(ini[avc + 5])}${hex(ini[avc + 6])}${hex(ini[avc + 7])}`);
  }
  if (indexOf(ini, 'hvc1') >= 0) out.push('hvc1');
  else if (indexOf(ini, 'hev1') >= 0) out.push('hev1');
  if (indexOf(ini, 'mp4a') >= 0) out.push('mp4a.40.2');
  if (indexOf(ini, 'Opus') >= 0 || indexOf(ini, 'opus') >= 0) out.push('opus');
  return out;
}

// ---- feed (imperative; does not run in jsdom — no MSE there) ----
// visible state of the cell (spec 2026-10-19 state-feedback): 'connecting' = requesting the
// playlist; 'loading' = playlist ok, init/frags in flight. The first frame ('ready') belongs to the
// <video> (`loadeddata`), known by RecordingPlayer, not by the feed.
export type FeedState = 'connecting' | 'loading' | 'buffering' | 'ready';
export type FeedEvents = { onError?: (reason: string) => void; onState?: (e: FeedState) => void; onRepresentation?: (kind: string) => void };
export type Feed = {
  start: (playlistUrl: string, opts: { base: number; live: boolean; end: number; continuous?: boolean }) => void;
  currentTime: () => number;
  seek: (t: number) => void;            // BUFFER time
  seekEpoch: (ep: number) => void;      // target epoch (anchor table, amendment E2)
  play: (v: boolean) => void;
  paused: () => boolean;
  setSpeed: (v: number) => void;
  epochAt: (t: number) => number;
  stop?: () => void;
  destroy: () => void;
};

type Anchor = { epStart: number; epEnd: number; tStart: number; tEnd: number };

export function createFeed(video: HTMLVideoElement, ev: FeedEvents = {}): Feed {
  return createSessionFeed(video, ev);
}


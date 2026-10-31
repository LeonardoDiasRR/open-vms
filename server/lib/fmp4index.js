'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { defaultDuration, fragmentDuration } = require('./mp4-duration');

// ---- fMP4 parser/index (spec 2026-10-18, section 5.2) -----------------------------------
// Reads boxes by OFFSET on an fd (`fs.readSync` with a position): the `mdat` body is NEVER read —
// only the 8 or 16 byte header of each box. The file may be being written: an incomplete box at the
// end stops the scan and its offset comes back as `end`, so the next pass resumes there (the
// server's 500 ms timer) without re-reading what is already indexed.

// `HH.mp4` is session 0. The optional suffix `-s<n>` is a RETAKEN hour file (spec 2026-10-21): when a
// recording session dies in the middle of an hour, the next one opens `HH-s1.mp4`, `HH-s2.mp4`, ...
// `n` never repeats; hour 15 always opens at `15.mp4`. THE single source for hour-file names: the
// recorder and media-scan read the suffix from here, a second regex in another layer would diverge.
const HOUR_NAME = /^(\d{2})(?:-s([1-9]\d*))?\.mp4$/;

// Header of ONE box at `off`. `null` = incomplete box (recording in progress) or too short.
function boxHeader(fd, off, total) {
  const h = Buffer.alloc(8);
  if (fs.readSync(fd, h, 0, 8, off) < 8) return null;
  const raw = h.readUInt32BE(0);
  const type = h.toString('ascii', 4, 8);
  let size = raw;
  let header = 8;
  if (raw === 1) {
    const g = Buffer.alloc(8);
    if (fs.readSync(fd, g, 0, 8, off + 8) < 8) return null;
    size = Number(g.readBigUInt64BE(0));
    header = 16;
  } else if (raw === 0) {
    size = total - off;                // "to the end of the file": valid for the mdat of the last moof
  }
  if (size < header || off + size > total) return null;
  return { type, off, size, header, end: off + size };
}

// The body of a small box (moov/mo,moof): fits in memory. The `mdat` never goes through here.
function readBytes(fd, c) {
  const b = Buffer.alloc(c.size);
  fs.readSync(fd, b, 0, c.size, c.off);
  return b;
}

// Boxes of a buffer range (without descending into containers).
function boxes(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type, off: p, size, header });
    p += size;
  }
  return out;
}

// `mdhd` timescale of the FIRST track (the recording is `-map 0:v:0`: one video track).
function timescale(buf) {
  let ts = 0;
  const walk = (s, e) => {
    for (const c of boxes(buf, s, e)) {
      if (c.type === 'mdhd') {
        // version(1) + flags(3) + creation + modification, then the timescale (4 bytes)
        const ver = buf[c.off + c.header];
        if (!ts) ts = buf.readUInt32BE(c.off + c.header + (ver === 1 ? 20 : 12));
      } else if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(c.type)) {
        walk(c.off + c.header, c.off + c.size);
      }
    }
  };
  walk(0, buf.length);
  return ts;
}

// `tfdt` (base media decode time) of the moof: the fragment clock. `null` when missing.
function moofBase(buf) {
  let base = null;
  const walk = (s, e) => {
    for (const c of boxes(buf, s, e)) {
      if (c.type === 'tfdt') {
        const ver = buf[c.off + c.header];
        base = ver === 1 ? Number(buf.readBigUInt64BE(c.off + c.header + 4)) : buf.readUInt32BE(c.off + c.header + 4);
      } else if (c.type === 'moof' || c.type === 'traf') {
        walk(c.off + c.header, c.off + c.size);
      }
    }
  };
  walk(0, buf.length);
  return base;
}

// NOMINAL fragment duration: the MOST COMMON `tfdt` difference between neighboring fragments. A
// `tfdt` jump (spec 7.1.2) cannot become the duration of the one before it — if it did, the hole
// would disappear inside a long fragment and there would be no gap to report. 0 = unknown.
function nominalOf(bases) {
  const counts = new Map();
  for (let i = 1; i < bases.length; i++) {
    const d = bases[i] - bases[i - 1];
    if (d > 0) counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = 0;
  let times = 0;
  for (const [d, n] of counts) if (n > times || (n === times && d < best)) { best = d; times = n; }
  return best;                                 // in `tfdt` units
}

// Closes `t1` at the next `t0` — but NEVER beyond the nominal duration: anything past it is a gap.
function closeT1(t0, next, nominal) {
  return nominal > 0 ? Math.min(next, t0 + nominal) : next;
}

// Merged coverage of ONE hour (plan 2026-10-20): `[[t0, t1], ...]` in order, the last `t1` `null` while
// the hour is still recording. A run of neighbouring fragments collapses into a single interval, which is
// what lets the timeline and the gaps be answered with no fragment in memory. The 1 s tolerance is the
// same one `gaps()` uses: `tfdt` rounding is not a hole. Accepts fragment objects OR the flat
// quadruples the database stores.
function mergeCoverage(frags) {
  const out = [];
  for (const f of frags) {
    const t0 = Array.isArray(f) ? f[0] : f.t0;
    const raw = Array.isArray(f) ? f[1] : f.t1;
    const t1 = raw === undefined || raw === null ? null : raw;
    const last = out[out.length - 1];
    if (last && last[1] !== null && t0 - last[1] < 1) { last[1] = t1; continue; }
    out.push([t0, t1]);
  }
  return out;
}

// Does the hour hold any media inside [de, ate)? An open interval (still recording) reaches forever.
function coversAny(coverage, de, ate) {
  return coverage.some(([t0, t1]) => (t1 === null || t1 > de) && t0 < ate);
}

const COVERAGE_GRACE = 10; // s: tolerance after the last fragment of an open file (spec 2026-10-21, 4.4)

// Honest end of a card on the timeline: its own end when closed; when open, where the fragments
// actually reach (last end + nominal duration of the file's own fragments + GRACE) — NEVER `now`.
// Null when the open hour has no fragment: an empty file is not coverage.
function coverageEnd(card, frags, now, grace = COVERAGE_GRACE) {
  if (card.end !== null) return card.end;
  if (!frags || !frags.length) return null;
  const last = frags[frags.length - 1];
  if (last.t1 !== null) return Math.min(now, last.t1 + grace);
  const known = [];
  for (const f of frags) if (f.t1 !== null) known.push(f.t1 - f.t0);
  known.sort((a, b) => a - b);
  const nominal = known.length ? known[Math.floor(known.length / 2)] : 1; // median; floor of 1 s
  return Math.min(now, last.t0 + (last.duration || nominal) + grace);
}

// Indexes the file from offset `de` (0 = first read, which also reads the `moov`).
// Returns the NEW fragments (t0/t1 in seconds WITHIN the file; t1 = next tfdt, `null` on the last),
// the complete offset (`end`, resume point) and the end of the init segment.
// `null` = 0-byte file (the "0 is not a segment" rule survives, at hour granularity).
function indexFile(filePath, { de = 0, timescale: knownTs = 0, sampleDuration = 0 } = {}) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    const size = Number(st.size);
    const mtimeNs = Number(st.mtimeNs);
    if (size === 0) return null;
    const start = de > 0 && de <= size ? de : 0;
    let ts = start === 0 ? 0 : knownTs;
    let initFim = start === 0 ? 0 : null;
    const raw = [];
    let pending = null;
    // `complete` = end of the last CLOSED fragment (whole moof+mdat). It is the resume point:
    // stopping "where the scan stopped" would leave the `moof` of an incomplete fragment behind and
    // the next pass would skip that fragment forever.
    let complete = start === 0 ? 0 : de;
    let off = start;
    while (off < size) {
      const c = boxHeader(fd, off, size);
      if (!c) break;
      if (c.type === 'moov') {
        const data = readBytes(fd, c);
        ts = timescale(data) || ts;
        sampleDuration = defaultDuration(data) || sampleDuration;
        initFim = c.end;
        if (complete < c.end) complete = c.end;
      } else if (c.type === 'moof') {
        const data = readBytes(fd, c);
        pending = { off: c.off, base: moofBase(data), duration: fragmentDuration(data, sampleDuration) };
      } else if (c.type === 'mdat' && pending) {
        // the fragment is moof+mdat: the HLS byte range covers both
        raw.push({ base: pending.base, duration: pending.duration, byteStart: pending.off, size: c.end - pending.off });
        pending = null;
        complete = c.end;
      }
      off = c.end;
    }
    if (!ts) return { timescale: 0, initFim, nominal: 0, frags: [], end: complete, size, mtimeNs };
    // The fragments are ALWAYS in `t0` order: a `tfdt` that goes backwards in the file cannot leave
    // the list out of order — `findTimestamp` scans backwards relying on it (defect measured in the
    // review: t0 1006 indexed before 1004).
    const ordered = raw.filter((f) => f.base !== null).sort((a, b) => a.base - b.base);
    const nominal = nominalOf(ordered.map((f) => f.base)) / ts;
    const frags = [];
    for (let i = 0; i < ordered.length; i++) {
      const f = ordered[i];
      const t0 = f.base / ts;
      const next = ordered[i + 1];
      // `initFim` per fragment: whoever extracts a byte range needs the init of ITS file (the export
      // joins fragments from several files, each with its own init).
      frags.push({ t0, t1: next ? closeT1(t0, next.base / ts, f.duration / ts || nominal) : null,
        initFim, byteStart: f.byteStart, size: f.size, ...(f.duration > 0 ? { duration: f.duration / ts } : {}) });
    }
    return { timescale: ts, sampleDuration, initFim, nominal, frags, end: complete, size, mtimeNs };
  } finally {
    fs.closeSync(fd);
  }
}

// Path parts: <base>/<profile>/YYYY/MM/DD/HH.mp4
function pathParts(filePath) {
  const p = String(filePath).split(path.sep).join('/').split('/');
  if (p.length < 4) return null;
  const [hour, day, month, year] = [p[p.length - 1], p[p.length - 2], p[p.length - 3], p[p.length - 4]];
  const m = HOUR_NAME.exec(hour);
  if (!m || !/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) return null;
  return {
    year: +year, month: +month, day: +day, hour: +m[1], name: hour,
    session: m[2] === undefined ? 0 : Number(m[2]), // 0 = the hour file itself (spec 2026-10-21)
  };
}

// Sidecar `<file>.start`: the epoch instant the recorder wrote when ffmpeg opened the hour file
// (plan 2026-10-20). NFS has no `birthtime`, so on the production share this file is the only real
// anchor. Returns 0 for absent/unreadable/garbage content — it must never throw during a scan.
function readStartSidecar(filePath) {
  try {
    const text = fs.readFileSync(`${filePath}.start`, 'utf8').trim();
    return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : 0;
  } catch {
    return 0;
  }
}

// File anchor = epoch instant of the FIRST fragment. Precedence (plan 2026-10-20): (1) the sidecar —
// the true open instant written by the recorder; (2) `birthtimeMs`, which local filesystems give but
// NFS does NOT (the production share — hence the sidecar); (3) HH:00 from the name: last resort,
// wrong by the reconnect delay whenever ffmpeg opened the hour late (prod defect 2026-10-20).
function fileAnchor(filePath, stat = fs.statSync(filePath)) {
  const q = pathParts(filePath);
  if (!q) return 0;
  const side = readStartSidecar(filePath);             // 1. true source
  if (side) return side;
  const birth = Number(stat && stat.birthtimeMs) || 0; // 2. local fs
  if (birth > 0) return Math.floor(birth / 1000);
  return Math.floor(new Date(q.year, q.month - 1, q.day, q.hour, 0, 0).getTime() / 1000); // 3. name
}

// ---- In-memory index (derived from the file, NEVER persisted — spec 5.2) ----------------

const SCAN_MS = 500;      // spec 5.2: the timer that re-reads the hour file
const FRAG_CACHE = 8;     // plan 2026-10-20: hours of fragments kept in memory (LRU)
const DAY_CACHE = 64;     // plan 2026-10-20: (profile, day) windows kept in memory (~1.4 MB)

const pad2 = (n) => String(n).padStart(2, '0');
const dayTextOf = (q) => `${q.year}-${pad2(q.month)}-${pad2(q.day)}`;
const dayKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function mediaIdentity(file) {
  const q = pathParts(file);
  return q ? `${dayTextOf(q)}|${q.name}` : path.basename(String(file));
}

// Public card of a `media_hours` row: the same shape `hourOf` hands out, for the loader that answers the
// retention pass (`listAll`). Kept next to `hourOf` so the two shapes cannot drift.
function cardOfRow(row) {
  const c = Array.isArray(row.coverage) ? row.coverage : [];
  return { profile: row.profile_id, file: row.path, name: path.basename(String(row.path || '')),
    start: c.length ? c[0][0] : Number(row.anchor) || 0,
    end: c.length ? (c[c.length - 1][1] ?? null) : null,
    bytes: Number(row.size_bytes) || 0, fragments: Number(row.frag_count) || 0,
    initFim: Number(row.init_fim) || 0,
    day: row.day ? Math.floor(new Date(`${row.day}T00:00:00`).getTime() / 1000) : 0 };
}

class MediaIndex {
  constructor({ base, scanMs = SCAN_MS, anchor = fileAnchor, parse = indexFile,
    cacheHours = FRAG_CACHE, cacheDays = DAY_CACHE, loader = null, clock = () => new Date(), io = null }) {
    this.base = base;
    this.scanMs = scanMs;
    // test seam (same pattern as `recordOnce`/`onvif` in main): the test pins the anchor of the
    // synthetic hours, which are all born with the SAME birthtime when they are copies made in the
    // same second.
    this.anchor = anchor;
    // test seam for the discovery scan: counts (or replaces) the file reads without opening one.
    this.parse = parse;
    this.io = io;
    this.fileScans = new Map();
    this.profileScans = new Map();
    // profile -> Map('YYYY-MM-DD|HH.mp4' -> record). One record per HOUR FILE, as the table's primary
    // key: a profile keeps 24 records per recorded day.
    this.profiles = new Map();
    // profile -> Map('HH.mp4' -> record of the LATEST day): the playlist and the file route address an
    // hour by its bare name, as they always did.
    this.names = new Map();
    this.active = new Set();       // profiles recording now (the timer only scans these)
    this.sweepTick = 0;            // sweeper throttle (plan 2026-10-24): one pass every 60 ticks
    this.sweeping = false;         // one sweep in flight at a time
    this.timer = null;
    // plan 2026-10-20: called with the profile whose records changed — the write-behind hook. It is a
    // derived index, so a hook that throws must never break the scan.
    this.onChange = null;
    // Fragments of an hour are NOT kept on the records: they come from here, on demand
    // (`async (profile, day, hour) => [[t0, t1, byteStart, size], ...]`), and only the last
    // `cacheHours` hours stay in `fragCache`.
    this.loader = loader;
    this.loadFrags = (loader && loader.loadFrags) || null;
    this.cacheHours = cacheHours;
    this.fragCache = new Map();
    // Plan 2026-10-20: the ONLY thing kept from the archive is the (profile, day) window the UI asked
    // for. `dayCache` is the LRU (`profile|day` -> { profile, day }, insertion order); a day of an
    // active profile that is TODAY is pinned — it is the one being written.
    this.cacheDays = cacheDays;
    this.dayCache = new Map();
    this.pending = new Map();      // in-flight window loads, coalesced by key
    this.clock = clock;
  }

  // Record of an hour FILE (the parser keeps no state between passes). The file path is the identity:
  // `day`/`hour`/`name` come from it, and the same file always maps to the same record.
  record(profile, file) {
    const q = pathParts(file);
    const name = q ? q.name : path.basename(String(file));
    const key = q ? `${dayTextOf(q)}|${name}` : String(file);
    let byProfile = this.profiles.get(profile);
    if (!byProfile) { byProfile = new Map(); this.profiles.set(profile, byProfile); }
    let r = byProfile.get(key);
    if (!r) {
      r = { profile, name, file: String(file),
        hour: q ? q.hour : -1, session: q ? q.session : 0, dayText: q ? dayTextOf(q) : null,
        // `day` = epoch of the LOCAL MIDNIGHT of the day folder (the whole-day pruning of spec 5.5
        // compares `day + 86400`); `nominal` = typical fragment duration, measured on the file's fragments.
        anchor: 0, day: q ? Math.floor(new Date(q.year, q.month - 1, q.day).getTime() / 1000) : 0,
        timescale: 0, nominal: 0, initFim: 0, coverage: [], count: 0,
        // `frags` is null when the fragments are not in memory (plan 2026-10-20): only an hour being
        // scanned/recorded holds them, everything else is read on demand.
        frags: null,
        end: 0, bytes: 0, mtimeNs: 0, error: null };
      byProfile.set(key, r);
    }
    r.file = String(file);
    let byName = this.names.get(profile);
    if (!byName) { byName = new Map(); this.names.set(profile, byName); }
    const seen = byName.get(name);
    if (!seen || String(seen.dayText || '') <= String(r.dayText || '')) byName.set(name, r);
    return r;
  }

  // Reads ONE file from `r.end` and appends what appeared. Returns how many new fragments.
  scanFile(r) {
    // Without the fragments in memory an incremental read would leave a hole at the front of the list:
    // the hour is re-indexed from zero (the parser reads box headers only, never the `mdat`).
    if (!Array.isArray(r.frags)) { r.frags = []; r.end = 0; }
    let out;
    try {
      out = this.parse(r.file, { de: r.end, timescale: r.timescale, sampleDuration: r.sampleDuration });
    } catch (e) {
      r.error = e.message;
      return 0;
    }
    return this.applyScan(r, out);
  }

  async scanFileAsync(r) {
    if (!this.io) return this.scanFile(r);
    if (this.fileScans.has(r.file)) return this.fileScans.get(r.file);
    const task = (async () => {
      if (!Array.isArray(r.frags)) { r.frags = []; r.end = 0; }
      try {
        const out = await this.io.scan(r.file, { de: r.end, timescale: r.timescale,
          sampleDuration: r.sampleDuration, anchorNeeded: !r.anchor });
        if (this.profiles.get(r.profile)?.get(mediaIdentity(r.file)) !== r) return 0;
        return this.applyScan(r, out);
      } catch (e) { r.error = e.message; return 0; }
    })();
    this.fileScans.set(r.file, task);
    try { return await task; } finally { this.fileScans.delete(r.file); }
  }

  applyScan(r, out) {
    r.error = null;
    if (!out) return 0;                     // 0 bytes: not an hour file
    if (!r.anchor) r.anchor = out.anchor || this.anchor(r.file);
    r.timescale = out.timescale || r.timescale;
    r.sampleDuration = out.sampleDuration || r.sampleDuration;
    if (out.nominal) r.nominal = out.nominal;
    if (out.initFim !== null) r.initFim = out.initFim;
    r.end = out.end;
    r.bytes = out.size;
    if (out.mtimeNs) r.mtimeNs = out.mtimeNs;
    let fresh = 0;
    for (const f of out.frags) {
      r.frags.push({ t0: r.anchor + f.t0, t1: f.t1 === null ? null : r.anchor + f.t1,
        initFim: r.initFim, byteStart: f.byteStart, size: f.size, ...(f.duration ? { duration: f.duration } : {}) });
      fresh += 1;
    }
    if (fresh) {
      // `tfdt` out of order in the file: the index list is reordered and each fragment's `t1` is
      // rebuilt from the next one (and not from a "next" the incremental scan did not see).
      r.frags.sort((a, b) => a.t0 - b.t0);
      for (let i = 0; i + 1 < r.frags.length; i++) {
        r.frags[i].t1 = closeT1(r.frags[i].t0, r.frags[i + 1].t0, r.frags[i].duration || r.nominal);
      }
      this.syncCoverage(r);
      this.notify(r.profile);
    }
    return fresh;
  }

  // Keeps the hour METADATA in step with its fragments: merged coverage and count are what the timeline
  // and the gaps read (plan 2026-10-20).
  syncCoverage(r) {
    r.coverage = mergeCoverage(r.frags);
    r.count = r.frags.length;
    this.fragCache.delete(r.file);         // the cached copy (if any) is older than this one
  }

  // Reads the current day of ONE profile: readdir + index what changed. This is what the timer runs.
  // Regression 2026-10-20 (rollback in production): with an EMPTY day-cache this function used to
  // readdir and re-open the whole day of every recording profile (45 × 24 files on NFS): the event
  // loop froze in D-state and /health timed out for minutes. It must NEVER hydrate from disk: an
  // unloaded `profile|day` triggers the async loader and yields (returns 0) for this tick; the boot
  // pins the current day of every recording profile BEFORE `start()` so the first tick finds rows.
  scanProfile(profile, when = new Date()) {
    const dayText = dayKeyOf(when);
    if (this.loader && this.loader.loadWindow && !this.dayCache.has(`${profile}|${dayText}`)) {
      // ponytail: fire and forget — `pending` coalesces the concurrent ticks; the retry is the tick.
      this.loadDays(profile, [dayText]).catch(() => { /* the next tick asks again */ });
      return 0;
    }
    const dir = path.join(this.base, profile, String(when.getFullYear()),
      String(when.getMonth() + 1).padStart(2, '0'), String(when.getDate()).padStart(2, '0'));
    let names;
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let fresh = 0;
    for (const name of names.sort()) {
      if (!HOUR_NAME.test(name)) continue;         // the .m4s of the old layout is ignored here
      const r = this.record(profile, path.join(dir, name));
      let st;
      try { st = fs.statSync(r.file, { bigint: true }); } catch { continue; }
      // bigint: `mtimeNs` must come in the SAME domain the records store (Number of the bigint ns —
      // the float `mtimeNs` of a plain statSync rounds differently and would never match).
      const size = Number(st.size);
      // Only files that GREW get opened (same guard as the discovery scan): a record loaded from
      // `media_hours` holds no fragments but already matches the disk — re-opening it every tick
      // was the boot stall. It also stops a closed hour from being re-parsed from zero.
      if (r.count && r.bytes === size && r.mtimeNs === Number(st.mtimeNs)) continue;
      // REPLACED file (smaller than what is already indexed) restarts from zero: the old offset is void
      if (size < r.end) r.end = 0;
      fresh += this.scanFile(r);
    }
    return fresh;
  }

  // Boot pin (fix 2026-10-20): loads the CURRENT day of each recording profile from the loader, so
  // the first timer tick finds rows and opens only what grew. Errors propagate to the caller
  // (main.js: listen first, log, the tick guard keeps the timer off disk meanwhile).
  async pinCurrentDays(profiles) {
    const day = dayKeyOf(this.clock());
    await Promise.all([...new Set(profiles)].map((profile) => this.loadDays(profile, [day])));
  }

  async scanProfileAsync(profile, when = new Date()) {
    if (!this.io) return this.scanProfile(profile, when);
    if (this.profileScans.has(profile)) return this.profileScans.get(profile);
    const task = (async () => {
      const day = dayKeyOf(when);
      await this.loadDays(profile, [day]);
      const dir = path.join(this.base, profile, String(when.getFullYear()),
        pad2(when.getMonth() + 1), pad2(when.getDate()));
      let names;
      try { names = await fs.promises.readdir(dir); } catch { return 0; }
      let fresh = 0;
      for (const name of names.sort()) {
        if (!HOUR_NAME.test(name)) continue;
        const r = this.record(profile, path.join(dir, name));
        let st;
        try { st = await fs.promises.stat(r.file, { bigint: true }); } catch { continue; }
        if (r.count && r.bytes === Number(st.size) && r.mtimeNs === Number(st.mtimeNs)) continue;
        if (Number(st.size) < r.end) { r.end = 0; r.frags = null; }
        fresh += await this.scanFileAsync(r);
      }
      return fresh;
    })();
    this.profileScans.set(profile, task);
    try { return await task; } finally { this.profileScans.delete(profile); }
  }

  // FULL scan (boot): every profile, every day present on disk. Files ignored by name
  // (`segment_NNNNNN.m4s`) simply do not enter.
  load() {
    let names;
    try { names = fs.readdirSync(this.base); } catch { return 0; }
    let total = 0;
    for (const profile of names.sort()) {
      const root = path.join(this.base, profile);
      let years;
      try { if (!fs.statSync(root).isDirectory()) continue; years = fs.readdirSync(root); } catch { continue; }
      for (const year of years) {
        let months;
        try { months = fs.readdirSync(path.join(root, year)); } catch { continue; }
        for (const month of months) {
          let days;
          try { days = fs.readdirSync(path.join(root, year, month)); } catch { continue; }
          for (const day of days) {
            const dir = path.join(root, year, month, day);
            let files;
            try { files = fs.readdirSync(dir); } catch { continue; }
            for (const name of files.sort()) {
              if (!HOUR_NAME.test(name)) continue;
              const r = this.record(profile, path.join(dir, name));
              total += this.scanFile(r);
            }
          }
        }
      }
    }
    this.closeNeighbors();
    return total;
  }

  // Same walk as `load()`, but asynchronous and yielding between days: the API can listen and answer
  // while the archive is indexed. Readdir on the NFS share is the slow part; it never blocks the loop.
  async loadAsync() {
    const fsp = fs.promises;
    let names;
    try { names = await fsp.readdir(this.base); } catch { return 0; }
    let total = 0;
    for (const profile of names.sort()) {
      const root = path.join(this.base, profile);
      let years;
      try { if (!(await fsp.stat(root)).isDirectory()) continue; years = await fsp.readdir(root); } catch { continue; }
      for (const year of years) {
        let months;
        try { months = await fsp.readdir(path.join(root, year)); } catch { continue; }
        for (const month of months) {
          let days;
          try { days = await fsp.readdir(path.join(root, year, month)); } catch { continue; }
          for (const day of days) {
            const dir = path.join(root, year, month, day);
            let files;
            try { files = await fsp.readdir(dir); } catch { continue; }
            for (const name of files.sort()) {
              if (!HOUR_NAME.test(name)) continue;
              const r = this.record(profile, path.join(dir, name));
              total += await this.scanFileAsync(r);
            }
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      }
    }
    this.closeNeighbors();
    return total;
  }

  // The last fragment of a file is closed by the FIRST one of the NEXT file of the same profile. The
  // profile's last file stays with t1 = null (live) — which is what the timeline calls `gravando`.
  closeNeighbors() {
    for (const byProfile of this.profiles.values()) {
      const records = [...byProfile.values()].filter((r) => Array.isArray(r.frags) && r.frags.length)
        .sort((a, b) => a.anchor - b.anchor);
      for (let i = 0; i + 1 < records.length; i++) {
        if (this.closeLastFrag(records[i], records[i].frags)) {
          this.syncCoverage(records[i]);
          this.notify(records[i].profile);
        }
      }
    }
  }

  // Closes the open LAST fragment of an hour from the spacing of ITS own fragments: the next file's
  // `tfdt` does not exist here, and the first fragment of the next file starts after the reconnect —
  // the difference between this `end` and that `start` IS the hour-switch gap (spec 5.1). Shared by
  // `closeNeighbors` and the sweeper (plan 2026-10-24) so the two closers cannot drift. True = closed.
  closeLastFrag(r, frags) {
    const last = frags[frags.length - 1];
    if (!last || last.t1 !== null) return false;
    const nominal = last.duration || r.nominal || (frags.length > 1 ? last.t0 - frags[frags.length - 2].t0 : 0);
    if (nominal <= 0) return false;
    last.t1 = last.t0 + nominal;
    return true;
  }

  // Hour rows hydrated from the database arrive WITHOUT fragments (plan 2026-10-20), so
  // `closeNeighbors` never sees their open last fragment: an abandoned hour kept answering every
  // window as "still recording" (defect measured 2026-10-24, Aeroporto PTZ). The sweeper hands the
  // fragments back to the ABANDONED hours only — the newest record of the profile (the one that may
  // still receive data) is never touched. With the fragments on the record, `closeNeighbors` closes
  // the coverage on the same tick and the write-behind persists it (the row re-enters `snapshot`).
  async collectOpenHourFragments(limit = 20) {
    if (!this.loadFrags) return 0;
    const wanted = [];
    for (const byProfile of this.profiles.values()) {
      const records = [...byProfile.values()];
      if (records.length < 2) continue;
      let newest = records[0];
      for (const r of records) if (r.anchor >= newest.anchor) newest = r;
      for (const r of records) {
        if (r === newest || Array.isArray(r.frags) || !r.coverage.length) continue;
        if (r.coverage[r.coverage.length - 1][1] !== null) continue;
        wanted.push(r);
      }
    }
    let n = 0;
    for (const r of wanted.slice(0, limit)) {
      const frags = await this.loadHour(r);
      if (!frags.length || this.profiles.get(r.profile)?.get(mediaIdentity(r.file)) !== r) continue;
      if (Array.isArray(r.frags)) continue;             // a scan won the race: its data is newer
      r.frags = frags;
      // close NOW, not on the next `closeNeighbors`: after a restart the NEWEST hour can also be a
      // database row without fragments, and `closeNeighbors` never closes the last of its list.
      if (this.closeLastFrag(r, frags)) { this.syncCoverage(r); this.notify(r.profile); }
      n += 1;
    }
    return n;
  }

  // ---- persistence (plan 2026-10-20) ----

  // The hook never breaks the scan: the index is derived from disk, the database is a copy.
  notify(profile) {
    if (!this.onChange) return;
    try {
      this.onChange(profile);
    } catch { /* derived: a failing write-behind must not interrupt the scan */ }
  }

  // ---- day windows (plan 2026-10-20) ----

  // Day keys ('YYYY-MM-DD', local) touched by the instant window [from, to]. A window WIDER than the
  // day cache returns []: loading it would evict its own days mid-answer, and enumerating a window of
  // `Number.MAX_SAFE_INTEGER` seconds (an "everything" export range) would hang on the loop itself.
  // Such windows are answered from what is already in memory (the API caps export at 30 min anyway).
  daysIn(from, to) {
    const out = [];
    if (!Number.isFinite(Number(from)) || !Number.isFinite(Number(to))) return out;
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const d = new Date(start * 1000);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() / 1000 <= end) {
      if (out.length > this.cacheDays) return [];
      out.push(dayKeyOf(d));
      d.setDate(d.getDate() + 1);            // ponytail: local calendar step, no DST in the deployment zone
    }
    return out;
  }

  // The day a recording profile is writing RIGHT NOW is pinned: it is never evicted.
  pinned(profile, day) {
    return this.active.has(profile) && day === dayKeyOf(this.clock());
  }

  // Does any record of this day hold fragments the database does not have yet? Then the day stays.
  holdsFrags(profile, day) {
    const byProfile = this.profiles.get(profile);
    if (!byProfile) return false;
    for (const r of byProfile.values()) if (r.dayText === day && Array.isArray(r.frags)) return true;
    return false;
  }

  // Loads the days of ONE window that are not in memory, in ONE query (`loader.loadWindow`). Concurrent
  // calls for the same window share the in-flight promise: two timeline polls of a cold day cost one
  // query. Returns how many days it had to ask for.
  async loadDays(profile, days = []) {
    const want = [...new Set(days)];
    const missing = want.filter((day) => !this.dayCache.has(`${profile}|${day}`));
    if (!missing.length || !this.loader || !this.loader.loadWindow) return 0;
    const key = `${profile}|${missing.join(',')}`;
    let job = this.pending.get(key);
    if (!job) {
      job = (async () => {
        const rows = await this.loader.loadWindow(profile, missing);
        this.applyRows(profile, rows);
        for (const day of missing) this.noteDay(profile, day);
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
    await job;
    return missing.length;
  }

  // Marks a day as loaded, in LRU order, and keeps the cache bounded.
  noteDay(profile, day) {
    const key = `${profile}|${day}`;
    this.dayCache.delete(key);
    this.dayCache.set(key, { profile, day });
    this.evictDays();
  }

  // Drops the least recently used windows beyond `cacheDays`. A pinned day (today, recording) and a day
  // holding fragments the write-behind has not stored yet are skipped: evicting them would lose data.
  evictDays() {
    let evicted = 0;
    for (const [key, v] of this.dayCache) {
      if (this.dayCache.size <= this.cacheDays) break;
      if (this.pinned(v.profile, v.day) || this.holdsFrags(v.profile, v.day)) continue;
      this.dayCache.delete(key);
      this.dropDay(v.profile, v.day);
      evicted += 1;
    }
    return evicted;
  }

  // Forgets every record of ONE day of one profile: the next timeline of that day queries it again.
  dropDay(profile, day) {
    const byProfile = this.profiles.get(profile);
    if (!byProfile) return 0;
    let n = 0;
    for (const [key, r] of byProfile) {
      if (r.dayText !== day) continue;
      byProfile.delete(key);
      this.fragCache.delete(r.file);
      n += 1;
    }
    if (!byProfile.size) this.profiles.delete(profile);
    this.reindexNames(profile);
    return n;
  }

  // Rebuilds the records of a window from `media_hours` rows (the old boot hydration, now on demand).
  // NOT a single fragment object is created (plan 2026-10-20): `coverage` + `frag_count` carry what the
  // timeline needs, and the fragments of an hour are read only when someone seeks into it. An hour the
  // scan just read from DISK keeps its own data: the stored row may be older (write-behind debounce).
  applyRows(profile, rows = []) {
    let n = 0;
    for (const row of rows) {
      const r = this.record(row.profile_id || profile, row.path);
      if (Array.isArray(r.frags) && r.frags.length) continue;
      r.anchor = Number(row.anchor) || 0;
      // `day` = epoch of the local midnight of the day folder, the unit retention compares.
      r.day = row.day ? Math.floor(new Date(`${row.day}T00:00:00`).getTime() / 1000) : r.day;
      r.timescale = Number(row.timescale) || 0;
      r.nominal = (Number(row.nominal_ms) || 0) / 1000;
      r.initFim = Number(row.init_fim) || 0;
      r.end = Number(row.end_ts) || 0;      // resume point of the incremental read
      r.bytes = Number(row.size_bytes) || 0;
      r.mtimeNs = Number(row.mtime_ns) || 0;
      r.error = row.error || null;
      const loaded = Array.isArray(row.frags) ? row.frags : null;
      // Rows written before 004 carry no `coverage`: it is derived from the fragments on the way in
      // (the fallback of `upsertHours`), never kept.
      r.coverage = Array.isArray(row.coverage) && row.coverage.length ? row.coverage.map((i) => [i[0], i[1] ?? null])
        : (loaded ? mergeCoverage(loaded) : []);
      r.count = Number(row.frag_count) || (loaded ? loaded.length : 0);
      r.frags = null;                       // on demand: `fragsFor`/`loadHour`
      n += 1;
    }
    return n;
  }

  // Rows ready for `upsertHours`. `only` limits it to one profile — the write-behind touches only what
  // changed. An hour whose fragments are NOT in memory is skipped: the row in the database is the only
  // copy of them, and writing an empty list would erase it.
  snapshot(only) {
    const out = [];
    for (const [profile, byProfile] of this.profiles) {
      if (only && profile !== only) continue;
      for (const r of byProfile.values()) {
        if (!r.file || !Array.isArray(r.frags) || !r.frags.length) continue;
        const q = pathParts(r.file);
        if (!q) continue;
        out.push({
          profile_id: profile, day: `${q.year}-${pad2(q.month)}-${pad2(q.day)}`, hour: q.hour, path: r.file,
          session: q.session,
          size_bytes: r.bytes || 0, mtime_ns: r.mtimeNs || 0,
          timescale: r.timescale || null, nominal_ms: Math.round((r.nominal || 0) * 1000) || null,
          init_fim: r.initFim || null, anchor: r.anchor || null, end_ts: r.end || null,
          frags: r.frags.map((f) => [f.t0, f.t1, f.byteStart, f.size, ...(f.duration ? [f.duration] : [])]),
          coverage: r.coverage, frag_count: r.count, error: r.error || null,
        });
      }
    }
    return out;
  }

  // Hands the fragments of the hours that stopped changing back to the database (plan 2026-10-20): after
  // the write-behind has persisted them they are only one query away. A profile that is RECORDING keeps
  // its fragments (the 500 ms timer appends to them) and, without a loader, nothing is released — the
  // in-memory store has no other copy.
  release(profile) {
    if (!this.loadFrags) return 0;
    if (this.active.has(profile)) return 0;
    const byProfile = this.profiles.get(profile);
    if (!byProfile) return 0;
    let n = 0;
    for (const r of byProfile.values()) {
      if (!Array.isArray(r.frags)) continue;
      r.frags = null;
      this.fragCache.delete(r.file);
      n += 1;
    }
    return n;
  }

  // Drops the records of files that no longer exist (retention, orphan sweep). The rows are removed by
  // the caller — this only stops the index from answering for a deleted file.
  forget(paths = []) {
    const gone = new Set(paths);
    if (!gone.size) return 0;
    let n = 0;
    const touched = new Set();
    for (const [profile, byProfile] of this.profiles) {
      for (const [key, r] of byProfile) {
        if (!gone.has(r.file)) continue;
        byProfile.delete(key);
        // The day is no longer complete: the next timeline of it asks the database again.
        this.dayCache.delete(`${profile}|${r.dayText}`);
        touched.add(profile);
        n += 1;
      }
    }
    for (const profile of touched) this.reindexNames(profile);
    for (const file of gone) this.fragCache.delete(file);
    return n;
  }

  // Bare-name view of one profile: the LATEST day answers (that is what the routes address).
  reindexNames(profile) {
    const byProfile = this.profiles.get(profile);
    const byName = new Map();
    for (const r of byProfile ? byProfile.values() : []) {
      const cur = byName.get(r.name);
      if (!cur || String(cur.dayText || '') <= String(r.dayText || '')) byName.set(r.name, r);
    }
    this.names.set(profile, byName);
    return byName;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const profile of this.active) {
        if (this.io) void this.scanProfileAsync(profile).catch(() => {});
        else this.scanProfile(profile);
      }
      this.closeNeighbors();
      // Abandoned rows need their fragments back before anything can close them (plan 2026-10-24):
      // one sweep every 60 ticks (~30 s), fire and forget — the tick must not await.
      if (++this.sweepTick % 60 === 0 && !this.sweeping) {
        this.sweeping = true;
        this.collectOpenHourFragments().catch(() => {}).finally(() => { this.sweeping = false; });
      }
    }, this.scanMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // The recorder tells which profiles are recording: the timer only scans those (the rest do not change).
  markActive(profile, active = true) {
    if (active) this.active.add(profile);
    else this.active.delete(profile);
  }

  // ---- queries (spec 5.2, plan 2026-10-20) ----

  // Hour records of the profile, chronological. METADATA ONLY: a record holds its coverage and count,
  // never the fragment list (an hour being recorded is the exception).
  records(profile) {
    const byProfile = this.profiles.get(profile);
    if (!byProfile) return [];
    return [...byProfile.values()].filter((r) => r.file && r.coverage.length)
      .sort((a, b) => a.anchor - b.anchor);
  }

  // The public shape of one hour: { profile, name, file, start, end|null, bytes, fragments, initFim, day }
  hourOf(r) {
    const c = r.coverage;
    return { profile: r.profile, file: r.file, name: r.name,
      identity: mediaIdentity(r.file), anchor: r.anchor, start: c[0][0],
      end: c[c.length - 1][1], bytes: r.bytes, fragments: r.count, initFim: r.initFim, day: r.day };
  }

  // Hour files of the profile, in order. With a window [from, to) it loads the days the window touches
  // (one query for the missing ones) and answers the cards that OVERLAP it — a loaded neighbour day
  // does not leak into the answer. Without a window it answers what is already in memory.
  async hours(profile, from = null, to = null) {
    const window = Number.isFinite(from) && Number.isFinite(to);
    if (window) await this.loadDays(profile, this.daysIn(from, to));
    const cards = this.records(profile).map((r) => this.hourOf(r));
    if (!window) return cards;
    return cards.filter((h) => (h.end === null || h.end > from) && h.start < to);
  }

  // ALL hour files of ALL profiles, chronological order: the retention entry
  // (`runRetention({ hours: await index.all() })`, spec 5.5). The loader answers from `media_hours` in
  // one metadata query — retention needs the whole archive, so nothing here is cached.
  async all() {
    if (this.loader && this.loader.listAll) return (await this.loader.listAll()).sort((a, b) => a.start - b.start);
    const out = [];
    for (const profile of [...this.profiles.keys()].sort()) out.push(...(await this.hours(profile)));
    return out.sort((a, b) => a.start - b.start);
  }

  // Hour file that CONTAINS `ts` (or the profile's LAST one when `ts` is missing/outside the
  // recording): it is the file the playlist lists. A playlist NEVER crosses the boundary of two
  // files — each one has its own `EXT-X-MAP`, and the client swaps the playlist when seeking to
  // another hour.
  async fileAt(profile, ts) {
    // `Number(null)` is 0: the missing value has to be rejected BEFORE any coercion.
    const given = ts !== undefined && ts !== null && Number.isFinite(Number(ts));
    if (given) await this.loadDays(profile, this.daysIn(Number(ts), Number(ts)));
    const hours = await this.hours(profile);
    if (!hours.length) return null;
    if (!given) return hours[hours.length - 1];
    const t = Number(ts);
    if (t < hours[0].start) return hours[0];                 // before the start: the oldest one
    // ponytail: newest match wins when an older recording still has an open end.
    return hours.findLast((h) => h.start <= t && (h.end === null || t < h.end)) || hours[hours.length - 1];
  }

  // Fragments of ONE hour, ON DEMAND (plan 2026-10-20). An hour being recorded is answered from memory;
  // everything else comes from `loadFrags` (one PK query) and lives in an LRU of `cacheHours` hours.
  async fragsFor(profile, hour) {
    const name = typeof hour === 'number' ? `${pad2(hour)}.mp4` : String(hour || '');
    const r = this.recordFor(profile, name);
    return r ? this.loadHour(r) : [];
  }

  async loadHour(r) {
    if (Array.isArray(r.frags)) return r.frags;        // hour in scan memory (recording now)
    const hit = this.fragCache.get(r.file);
    if (hit) { this.fragCache.delete(r.file); this.fragCache.set(r.file, hit); return hit; }
    let quads = [];
    if (this.loadFrags) {
      try { quads = await this.loadFrags(r.profile, r.dayText, r.hour, r.session || 0); } catch { quads = []; }
    }
    const frags = (quads || []).map((f) => ({ t0: f[0], t1: f[1] === null || f[1] === undefined ? null : f[1],
      initFim: r.initFim, byteStart: f[2], size: f[3], ...(f[4] ? { duration: f[4] } : {}) }));
    this.fragCache.delete(r.file);
    this.fragCache.set(r.file, frags);
    while (this.fragCache.size > this.cacheHours) this.fragCache.delete(this.fragCache.keys().next().value);
    return frags;
  }

  // Fragments of an indexed hour file (shallow copy: the caller does not mutate the cache). Each
  // fragment carries the `initFim` of ITS file — the export needs the init next to the byte range.
  async fragments(profile, name) {
    return (await this.fragsFor(profile, name)).map((f) => ({ ...f }));
  }

  // Fragment that CONTAINS the requested instant (spec 5.2): BINARY search in the hour files — the list
  // is sorted by `start` — and a backwards scan inside the file (at most ~3600 fragments per hour with a
  // 1 s GOP). `null` = the instant is not recorded.
  async findTimestamp(profile, ts, now = Math.floor(Date.now() / 1000)) {
    await this.loadDays(profile, this.daysIn(ts, ts));
    const records = this.records(profile);
    if (!records.length) return null;
    let chosen = null;
    let lo = 0;
    let hi = records.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.hourOf(records[mid]).start <= ts) { chosen = records[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    if (!chosen) return null;
    const frags = await this.loadHour(chosen);
    for (let i = frags.length - 1; i >= 0; i--) {
      const f = frags[i];
      if (f.t0 <= ts && ts < (f.t1 === null ? now + 1 : f.t1)) {
        return { file: chosen.file, byteStart: f.byteStart, size: f.size };
      }
    }
    return null;
  }

  // Fragments covering the window [de, ate), in order: it is what the HLS playlist lists and what the
  // export receives. Each item carries the `initFim` of the source file (spec 5.5). Only the hour files
  // that OVERLAP the window are read (the coverage says which, without opening anything).
  async range(profile, de, ate, now = Math.floor(Date.now() / 1000)) {
    await this.loadDays(profile, this.daysIn(de, ate));
    const out = [];
    for (const r of this.records(profile)) {
      if (!coversAny(r.coverage, de, ate)) continue;
      for (const f of await this.loadHour(r)) {
        const t1 = f.t1 ?? now + 1;
        if (t1 <= de || f.t0 >= ate) continue;
        out.push({ file: r.file, initFim: r.initFim, byteStart: f.byteStart,
          size: f.size, t0: f.t0, t1: f.t1 });
      }
    }
    return out;
  }

  // Segments per hour file (the timeline keeps the CURRENT response format, spec 5.2).
  async segments(profile, de, ate, now = Math.floor(Date.now() / 1000)) {
    const out = [];
    for (const h of await this.hours(profile, de, ate)) {
      // spec 2026-10-21 (4.4): an open hour ends where its COVERAGE ends, not at `now`. A dead
      // session stops growing; the green bar stops where the pixels stopped.
      let end_ts = h.end;
      if (end_ts === null) {
        end_ts = coverageEnd(h, await this.loadHour(this.record(h.profile, h.file)), now, COVERAGE_GRACE);
        if (end_ts === null) continue; // open hour without fragments: not coverage (spec 2)
      }
      if (end_ts > de && h.start < ate) {
        out.push({ start_ts: h.start, end_ts, bytes: h.bytes, file: h.file });
      }
    }
    return out;
  }

  // The open recording of the window with its HONEST end (spec 2026-10-21, 4.4): the last open hour,
  // ending where its fragments end (+ GRACE). The API cannot compute this from cards — only the
  // index can read the fragments of an open hour. Null when nothing is open.
  async recordingWindow(profile, from, to, now = Math.floor(Date.now() / 1000)) {
    const open = (await this.hours(profile, from, to)).filter((h) => h.end === null);
    if (!open.length) return null;
    const card = open[open.length - 1];
    const end = coverageEnd(card, await this.loadHour(this.record(card.profile, card.file)),
      now, COVERAGE_GRACE);
    return end === null ? null : { from: card.start, to: end };
  }

  // Gaps: the INTERNAL ones of each file (a `tfdt` jump the parser does not let become a duration —
  // spec 7.1.2) and the hour-switch ones (the reconnect lands here when `birthtime` exists). It does
  // not invent a gap for an open file. Both come from the COVERAGE: a hole is exactly what merging
  // refused to swallow, so the answer costs no fragment read at all (plan 2026-10-20).
  async gaps(profile, de, ate) {
    await this.loadDays(profile, this.daysIn(de, ate));
    const out = [];
    const records = this.records(profile);
    for (const r of records) {
      const c = r.coverage;
      for (let i = 0; i + 1 < c.length; i++) {
        const end = c[i][1];
        const next = c[i + 1][0];
        if (end === null || next - end < 1) continue;   // tfdt rounding is not a gap
        if (next > de && end < ate) out.push({ from_ts: end, to_ts: next });
      }
    }
    for (let i = 0; i + 1 < records.length; i++) {
      const end = this.hourOf(records[i]).end;
      if (end === null) continue;                 // an open file has no boundary to compare
      const start = this.hourOf(records[i + 1]).start;
      if (start - end < 1) continue;             // tfdt rounding is not a gap
      if (start > de && end < ate) out.push({ from_ts: end, to_ts: start });
    }
    return out.sort((a, b) => a.from_ts - b.from_ts);
  }

  // Path of the hour file requested by the URL. Fail-closed: only what the index ALREADY indexed.
  recordFor(profile, name) {
    if (/^\d{4}-\d{2}-\d{2}\|\d{2}(?:-s[1-9]\d*)?\.mp4$/.test(name || '')) {
      return this.profiles.get(profile)?.get(name) || null;
    }
    const byName = this.names.get(profile);
    return byName && HOUR_NAME.test(name || '') ? byName.get(name) : null;
  }

  pathOf(profile, name) {
    const r = this.recordFor(profile, name);
    return r && r.file ? r.file : null;
  }
}

module.exports = { HOUR_NAME, SCAN_MS, DAY_CACHE, indexFile, pathParts, fileAnchor, mediaIdentity, mergeCoverage,
  coverageEnd, COVERAGE_GRACE, cardOfRow, MediaIndex, boxHeader, timescale, moofBase };


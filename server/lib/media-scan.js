'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HOUR_NAME } = require('./fmp4index');

// Incremental discovery (plan 2026-10-20, T8): readdir + stat, never a file read that is not needed.
//   - a day folder whose mtime matches the stored one AND that is older than yesterday is skipped
//     without a readdir (an NFS share does not always update the mtime: today and yesterday are always
//     read, so a lost mtime only delays the discovery by one day, it never loses it);
//   - a file whose size and mtime match the indexed record is not opened at all (the record of a day
//     being read is hydrated from `media_hours` first, never paid for with an NFS read);
//   - a file that shrank restarts the read from zero (it was replaced).
// The rows of the hours that vanished come out at the end of the same pass.

const pad = (n) => String(n).padStart(2, '0');
const dayText = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const keyOf = (profile, day) => `${profile}|${day}`;

function createMediaScanner({ index, media, base, log = console }) {
  const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

  async function run(now = new Date()) {
    const fsp = fs.promises;
    const yesterday = dayText(now.getFullYear(), now.getMonth() + 1, now.getDate() - 1);
    const known = new Map((await media.loadDays()).map((d) => [keyOf(d.profile_id, d.day), d]));
    const visited = new Set();     // day folders that exist now
    const read = new Set();        // day folders whose file list was read in this pass
    const seen = new Set();        // hour files that exist now
    const dayRows = [];
    let opened = 0;

    let profiles = [];
    // spec 2026-10-20 (export folder): <archive_dir>/export/ holds finished clips, not hour files.
    try { profiles = (await fsp.readdir(base)).filter((n) => n !== 'export').sort(); }
    catch (err) { log.warn('media: scan cannot read ' + base + ': ' + err.message); return { opened: 0, removed: 0, days: 0 }; }

    for (const profile of profiles) {
      // The 500 ms timer owns the profiles that are recording: two writers of the same record is a race.
      if (index.active.has(profile)) continue;
      const root = path.join(base, profile);
      let years;
      try {
        if (!(await fsp.stat(root)).isDirectory()) continue;
        years = (await fsp.readdir(root)).sort();
      } catch { continue; }
      for (const year of years) {
        let months;
        try { months = (await fsp.readdir(path.join(root, year))).sort(); } catch { continue; }
        for (const month of months) {
          let days;
          try { days = (await fsp.readdir(path.join(root, year, month))).sort(); } catch { continue; }
          for (const day of days) {
            const dir = path.join(root, year, month, day);
            const dayKey = dayText(year, month, day);
            let st;
            try { st = await fsp.stat(dir, { bigint: true }); } catch { continue; }
            if (!st.isDirectory()) continue;
            const key = keyOf(profile, dayKey);
            visited.add(key);
            const prev = known.get(key);
            const dirMtime = Number(st.mtimeNs);
            if (prev && Number(prev.dir_mtime_ns) === dirMtime && dayKey < yesterday) continue;

            let files;
            try { files = (await fsp.readdir(dir)).filter((n) => HOUR_NAME.test(n)).sort(); } catch { continue; }
            read.add(key);
            // Boot regression 2026-10-20 (production): the day-cache is EMPTY at boot, so `record()`
            // returned a fresh count=0 card for EVERY hour and the walk re-opened all 77 archived days
            // from NFS (~15 s/file, /health dead for minutes). The `media_hours` rows already hold the
            // answer: hydrate the day about to be read from the DATABASE (loader -> applyRows), once
            // per profile/day. A day without rows stays the real discovery case: empty cards, the
            // files below are opened. A failed hydrate falls back to the disk path (the old behaviour).
            try { await index.loadDays(profile, [dayKey]); }
            catch (err) { log.warn('media: scan cannot hydrate ' + key + ': ' + err.message); }
            for (const name of files) {
              const file = path.join(dir, name);
              let fst;
              try { fst = await fsp.stat(file, { bigint: true }); } catch { continue; }
              seen.add(file);
              const r = index.record(profile, file);
              const size = Number(fst.size);
              const mtimeNs = Number(fst.mtimeNs);
              // unchanged: not opened. `count` is the hour's metadata (the fragments themselves may not
              // be in memory at all — plan 2026-10-20).
              if (r.count && r.bytes === size && r.mtimeNs === mtimeNs) continue;
              if (size < r.end) r.end = 0;                                                // replaced: restart
              await (index.scanFileAsync ? index.scanFileAsync(r) : index.scanFile(r));
              opened += 1;
            }
            dayRows.push({ profile_id: profile, day: dayKey, dir_mtime_ns: dirMtime, hour_files: files.length });
            await yieldLoop();
          }
        }
      }
    }

    // Orphans: a row of a day folder that is gone, or of a file the pass did not see. Days whose folder
    // was SKIPPED are not compared — their file list was not read and nothing about them changed.
    // A RECORDING profile was skipped too, but its rows must NEVER be orphaned: the timer owns those
    // hours and the write-behind may not have stored them yet. Measured at boot (2026-10-20): without
    // this, every restart deleted the `media_hours` of every recording profile (48 rows in the probe)
    // — which wiped the very windows the boot pin loads, and made the timer re-index the day from disk.
    const rows = await media.listPaths();
    const gone = rows
      .filter((r) => {
        if (index.active.has(r.profile_id)) return false;
        const key = keyOf(r.profile_id, r.day);
        if (!visited.has(key)) return true;
        return read.has(key) && !seen.has(r.path);
      })
      .map((r) => r.path);
    const removed = gone.length ? await media.forget(gone) : 0;
    if (gone.length) index.forget(gone);
    if (dayRows.length) await media.upsertDays(dayRows);
    return { opened, removed, days: read.size };
  }

  return { run };
}

module.exports = { createMediaScanner };


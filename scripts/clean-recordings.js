'use strict';
// Cleanup of the recording directory (DESTRUCTIVE operation, run by hand by the operator).
//
//   node scripts/clean-recordings.js            # dry-run: inventory only
//   sudo node scripts/clean-recordings.js --apply   # actually deletes
//
// ponytail: it exists because the index (state.segments) is the ONLY source of automatic
// retention — a file that never entered the index (session killed on restart, manifest that only
// comes out at the end of the run) stays on disk with nobody to delete it. This script looks at
// the DISK, not at the index.
//
// Guards (skill db-filesystem-cleanup-safety): only deletes inside the allowed root, comparing
// RESOLVED paths; refuses symlinks and non-directories; refuses to run while ffmpeg writes to the
// share; dry-run does not touch the filesystem; there is no backup.
// The share is NFS with root-squash (file owner = nobody), so --apply runs as root: squashed root
// becomes nobody, which is the owner of the files written by the container — that is why deletion
// works. Measured: a file of ANOTHER owner (e.g. written by the host user) answers EPERM even under
// root; in that case only the owner can delete it.
//
// Exit: 0 ok | 1 refused before deleting | 2 deleted with failures.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = process.env.OPENVMS_ARCHIVE_DIR || '/mnt/archive/openvms';

function activeWriters() {
  let ps = '';
  try { ps = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }); } catch { return []; }
  return ps.split('\n').filter((l) => l.includes('ffmpeg') && l.includes(ROOT));
}

function inventory(dir) {
  let files = 0, bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { const s = inventory(p); files += s.files; bytes += s.bytes; }
    else if (e.isFile()) { files += 1; bytes += fs.statSync(p).size; }
  }
  return { files, bytes };
}

function main() {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  const audit = { root: ROOT, mode: apply ? 'apply' : 'dry-run', targets: [], refused: [], failures: [] };

  const resolvedRoot = path.resolve(ROOT);
  if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
    console.error(`allowed root does not exist or is not a directory: ${ROOT}`);
    return 1;
  }
  const active = activeWriters();
  if (active.length && !force) {
    console.error(`REFUSED: ${active.length} ffmpeg writing to the share — stop the recordings (or --force).`);
    console.error('  ' + active[0].slice(0, 160));
    return 1;
  }

  for (const name of fs.readdirSync(ROOT).sort()) {
    const target = path.join(ROOT, name);
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      audit.refused.push({ target, reason: 'not a regular directory' });
      continue;
    }
    const resolved = fs.realpathSync(target);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      audit.refused.push({ target, reason: 'outside the allowed root' });
      continue;
    }
    const inv = inventory(target);
    audit.targets.push({ target, ...inv });
    if (apply) {
      try { fs.rmSync(target, { recursive: true, force: true }); }
      catch (e) { audit.failures.push({ target, error: e.message }); }
    }
  }

  audit.totals = { targets: audit.targets.length, files: audit.targets.reduce((n, x) => n + x.files, 0),
    bytes: audit.targets.reduce((n, x) => n + x.bytes, 0) };
  if (apply) audit.after = inventory(ROOT);

  console.log(JSON.stringify(audit, null, 2));
  if (!apply) console.log(`dry-run: ${audit.totals.files} files, ${(audit.totals.bytes / 1e9).toFixed(2)} GB`);
  else console.log(`deleted: ${audit.totals.files} files, ${(audit.totals.bytes / 1e9).toFixed(2)} GB | remaining ${audit.after.files}`);
  return audit.failures.length ? 2 : 0;
}

process.exit(main());

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// config.yaml (spec 2026-10-20 §7). Defaults come from the spec; archive_dir has none on purpose:
// a VMS must not record into a directory nobody chose.
const DEFAULT_RETENTION_DAYS = 3;
const DEFAULT_DISK_MAX_PERCENT = 80;
const DEFAULT_EVENTS_RETENTION_DAYS = 30;
const DEBOUNCE_MS = 300;

function loadConfigFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    throw Object.assign(new Error(`config file not found: ${file}`), {
      code: 'config_archive_dir_required',
      field: 'recordings.archive_dir',
    });
  }
  const doc = yaml.load(raw) || {};
  const rec = doc.recordings || {};
  const ev = doc.events || {};
  return {
    recordings: {
      retention_days: rec.retention_days ?? DEFAULT_RETENTION_DAYS,
      disk_max_percent: rec.disk_max_percent ?? DEFAULT_DISK_MAX_PERCENT,
      archive_dir: rec.archive_dir,
    },
    events: { retention_days: ev.retention_days ?? DEFAULT_EVENTS_RETENTION_DAYS },
  };
}

function validate(cfg) {
  const rec = (cfg && cfg.recordings) || {};
  const ev = (cfg && cfg.events) || {};
  const dir = rec.archive_dir;
  if (typeof dir !== 'string' || dir.trim() === '' || !path.isAbsolute(dir)) {
    throw Object.assign(new Error('recordings.archive_dir must be a non-empty absolute path'), {
      code: 'config_archive_dir_required',
      field: 'recordings.archive_dir',
    });
  }
  const fields = [
    ['recordings.retention_days', rec.retention_days, (n) => n >= 1, 'an integer >= 1'],
    ['recordings.disk_max_percent', rec.disk_max_percent, (n) => n >= 1 && n <= 100, 'an integer between 1 and 100'],
    ['events.retention_days', ev.retention_days, (n) => n >= 1, 'an integer >= 1'],
  ];
  for (const [field, value, ok, expected] of fields) {
    if (!Number.isInteger(value) || !ok(value)) {
      throw Object.assign(new Error(`${field} must be ${expected} (got ${JSON.stringify(value)})`), {
        code: 'config_invalid',
        field,
      });
    }
  }
  return cfg;
}

function writeConfigFile(file, cfg) {
  validate(cfg);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, yaml.dump(cfg), 'utf8');
  fs.renameSync(tmp, file); // atomic: readers see the old file or the new one, never half of it
  return cfg;
}

// No restart logic here: the watcher hands the new cfg over and the caller compares archive_dir
// with the root it is already using (config_restart_required).
function watchConfigFile(file, handlers) {
  let timer = null;
  const check = () => {
    timer = null;
    if (!fs.existsSync(file)) return; // ENOENT keeps the last value; watchFile picks it up if it returns
    try {
      handlers.onValid(validate(loadConfigFile(file)));
    } catch (err) {
      handlers.onInvalid(err);
    }
  };
  const listener = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, DEBOUNCE_MS);
  };
  fs.watchFile(file, { interval: 1000 }, listener);
  return function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    fs.unwatchFile(file, listener);
  };
}

module.exports = { loadConfigFile, validate, writeConfigFile, watchConfigFile };

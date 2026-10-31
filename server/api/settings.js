'use strict';
const { AppError } = require('../lib/errors');

// Global config of the Settings modal (spec 2026-10-20 §7). config.yaml is the only source: the
// state document keeps no settings, and the recording root stays immutable through the API. main
// injects the live config (refreshed by the watcher), the atomic writer, the disk snapshot and the
// remediation hook; `store` is accepted only to keep the route-factory signature uniform.
function settingsRoutes(store, deps) {
  // config-file.js applies the defaults and validates on boot and on every reload, so what comes
  // back from deps.config() is already effective — no second defaulting pass.
  const effective = (rec) => ({
    archive_dir_effective: deps.archiveRoot(),
    retention_days: rec.retention_days,
    disk_max_percent: rec.disk_max_percent,
    disk: deps.disk(),
  });
  return {
    'GET /api/v1/settings': async () => effective(deps.config().recordings),
    'PATCH /api/v1/settings': async (body = {}) => {
      // `in` is deliberate: null, string, any value — the key in the body is already a refusal.
      if ('archive_dir' in body) throw new AppError('archive_dir_immutable');
      const patch = {};
      if (body.retention_days !== undefined) {
        if (!Number.isInteger(body.retention_days) || body.retention_days < 1) {
          throw new AppError('retention_days_invalid');
        }
        patch.retention_days = body.retention_days;
      }
      if (body.disk_max_percent !== undefined) {
        if (!Number.isInteger(body.disk_max_percent) || body.disk_max_percent < 1 || body.disk_max_percent > 100) {
          throw new AppError('disk_max_percent_invalid');
        }
        patch.disk_max_percent = body.disk_max_percent;
      }
      const cfg = deps.config();
      let rec = cfg.recordings;
      if (Object.keys(patch).length) {
        // The whole document goes back: events.retention_days must survive the rewrite (and
        // validate() refuses a document without it). writeConfig does tmp + rename, so a reader
        // never sees half a file.
        await deps.writeConfig({ ...cfg, recordings: { ...rec, ...patch } });
        rec = { ...rec, ...patch };
      }
      // Changing the percentage re-measures the disk right away — the 60 s timer is only a fallback.
      if (patch.disk_max_percent !== undefined) await deps.remediate();
      return effective(rec);
    },
  };
}
module.exports = { settingsRoutes };

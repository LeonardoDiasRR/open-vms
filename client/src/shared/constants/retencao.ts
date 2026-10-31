export const DEFAULT_RETENTION = 3;
export const MIN_RETENTION = 1;

// Recordings tab / PATCH /api/v1/settings rule (spec 2026-10-19): accepts ONLY a positive
// integer. 0 is not valid — turning recording off is the switch. Surrounding spaces are
// tolerated; anything else is an error with a message key (the caller translates it).
// Discriminated union on `ok`: in the success branch `value` is number (not number|null).
export type RetentionOk = { ok: true; value: number; errorKey: null };
export type RetentionError = { ok: false; value: null; errorKey: string };

export function parseRetention(input: unknown): RetentionOk | RetentionError {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, value: null, errorKey: 'admin.recordings.retention_invalid' };
  if (!/^\d+$/.test(raw)) return { ok: false, value: null, errorKey: 'admin.recordings.retention_not_integer' };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_RETENTION) {
    return { ok: false, value: null, errorKey: 'admin.recordings.retention_min' };
  }
  return { ok: true, value, errorKey: null };
}

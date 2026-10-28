import assert from 'node:assert';
import { describe, expect, it, test } from 'vitest';
import { DEFAULT_RETENTION, MIN_RETENTION, parseRetention } from './retencao';

describe('retention constants', () => {
  it('default is 3 days and minimum is 1 (0 is not a valid value)', () => {
    expect(DEFAULT_RETENTION).toBe(3);
    expect(MIN_RETENTION).toBe(1);
  });
});

describe('parseRetention (Recordings tab rule, since 2026-10-19)', () => {
  it('accepts a positive integer with surrounding spaces', () => {
    expect(parseRetention(' 7 ')).toEqual({ ok: true, value: 7, errorKey: null });
  });
  it('rejects empty, non-numeric and zero with a message key', () => {
    expect(parseRetention('')).toEqual({ ok: false, value: null, errorKey: 'admin.recordings.retention_invalid' });
    expect(parseRetention('abc')).toEqual({ ok: false, value: null, errorKey: 'admin.recordings.retention_not_integer' });
    expect(parseRetention('0')).toEqual({ ok: false, value: null, errorKey: 'admin.recordings.retention_min' });
  });
});

// Parity with the server validator (the route used to be PATCH /cameras/:id; since 2026-10-19 it is
// PATCH /api/v1/settings, same integer >= 1 rule — ported from timeline.paridade.test.ts, Phase 7).
const serverAccepts = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1;
const CASES: Array<[string, boolean]> = [
  ['1', true], ['3', true], ['30', true],
  ['0', false], ['-3', false], ['2.5', false], ['abc', false], ['', false], ['1.5', false], ['3d', false],
];
test('client and server agree on which retention inputs are valid', () => {
  for (const [input, clientAccepts] of CASES) {
    const r = parseRetention(input);
    assert.equal(r.ok, clientAccepts, `client disagrees with the table on ${JSON.stringify(input)}`);
    if (r.ok) assert.ok(serverAccepts(r.value), `server would reject the accepted value ${input}`);
  }
});

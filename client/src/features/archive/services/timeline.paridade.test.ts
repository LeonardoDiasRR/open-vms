// Timeline parity between the two runtimes (closes deviation F1): the client (ESM/TS) and the server
// (CJS/JS) keep the SAME copied logic, with no module shared between runtimes. This test pins the
// contract: same fixtures -> identical result on both sides.
import { test } from 'vitest';
import assert from 'node:assert';
import * as cli from './timeline';
import * as srv from '../../../../../server/lib/timeline.js';

const bucketCases: [{ start_ts: number; end_ts: number }[], number, number, number][] = [
  [[], 0, 180, 60],                                                                       // 1. empty window
  [[{ start_ts: 0, end_ts: 360 }], 0, 360, 60],                                           // 2. segment covers the whole window
  [[{ start_ts: 0, end_ts: 120 }, { start_ts: 300, end_ts: 360 }], 0, 360, 60],           // 3. gap > threshold
  [[{ start_ts: 0, end_ts: 120 }, { start_ts: 180, end_ts: 360 }], 0, 360, 60],           // 3. gap < threshold
  [[{ start_ts: 300, end_ts: 360 }, { start_ts: 0, end_ts: 120 }], 0, 360, 60],           // 4. unordered input
];

test('buckets: client and server give the same result', () => {
  assert.deepEqual(cli.buckets(bucketCases[0][0], 0, 180, 60).map(x => x.fraction), [0, 0, 0]); // empty fixture = all zero
  for (const [segs, from, to, step] of bucketCases) {
    assert.deepEqual(srv.buckets(segs, from, to, step), cli.buckets(segs, from, to, step));
  }
});

const firstGapCases: [{ start_ts: number; end_ts: number }[], number][] = [
  [[], 90],                                                                              // 1. empty window
  [[{ start_ts: 0, end_ts: 360 }], 90],                                                  // 2. continuous segment
  [[{ start_ts: 0, end_ts: 120 }, { start_ts: 300, end_ts: 360 }], 90],                  // 3. gap > threshold: found
  [[{ start_ts: 0, end_ts: 120 }, { start_ts: 180, end_ts: 360 }], 90],                  // 3. gap < threshold: not found
  [[{ start_ts: 300, end_ts: 360 }, { start_ts: 60, end_ts: 120 }, { start_ts: 0, end_ts: 60 }], 90], // 4. unordered (firstGap sorts internally)
];

test('firstGap: client and server agree (including sorting the input)', () => {
  assert.deepEqual(cli.firstGap(firstGapCases[2][0], 90), { from_ts: 120, to_ts: 300 }); // fixture 3 really finds one
  assert.equal(cli.firstGap(firstGapCases[3][0], 90), null);                             // fixture 3b finds none
  for (const [segs, th] of firstGapCases) {
    assert.deepEqual(srv.firstGap(segs, th), cli.firstGap(segs, th));
  }
});

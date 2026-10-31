// Port of test/timeline.test.mjs: the SAME cases and assertions — only the runner became vitest.
import { test } from 'vitest';
import assert from 'node:assert';
import { buckets, firstGap } from './timeline';
const segs = [{ start_ts: 0, end_ts: 60 }, { start_ts: 60, end_ts: 120 }, { start_ts: 300, end_ts: 360 }];
test('continuous buckets mark presence per minute', () => {
  const b = buckets(segs, 0, 360, 60);
  assert.deepEqual(b.map(x => [x.t, x.fraction]), [[0, 1], [60, 1], [120, 0], [180, 0], [240, 0], [300, 1]]);
});
test('partial fraction', () => assert.equal(buckets(segs, 0, 90, 60)[1].fraction, 0.5));
test('firstGap detects a hole > 90s', () => assert.deepEqual(firstGap(segs, 90), { from_ts: 120, to_ts: 300 }));
test('firstGap null when continuous', () => assert.equal(firstGap(segs.slice(0, 2), 90), null));

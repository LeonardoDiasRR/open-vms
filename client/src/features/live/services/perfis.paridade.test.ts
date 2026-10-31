import { test } from 'vitest';
import assert from 'node:assert';
import { primaryProfile, secondaryProfile } from '../../../../../server/lib/roles.js';
import * as cli from './perfis';

const P = (id: string, name: string, width: number | null, height: number | null) => ({ id, name, width, height, source_url: 'rtsp://cam/' + name });

test('parity with the client rule (client/src/features/live/services/perfis.ts)', () => {
  const cases = [
    [P('m', 'main', null, null), P('1', 'mainStream', 1920, 1080), P('2', 'subStream', 640, 480)],
    [P('a', 'a', 640, 480), P('b', 'b', 640, 480), P('c', 'c', 2048, 1536)],
    [P('s', 'solo', 704, 480)],
  ];
  for (const l of cases) {
    assert.equal(primaryProfile(l).id, (cli.primaryProfile(l) || {}).id);
    assert.equal(secondaryProfile(l).id, (cli.secondaryProfile(l) || {}).id);
  }
});

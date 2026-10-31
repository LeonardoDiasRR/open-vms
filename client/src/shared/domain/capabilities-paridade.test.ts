// Parity pin (createRequire pattern from shared/utils/api.test.ts): the Capability union in
// capabilities.ts is a TS-only construct with no runtime shape, so the literal array below is the
// second copy of the contract. If the server adds/renames a capability, this test fails and the
// union here must be updated to match.
import { test } from 'vitest';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CAPABILITIES } = require('../../../../server/lib/rbac.js');

const CLIENT_CAPABILITIES = [
  'camera.view',
  'camera.control',
  'camera.manage',
  'camera.manage.global',
  'settings.manage',
  'users.manage',
  'profiles.manage',
  'retention.manage',
];

test('client Capability union matches server CAPABILITIES (same order too)', () => {
  assert.deepEqual(CLIENT_CAPABILITIES, CAPABILITIES);
});

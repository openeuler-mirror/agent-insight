import assert from 'node:assert/strict';
import test from 'node:test';

import { buildServerConfigHash } from '../src/lib/engine/skill-generation/opencode-agent-cli/opencode-manager';

test('opencode manager uses one hash format for startup and reuse checks', () => {
  assert.equal(buildServerConfigHash('base-hash', 'user-key'), 'base-hash|upload:user-key');
  assert.equal(buildServerConfigHash('base-hash'), 'base-hash|upload:no-key');
});

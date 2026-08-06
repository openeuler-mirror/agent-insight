import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_PLATFORMS,
  normalizeAgentPlatform,
} from '@/lib/engine/observability/agent-platform';

test('Agent management recognizes Qoder as a supported platform', () => {
  assert.ok(AGENT_PLATFORMS.includes('qoder'));
  assert.equal(normalizeAgentPlatform('qoder'), 'qoder');
  assert.equal(normalizeAgentPlatform(' Qoder '), 'qoder');
});

test('Agent management preserves existing platforms and labels unregistered platforms as unknown', () => {
  assert.equal(normalizeAgentPlatform('opencode'), 'opencode');
  assert.equal(normalizeAgentPlatform('openclaw'), 'openclaw');
  assert.equal(normalizeAgentPlatform('hermes'), 'hermes');
  assert.equal(normalizeAgentPlatform('unknown'), 'unknown');
  assert.equal(normalizeAgentPlatform('future-agent'), 'unknown');
  assert.equal(normalizeAgentPlatform(null), 'unknown');
});

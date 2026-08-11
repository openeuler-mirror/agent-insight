import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

test('Agent management recognizes Qwen Code as a supported platform', () => {
  assert.ok(AGENT_PLATFORMS.includes('qwencode'));
  assert.equal(normalizeAgentPlatform('qwencode'), 'qwencode');
  assert.equal(normalizeAgentPlatform(' QWENCODE '), 'qwencode');
});

test('Agent management preserves existing platforms and labels unregistered platforms as unknown', () => {
  assert.equal(normalizeAgentPlatform('opencode'), 'opencode');
  assert.equal(normalizeAgentPlatform('openclaw'), 'openclaw');
  assert.equal(normalizeAgentPlatform('hermes'), 'hermes');
  assert.equal(normalizeAgentPlatform('unknown'), 'unknown');
  assert.equal(normalizeAgentPlatform('future-agent'), 'unknown');
  assert.equal(normalizeAgentPlatform(null), 'unknown');
});

test('Agent management only renders API-backed agents and uses the current time', () => {
  const page = fs.readFileSync(
    path.join(process.cwd(), 'src', 'app', '(main)', 'agents', 'page.tsx'),
    'utf8',
  );

  assert.doesNotMatch(page, /mockAgents|MOCK_NOW/);
  assert.doesNotMatch(
    page,
    /customer-service-agent|data-analyzer-v2|order-executor|email-dispatcher|security-guard/,
  );
  assert.match(page, /const agents = dbAgents;/);
  assert.match(page, /const \[now\] = useState\(\(\) => new Date\(\)\)/);
  assert.match(page, /now\.getTime\(\) - lastExecutedMs/);
  assert.match(page, /<AgentCard agent=\{agent\} now=\{now\}/);
});

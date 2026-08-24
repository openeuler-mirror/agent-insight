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
  assert.equal(normalizeAgentPlatform('codex'), 'codex');
  assert.equal(normalizeAgentPlatform('unknown'), 'unknown');
  assert.equal(normalizeAgentPlatform('future-agent'), 'unknown');
  assert.equal(normalizeAgentPlatform(null), 'unknown');
});

test('Agent management exposes Codex platform filters via the shared platform source', () => {
  const page = fs.readFileSync(
    path.join(process.cwd(), 'src', 'app', '(main)', 'agents', 'page.tsx'),
    'utf8',
  );

  // 页面收敛到共享真源：PlatformFilter 从 AgentPlatform 派生，筛选选项由
  // AGENT_PLATFORMS.map 生成，归一化用共享 normalizeAgentPlatform（unknown
  // 保持 unknown，不再冒充 opencode）。
  assert.match(page, /type PlatformFilter = 'all' \| AgentPlatform;/);
  assert.match(page, /platform: normalizeAgentPlatform\(a\.platform\),/);
  assert.match(page, /\.{3}AGENT_PLATFORMS\.map\(\(value\) => \(\{ value, label: value \}\)\)/);
  assert.doesNotMatch(page, /function normalizePlatform/);
});

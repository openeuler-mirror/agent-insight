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
  assert.ok(AGENT_PLATFORMS.includes('pi-agent'));
  assert.equal(normalizeAgentPlatform('pi-agent'), 'pi-agent');
  assert.equal(normalizeAgentPlatform(' Pi-Agent '), 'pi-agent');
  assert.equal(normalizeAgentPlatform('unknown'), 'unknown');
  assert.equal(normalizeAgentPlatform('future-agent'), 'unknown');
  assert.equal(normalizeAgentPlatform(null), 'unknown');
});

test('Agent management recognizes WorkBuddy as a supported platform', () => {
  assert.ok(AGENT_PLATFORMS.includes('workbuddy'));
  assert.equal(normalizeAgentPlatform('workbuddy'), 'workbuddy');
  assert.equal(normalizeAgentPlatform(' WorkBuddy '), 'workbuddy');
});

test('Agent management derives page platform filters from the canonical list', () => {
  const page = fs.readFileSync(
    path.join(process.cwd(), 'src', 'app', '(main)', 'agents', 'page.tsx'),
    'utf8',
  );

  // 单一事实源：页面筛选器由 AGENT_PLATFORMS 派生，平台归一化统一走 normalizeAgentPlatform，
  // 不再为每个框架手写 PlatformFilter 联合类型 / normalizePlatform 分支 / 硬编码下拉项。
  assert.match(page, /type PlatformFilter = 'all' \| AgentPlatform;/);
  assert.match(page, /normalizeAgentPlatform\(a\.platform\)/);
  assert.match(page, /AGENT_PLATFORMS\.map/);
  for (const platform of ['codex', 'pi-agent', 'workbuddy'] as const) {
    assert.ok(AGENT_PLATFORMS.includes(platform), `${platform} must be a canonical page platform`);
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AGENT_DEBUG_FAULT_MODES } from '@/lib/engine/agent-debug/capabilities';

const root = process.cwd();

test('agent-debug capability catalog exposes nine unified user-facing fault patterns', () => {
  assert.equal(AGENT_DEBUG_FAULT_MODES.length, 9);
  assert.equal(new Set(AGENT_DEBUG_FAULT_MODES.map(mode => mode.key)).size, 9);
  assert.equal(new Set(AGENT_DEBUG_FAULT_MODES.map(mode => mode.zh.title)).size, 9);

  for (const mode of AGENT_DEBUG_FAULT_MODES) {
    assert.ok(mode.zh.title.length > 0);
    assert.ok(mode.zh.description.length > 0);
    assert.ok(mode.en.title.length > 0);
    assert.ok(mode.en.description.length > 0);
  }
});

test('fault diagnosis header exposes a persistent capability sheet entry', () => {
  const page = fs.readFileSync(path.join(root, 'src/app/(main)/fault/page.tsx'), 'utf8');
  const sheet = fs.readFileSync(path.join(root, 'src/components/observe/AgentDebugCapabilitySheet.tsx'), 'utf8');

  assert.match(page, /<AgentDebugCapabilitySheet locale=\{locale\} \/>/);
  assert.match(sheet, /可识别的故障模式/);
  assert.match(sheet, /AGENT_DEBUG_FAULT_MODES\.map/);
  assert.equal((sheet.match(/mode\.key/g) || []).length, 1);
  assert.doesNotMatch(sheet, /专项诊断|诊断器|五模块诊断/);
});

test('diagnosis guide documents the same unified fault pattern catalog', () => {
  const guide = fs.readFileSync(path.join(root, 'docs/user-guide/observability/diagnosis.md'), 'utf8');

  for (const mode of AGENT_DEBUG_FAULT_MODES) {
    assert.match(guide, new RegExp(mode.zh.title));
  }
  assert.match(guide, /所有诊断结果都以统一的关键发现卡片展示/);
  assert.doesNotMatch(guide, /constant_ignorance/);
  assert.doesNotMatch(guide, /tool_misuse/);
});

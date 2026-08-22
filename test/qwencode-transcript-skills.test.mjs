import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTranscriptSkillCalls } from '../scripts/qwencode-collector/transcript-skills.mjs';

function jsonl(entries) {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

test('QwenCode collector detects a bundled slash Skill expansion', () => {
  const calls = parseTranscriptSkillCalls(jsonl([
    { uuid: 'slash-1', type: 'system', subtype: 'slash_command', timestamp: '2026-01-01T00:00:00Z', systemPayload: { phase: 'invocation', rawCommand: '/dataviz' } },
    { uuid: 'user-1', type: 'user', timestamp: '2026-01-01T00:00:00.100Z', message: { parts: [{ text: 'Base directory for this skill: C:\\qwen-code\\bundled\\dataviz\n\n# Dataviz' }] } },
    { type: 'system', timestamp: '2026-01-01T00:00:02Z', systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_response', 'event.timestamp': '2026-01-01T00:00:02Z', response_text: 'Dataviz skill loaded.' } } },
  ]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].skillName, 'dataviz');
  assert.equal(calls[0].source, 'built-in');
  assert.equal(calls[0].triggerMode, 'slash_command');
  assert.equal(calls[0].result, 'Dataviz skill loaded.');
});

test('QwenCode collector detects custom project and prompt-expanded Skills', () => {
  const calls = parseTranscriptSkillCalls(jsonl([
    { uuid: 'custom-user', type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { parts: [{ text: 'Base directory for this skill: D:\\repo\\.qwen\\skills\\project-info\n\nRead package.json' }] } },
  ]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].skillName, 'project-info');
  assert.equal(calls[0].source, 'custom');
  assert.equal(calls[0].triggerMode, 'prompt_expansion');
});

test('QwenCode collector ignores ordinary slash commands', () => {
  const calls = parseTranscriptSkillCalls(jsonl([
    { uuid: 'slash-model', type: 'system', subtype: 'slash_command', systemPayload: { phase: 'invocation', rawCommand: '/model qwen3.6-plus' } },
  ]));
  assert.equal(calls.length, 0);
});

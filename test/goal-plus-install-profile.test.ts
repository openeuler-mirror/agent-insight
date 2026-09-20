import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseFrameworks,
  resolveInstallProfile,
} from '@/lib/ingest/setup/install-profile';

function plan(frameworks: string) {
  return resolveInstallProfile(parseFrameworks(frameworks));
}

test('direct Pi and Codex selections do not gain Goal Plus dependencies', () => {
  assert.deepEqual(plan('pi-agent').effectiveFrameworks.map(item => item.value), ['pi-agent']);
  assert.deepEqual(plan('codex').effectiveFrameworks.map(item => item.value), ['codex']);
  assert.deepEqual(plan('pi-agent,codex').effectiveFrameworks.map(item => item.value), ['pi-agent', 'codex']);
});

test('Goal Plus selection always adds the Pi collector', () => {
  const profile = plan('goal-plus');
  assert.deepEqual(profile.effectiveFrameworks.map(item => item.value), ['goal-plus', 'pi-agent']);
  assert.deepEqual(profile.goalPlusHosts, ['pi']);
  assert.deepEqual(profile.autoAddedFrameworks.map(item => item.value), ['pi-agent']);
});

test('Goal Plus adds Pi only once and does not alter an explicit Codex selection', () => {
  const deduplicated = plan('pi-agent,goal-plus,codex');
  assert.deepEqual(deduplicated.effectiveFrameworks.map(item => item.value), ['pi-agent', 'goal-plus', 'codex']);
  assert.deepEqual(deduplicated.autoAddedFrameworks, []);
});

test('Unknown frameworks are rejected without changing direct Codex selection', () => {
  const profile = plan('codex,unknown');
  assert.deepEqual(profile.effectiveFrameworks.map(item => item.value), ['codex']);
  assert.deepEqual(profile.goalPlusHosts, []);
});

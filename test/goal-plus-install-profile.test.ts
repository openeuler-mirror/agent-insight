import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FRAMEWORK_OPTIONS,
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

test('legacy Goal Plus selection maps to the Pi collector without a separate install target', () => {
  const profile = plan('goal-plus');
  assert.deepEqual(profile.effectiveFrameworks.map(item => item.value), ['pi-agent']);
  assert.deepEqual(profile.goalPlusHosts, []);
  assert.deepEqual(profile.autoAddedFrameworks.map(item => item.value), ['pi-agent']);
});

test('legacy Goal Plus input adds Pi only once and does not alter an explicit Codex selection', () => {
  const deduplicated = plan('pi-agent,goal-plus,codex');
  assert.deepEqual(deduplicated.effectiveFrameworks.map(item => item.value), ['pi-agent', 'codex']);
  assert.deepEqual(deduplicated.autoAddedFrameworks, []);
});

test('Goal Plus is not presented as a user-selectable framework', () => {
  assert.equal(FRAMEWORK_OPTIONS.some(item => item.value === 'goal-plus'), false);
});

test('Unknown frameworks are rejected without changing direct Codex selection', () => {
  const profile = plan('codex,unknown');
  assert.deepEqual(profile.effectiveFrameworks.map(item => item.value), ['codex']);
  assert.deepEqual(profile.goalPlusHosts, []);
});

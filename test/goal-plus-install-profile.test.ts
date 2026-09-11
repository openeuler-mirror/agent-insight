import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseFrameworks,
  parseGoalPlusHosts,
  resolveInstallProfile,
} from '@/lib/ingest/setup/install-profile';

function plan(frameworks: string, hosts = '') {
  return resolveInstallProfile(parseFrameworks(frameworks), parseGoalPlusHosts(hosts));
}

test('direct Pi and Codex selections do not gain Goal Plus dependencies', () => {
  assert.deepEqual(plan('pi-agent').effectiveFrameworks.map(item => item.value), ['pi-agent']);
  assert.deepEqual(plan('codex').effectiveFrameworks.map(item => item.value), ['codex']);
  assert.deepEqual(plan('pi-agent,codex').effectiveFrameworks.map(item => item.value), ['pi-agent', 'codex']);
});

test('legacy Goal Plus selection remains semantic-only when no host is declared', () => {
  const profile = plan('goal-plus');
  assert.deepEqual(profile.effectiveFrameworks.map(item => item.value), ['goal-plus']);
  assert.deepEqual(profile.goalPlusHosts, []);
  assert.deepEqual(profile.autoAddedFrameworks, []);
});

test('Goal Plus host profiles add native collectors once', () => {
  assert.deepEqual(plan('goal-plus', 'pi').effectiveFrameworks.map(item => item.value), ['goal-plus', 'pi-agent']);
  assert.deepEqual(plan('goal-plus', 'codex').effectiveFrameworks.map(item => item.value), ['goal-plus', 'codex']);
  assert.deepEqual(plan('goal-plus', 'pi,codex').effectiveFrameworks.map(item => item.value), [
    'goal-plus',
    'pi-agent',
    'codex',
  ]);
  const deduplicated = plan('pi-agent,goal-plus,codex', 'pi,codex');
  assert.deepEqual(deduplicated.effectiveFrameworks.map(item => item.value), ['pi-agent', 'goal-plus', 'codex']);
  assert.deepEqual(deduplicated.autoAddedFrameworks, []);
});

test('Goal Plus hosts are ignored without Goal Plus and unknown values are rejected', () => {
  const profile = plan('codex,unknown', 'pi,unknown,codex');
  assert.deepEqual(profile.effectiveFrameworks.map(item => item.value), ['codex']);
  assert.deepEqual(profile.goalPlusHosts, []);
});

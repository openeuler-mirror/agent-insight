import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredStagesFor } from './core.mjs';
import { assessStability } from '../stability.mjs';

function report(id) {
  const actual = { login: { username: id }, application: { database: '/tmp/' + id }, model: { model: 'deepseek-flash' }, 'ordinary-client': { version: '2.1.4' }, cleanup: { remaining: [] } };
  for (const stage of ['baseline', 'candidate', 'published-run']) actual[stage] = { score: 90, taskId: id + stage };
  return { runId: id, mode: 'real', selectedCase: '003', testedSha: 'sha', startedAt: '2026-11-03T00:00:00Z', endedAt: '2026-11-03T00:01:00Z', testBundleHashes: { code: 'same' }, fixtureHashes: { log: 'same' }, productSourceHashes: { component: 'same' }, scenarios: [{ id: 'CORE-E2E-003', status: 'PASS', stages: requiredStagesFor('003').map(stage => ({ id: stage, status: 'PASS', actual: actual[stage] || {} })) }] };
}

test('stability requires two complete independent runs and identical test code', () => {
  assert.equal(assessStability([report('one'), report('two')]).distinctBusinessTraces, 6);
  assert.throws(() => assessStability([report('one')]));
  const second = report('two');second.testBundleHashes.code = 'changed';assert.throws(() => assessStability([report('one'), second]));
});

test('reusing accounts or skipping a required stage cannot establish stability', () => {
  const second = report('two');second.scenarios[0].stages.find(s => s.id === 'login').actual.username = 'one';assert.throws(() => assessStability([report('one'), second]));
  const skipped = report('two');skipped.scenarios[0].stages.find(s => s.id === 'candidate').status = 'NOT_RUN';assert.throws(() => assessStability([report('one'), skipped]));
});

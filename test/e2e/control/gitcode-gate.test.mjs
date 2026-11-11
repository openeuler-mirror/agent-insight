import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cases } from '../shared/catalog.mjs';
import { requiredStagesFor } from '../shared/core.mjs';
import { assertGitCodeGate } from './gitcode-gate.mjs';
import { loadExecutionConfig, configSnapshot, caseMode, suiteMode } from '../shared/config.mjs';

const identity = { runId: 'ci-fixture', testedSha: 'a'.repeat(40) };
function passingReport() {
  return {
    ...identity, mode: 'mock', status: 'PASS', endedAt: new Date().toISOString(),
    selected: cases.map(item => item.id), historyPreserved: true,
    productionBuild: { status: 'PASS', exitCode: 0, buildId: 'fixture-build' },
    npmTest: {
      status: 'PASS', fullSuiteComplete: true, interrupted: false,
      observedSummary: { tests: 3, pass: 2, fail: 0, skipped: 1, cancelled: 0, todo: 0 },
    },
    scenarios: cases.map(item => ({ ...item, mode: 'mock', status: 'PASS',
      stages: requiredStagesFor(item.id).map(id => ({ id, status: 'PASS' })),
    })),
  };
}

test('GitCode gate accepts a complete build, UT and all five Mock cases', () => {
  assert.equal(assertGitCodeGate(passingReport(), identity).status, 'PASS');
});

test('GitCode gate accepts configured mixed and Real modes only with matching expected configuration', () => {
  for (const mode of ['mixed', 'real']) {
    const caseModes = Object.fromEntries(cases.map(({ id }) => [id, mode === 'real' || id === '001' ? 'real' : 'mock']));
    const config = loadExecutionConfig({ env: {}, overrides: { mode: 'mock', caseModes } });
    const expectedConfiguration = configSnapshot(config);
    const report = passingReport();report.mode = suiteMode(config);report.configuration = expectedConfiguration;
    for (const row of report.scenarios) row.mode = caseMode(config, row.id);
    assert.throws(() => assertGitCodeGate(report, identity));
    assert.equal(assertGitCodeGate(report, { ...identity, expectedConfiguration }).status, 'PASS');
    report.scenarios[0].mode = 'mock';
    assert.throws(() => assertGitCodeGate(report, { ...identity, expectedConfiguration }));
  }
});

test('GitCode gate rejects self-reported config changes or a configured reduction of UT and case scope', () => {
  const config = loadExecutionConfig({ env: {}, overrides: { mode: 'mock' } });
  const expectedConfiguration = configSnapshot(config);
  const report = passingReport();report.configuration = structuredClone(expectedConfiguration);
  assert.doesNotThrow(() => assertGitCodeGate(report, { ...identity, expectedConfiguration }));
  report.configuration.settings.model.modelName = 'changed-model';
  assert.throws(() => assertGitCodeGate(report, { ...identity, expectedConfiguration }));
  report.configuration = structuredClone(expectedConfiguration);report.configuration.hash = 'incorrect';
  assert.throws(() => assertGitCodeGate(report, { ...identity, expectedConfiguration }));
  for (const change of [{ runUt: false }, { cases: ['001'] }]) {
    const reduced = configSnapshot({ ...config, ...change });
    assert.throws(() => assertGitCodeGate(passingReport(), { ...identity, expectedConfiguration: reduced }));
  }
});

for (const status of ['FAIL', 'BLOCKED', 'PARTIAL', 'NOT_RUN', 'RUNNING']) {
  test(`GitCode gate rejects ${status} even if every individual result says PASS`, () => {
    assert.throws(() => assertGitCodeGate({ ...passingReport(), status }, identity));
  });
}

test('GitCode gate rejects missing, failed or unbuilt production compilation', () => {
  for (const productionBuild of [undefined, { status: 'FAIL' }, { status: 'PASS', exitCode: 0 },
    { status: 'PASS', exitCode: 1, buildId: 'fixture' }]) {
    assert.throws(() => assertGitCodeGate({ ...passingReport(), productionBuild }, identity));
  }
});

test('GitCode gate rejects stale identity, interruption and dirty source', () => {
  for (const change of [{ testedSha: 'b'.repeat(40) }, { runId: 'old-run' }, { endedAt: undefined },
    { interrupted: true }, { dirtyWorkingTree: true }, { historyPreserved: false }]) {
    assert.throws(() => assertGitCodeGate({ ...passingReport(), ...change }, identity));
  }
});

test('GitCode gate accepts a fresh Job report without a state export', () => {
  const report = passingReport();
  delete report.historyPreserved;
  assert.throws(() => assertGitCodeGate(report, identity), /state export/);
  assert.equal(assertGitCodeGate(report, { ...identity, freshJob: true }).status, 'PASS');
  report.historyPreserved = false;
  assert.throws(() => assertGitCodeGate(report, { ...identity, freshJob: true }), /state export/);
});

test('GitCode gate requires complete, nonempty UT with no failures or cancellations', () => {
  for (const change of [{ status: 'FAIL' }, { fullSuiteComplete: false }, { interrupted: true },
    { observedSummary: { tests: 3, pass: 1, fail: 1, skipped: 1, cancelled: 0 } },
    { observedSummary: { tests: 3, pass: 1, fail: 0, skipped: 1, cancelled: 1 } },
    { observedSummary: { tests: 3, pass: 0, fail: 0, skipped: 3, cancelled: 0 } }]) {
    const report = passingReport(); Object.assign(report.npmTest, change);
    assert.throws(() => assertGitCodeGate(report, identity));
  }
});

test('GitCode gate rejects reduced scope, missing cases, skipped stages and Real mode', () => {
  const reduced = passingReport(); reduced.selected.pop(); reduced.scenarios.at(-1).status = 'NOT_RUN';
  const missing = passingReport(); missing.scenarios.pop();
  const duplicate = passingReport(); duplicate.scenarios[4] = structuredClone(duplicate.scenarios[0]);
  const skipped = passingReport(); skipped.scenarios[2].stages[0].status = 'NOT_RUN';
  const real = passingReport(); real.scenarios[0].mode = 'real';
  for (const report of [reduced, missing, duplicate, skipped, real, { ...passingReport(), mode: 'real' }]) {
    assert.throws(() => assertGitCodeGate(report, identity));
  }
});

test('GitCode gate CLI fails for missing reports and writes a valid report to the Job summary', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcode-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reportFile = path.join(directory, 'report.json'), summary = path.join(directory, 'summary.md');
  const args = [new URL('./gitcode-gate.mjs', import.meta.url).pathname, '--report', reportFile,
    '--run-id', identity.runId, '--tested-sha', identity.testedSha];
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ATOMGIT_STEP_SUMMARY: summary } });
  assert.notEqual(run().status, 0);
  fs.writeFileSync(reportFile, JSON.stringify(passingReport()));
  assert.equal(run().status, 0);
  assert.match(fs.readFileSync(summary, 'utf8'), /fixture-build/);
  const failed = passingReport(); failed.npmTest.fullSuiteComplete = false;
  fs.writeFileSync(reportFile, JSON.stringify(failed));
  assert.notEqual(run().status, 0);
});

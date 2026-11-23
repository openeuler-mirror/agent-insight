import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cases } from '../shared/catalog.mjs';
import { renderSummary } from '../shared/suite.mjs';
import { validateReport } from './worker-core.mjs';
import { configSnapshot, caseMode, suiteMode } from '../shared/config.mjs';

export function assertGitCodeGate(report, { runId, testedSha, freshJob = false, expectedConfiguration }) {
  assert.match(runId, /^[a-z0-9-]{1,80}$/);
  assert.match(testedSha, /^[a-f0-9]{40}$/);
  assert.equal(report.status, 'PASS', 'Compilation, UT and all E2E cases must pass');
  assert.notEqual(report.interrupted, true, 'Interrupted runs cannot pass');
  assert.notEqual(report.dirtyWorkingTree, true, 'The tested source must match its commit');
  if (!freshJob || report.historyPreserved !== undefined) {
    assert.equal(report.historyPreserved, true, 'Test state export must complete');
  }
  assert.equal(report.productionBuild?.status, 'PASS', 'Production compilation must pass');
  assert.equal(report.productionBuild.exitCode, 0, 'Production compilation must exit successfully');
  assert.ok(typeof report.productionBuild.buildId === 'string' && report.productionBuild.buildId.trim(), 'BUILD_ID is required');
  const job = { runId, mode: 'mock', caseIds: cases.map(item => item.id), runUt: true };
  if (expectedConfiguration) {
    assert.deepEqual(configSnapshot(expectedConfiguration.settings), expectedConfiguration, 'Expected configuration must have a valid hash');
    assert.deepEqual(expectedConfiguration.settings.cases, job.caseIds, 'All five E2E cases remain required');
    assert.equal(expectedConfiguration.settings.runUt, true, 'Complete UT remains required');
    assert.deepEqual(report.configuration, expectedConfiguration, 'Report must match the configuration resolved before execution');
    job.mode = suiteMode(expectedConfiguration.settings);job.configHash = expectedConfiguration.hash;
  }
  validateReport(report, {
    job,
    testedSha, exitCode: 0,
  });
  assert.ok(report.scenarios.every(item => item.mode === (expectedConfiguration ? caseMode(expectedConfiguration.settings, item.id) : 'mock')), 'Every E2E case must match its expected mode');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      report: { type: 'string' }, 'run-id': { type: 'string' }, 'tested-sha': { type: 'string' }, 'fresh-job': { type: 'boolean' }, 'expected-config': { type: 'string' },
    } });
    const report = JSON.parse(fs.readFileSync(values.report, 'utf8'));
    const summary = renderSummary(report).markdown;
    if (process.env.ATOMGIT_STEP_SUMMARY) fs.appendFileSync(process.env.ATOMGIT_STEP_SUMMARY, summary + '\n');
    const expectedConfiguration = values['expected-config'] ? JSON.parse(fs.readFileSync(values['expected-config'], 'utf8')) : undefined;
    assertGitCodeGate(report, { runId: values['run-id'], testedSha: values['tested-sha'], freshJob: values['fresh-job'], expectedConfiguration });
    console.log('PASS: production compilation, complete UT and all five E2E cases match their expected modes');
  } catch (error) {
    console.error('GitCode E2E gate failed:', error.message);
    process.exitCode = 1;
  }
}

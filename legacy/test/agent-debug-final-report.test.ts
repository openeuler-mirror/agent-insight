import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFinalDiagnosisReport, readFinalDiagnosisReport } from '../src/lib/engine/agent-debug/final-report';
import { parseJsonObject } from '../src/lib/engine/agent-debug/json';

function report() {
  return {
    triage: { category: 'normal', shortCircuited: false, fatalDiagnosis: null },
    stepRecords: [{
      step: 1, environmentResponse: 'Skill documentation: ```text\nfolder/…<truncated>',
      toolCalls: [
        { id: 'tool-1', name: 'bash', args: { command: 'ls' }, output: 'ok' },
        { id: 'tool-2', name: 'skill', output: '```text\nfolder/\n```' },
      ],
      modules: Object.fromEntries(['memory', 'reflection', 'planning', 'action', 'system'].map(name => [name, { content: '' }])),
    }],
    phase1Grid: [{ step: 1, module: 'reflection', errorDetected: true }],
    issues: [{ id: 'issue-1', module: 'reflection', evidence: 'Evidence contradicts conclusion.' }],
    findings: [{ id: 'finding-1', summary: 'Check evidence', evidence: 'Nested JSON: ```json\n{"literal":"},] and {"}\n```', correctionGuidance: 'Verify before concluding.', issueRefs: [{ issueId: 'issue-1', role: 'root' }] }],
    rootCause: null,
  };
}

test('final report reads the outer JSON despite truncated fences and nested tool objects', () => {
  const original = report();
  const raw = JSON.stringify(original, null, 2);
  assert.equal(parseJsonObject(raw)?.name, 'bash');
  assert.deepEqual(parseFinalDiagnosisReport(raw), original);
  const directory = mkdtempSync(path.join(tmpdir(), 'diagnosis-report-'));
  const file = path.join(directory, 'final.json');
  writeFileSync(file, raw);
  assert.deepEqual(readFinalDiagnosisReport(file), original);
  writeFileSync(file, '{"broken":');
  assert.throws(() => readFinalDiagnosisReport(file), /解析失败/);
  assert.throws(() => readFinalDiagnosisReport(path.join(directory, 'missing.json')), /读取失败/);
});

test('complete reports may explicitly contain zero findings', () => {
  const value = { triage: report().triage, stepRecords: [], phase1Grid: [], issues: [], findings: [], rootCause: null };
  assert.deepEqual(parseFinalDiagnosisReport(JSON.stringify(value)), value);
});

test('other-module issues retain evidence and finding references', () => {
  const value = report();
  value.phase1Grid[0].module = 'others';
  value.issues[0].module = 'others';
  assert.deepEqual(parseFinalDiagnosisReport(JSON.stringify(value)), value);

  const nonBlocking = {
    ...value,
    phase1Grid: value.phase1Grid.map(cell => ({ ...cell, resolution: 'non_blocking' })),
    issues: value.issues.map(issue => ({ ...issue, resolution: 'non_blocking', resolutionEvidence: 'Advice is within the Skill scope.' })),
    findings: [],
  };
  assert.deepEqual(parseFinalDiagnosisReport(JSON.stringify(nonBlocking)), nonBlocking);
});

test('report module names reject unsupported values in grids and issues', () => {
  for (const field of ['phase1Grid', 'issues'] as const) {
    for (const moduleValue of ['unknown', 'overall', 'skills', 'other', '']) {
      const value = report();
      value[field][0].module = moduleValue;
      assert.throws(() => parseFinalDiagnosisReport(JSON.stringify(value)), new RegExp(`${field}\\.0\\.module`));
    }
  }
});

test('invalid JSON and report-shaped data cannot become successful empty reports', () => {
  for (const value of ['{"findings":', '```json\n{}\n```', '{"findings":[],}']) {
    assert.throws(() => parseFinalDiagnosisReport(value), /解析失败/);
  }
  for (const value of [null, [], {}, { name: 'bash', args: {} }, { ...report(), findings: null }, { ...report(), triage: {} }, { ...report(), issues: [null] }, { ...report(), stepRecords: [{}] }]) {
    assert.throws(() => parseFinalDiagnosisReport(JSON.stringify(value)), /校验失败/);
  }
  for (const field of ['triage', 'stepRecords', 'phase1Grid', 'issues', 'findings', 'rootCause']) {
    const value: Record<string, unknown> = report();
    delete value[field];
    assert.throws(() => parseFinalDiagnosisReport(JSON.stringify(value)), /校验失败/);
  }
});

test('findings cannot lose invalid references or duplicate roots during normalization', () => {
  const original = report();
  const finding = original.findings[0];
  for (const issueRefs of [[], [{ issueId: 'missing', role: 'root' }], [{ issueId: 'issue-1', role: 'unknown' }], [{ issueId: 'issue-1', role: 'contributing' }]]) {
    assert.throws(() => parseFinalDiagnosisReport(JSON.stringify({ ...original, findings: [{ ...finding, issueRefs }] })), /校验失败/);
  }
  assert.throws(() => parseFinalDiagnosisReport(JSON.stringify({ ...original, findings: [finding, { ...finding, id: 'finding-2' }] })), /root issue already/);
  assert.throws(() => parseFinalDiagnosisReport(JSON.stringify({ ...original, issues: [original.issues[0], original.issues[0]] })), /duplicate id/);
  assert.throws(() => parseFinalDiagnosisReport(JSON.stringify({ ...original, detectorFindings: [{ id: 'detector-1', summary: 'Extra finding', relatedFindingId: 'missing' }] })), /referenced finding/);
  assert.throws(() => parseFinalDiagnosisReport(JSON.stringify({ ...original, issues: [{ ...original.issues[0], module: 'unknown' }] })), /校验失败/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as evidence from './skill-evidence.mjs';
import * as archive from './skill-archive.mjs';
import { scenarioResult } from './core.mjs';

test('003 cannot pass with upload/generation alone or without a published-version run', () => {
  const stages = ['application', 'login', 'model', 'ordinary-client', 'upload', 'generation', 'static', 'baseline-publish', 'baseline', 'optimization', 'candidate', 'publish', 'published-run', 'cleanup'];
  assert.equal(scenarioResult(stages.map(id => ({ id, status: 'PASS' })), '003').status, 'PASS');
  assert.equal(scenarioResult(stages.filter(id => id !== 'published-run').map(id => ({ id, status: 'PASS' })), '003').status, 'PARTIAL');
});

test('archived candidate proof rejects a changed candidate, another dataset or missing coverage', () => {
  assert.equal(typeof archive.assertCandidateProof, 'function');
  const files = { 'SKILL.md': 'candidate' };
  const record = { id: 'record', sourceExperimentId: 'baseline', candidateFiles: files };
  const dataset = { id: 'dataset', cases: [{ id: 'case', input: 'task' }] };
  const snapshot = { verificationOnly: true, verification: { version: 1, candidateHash: archive.stableHash(files), datasetId: dataset.id, caseIds: ['case'], inputHash: archive.stableHash(dataset.cases), result: { ok: true, fullCoverage: true, measured: 1 } } };
  const experiment = { user: 'test', optimizationRecordId: record.id, sourceExperimentId: 'baseline', configSnapshotJson: JSON.stringify(snapshot) };
  assert.doesNotThrow(() => archive.assertCandidateProof(experiment, 'test', record, dataset));
  assert.throws(() => archive.assertCandidateProof(experiment, 'other', record, dataset));
  assert.throws(() => archive.assertCandidateProof(experiment, 'test', { ...record, candidateFiles: { 'SKILL.md': 'old' } }, dataset));
  assert.throws(() => archive.assertCandidateProof(experiment, 'test', record, { ...dataset, id: 'another' }));
  snapshot.verification.result.ok = false;
  assert.doesNotThrow(() => archive.assertCandidateProof({ ...experiment, configSnapshotJson: JSON.stringify(snapshot) }, 'test', record, dataset));
  snapshot.verification.result.fullCoverage = false;
  assert.throws(() => archive.assertCandidateProof({ ...experiment, configSnapshotJson: JSON.stringify(snapshot) }, 'test', record, dataset));
});

test('candidate output requires an exact calculated JSON object and retained evidence', () => {
  assert.equal(typeof evidence.assertSkillAnswer, 'function');
  const answer = 'root 认证失败 351 次；最多来源 150.183.249.110 为 80 次。证据：authentication failure; user=root rhost=150.183.249.110\nE2E-SUMMARY {"top_source_failures":80,"top_source":"150.183.249.110","root_ssh_failures":351}';
  assert.doesNotThrow(() => evidence.assertSkillAnswer(answer, true));
  assert.throws(() => evidence.assertSkillAnswer(answer.replace('"root_ssh_failures":351', '"root_ssh_failures":350'), true));
  assert.throws(() => evidence.assertSkillAnswer(answer.split('\n')[0], true));
  assert.throws(() => evidence.assertSkillAnswer(answer.split('\n')[1], true));
});

test('uploaded snapshot rejects a missing or silently changed file', () => {
  assert.equal(typeof evidence.assertSnapshot, 'function');
  const files = { 'SKILL.md': '---\nname: e2e\n---', 'scripts/a.py': 'print(1)' };
  assert.doesNotThrow(() => evidence.assertSnapshot(files, { ...files }));
  assert.throws(() => evidence.assertSnapshot(files, { 'SKILL.md': files['SKILL.md'] }));
  assert.throws(() => evidence.assertSnapshot(files, { ...files, 'scripts/a.py': 'print(2)' }));
});

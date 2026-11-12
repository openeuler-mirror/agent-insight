import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as evidence from './skill-evidence.mjs';
import * as archive from './skill-archive.mjs';
import { scenarioResult } from './core.mjs';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('candidate diagnostics expose proof mismatches without publishing private rows or files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-candidate-diag-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, 'test.db');const db = new DatabaseSync(database);
  db.exec('CREATE TABLE Experiment (id TEXT, user TEXT, optimizationRecordId TEXT, sourceExperimentId TEXT, status TEXT, deletedAt TEXT, createdAt TEXT, configSnapshotJson TEXT, evaluatorIdsJson TEXT, evaluatorConfigsJson TEXT); CREATE TABLE ExperimentCase (id TEXT, experimentId TEXT, executionId TEXT, datasetInput TEXT, input TEXT, referenceOutput TEXT, actualOutput TEXT, deletedAt TEXT); CREATE TABLE ExperimentEvalResult (caseId TEXT, evaluatorId TEXT, status TEXT, verdict TEXT, score REAL, pointsJson TEXT, humanScore REAL); CREATE TABLE ExperimentCancellation (experimentId TEXT);');
  const secret = 'private-log-input-and-model-credential';
  const record = { id: 'record', status: 'pending_retest', candidateFiles: { 'SKILL.md': secret }, sourceRefs: [] };
  const dataset = { id: 'dataset', cases: [{ id: 'case', input: secret }] };
  const source = { snapshot: '{}', evaluators: '[]', configs: '{}' };
  const snapshot = { verificationOnly: true };
  snapshot.verification = { version: 1, candidateHash: 'mismatch', datasetId: dataset.id, caseIds: ['case'], inputHash: archive.stableHash(dataset.cases), candidateConfigHash: archive.stableHash(snapshot), sourceHash: archive.stableHash(source), baselineHash: archive.stableHash([]), resultsHash: archive.stableHash([]), result: { ok: true, fullCoverage: true, measured: 1, perCase: [], experimentId: 'candidate' } };
  const insert = db.prepare('INSERT INTO Experiment VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('baseline', 'test', null, null, 'done', null, '1', source.snapshot, source.evaluators, source.configs);
  insert.run('candidate', 'test', 'record', 'baseline', 'done', 'archived', '2', JSON.stringify(snapshot), '[]', '{}');
  insert.run('other-user', 'other', 'record', 'baseline', 'failed', null, '3', secret, '[]', '{}');
  db.close();
  const result = archive.candidateVerificationDiagnostics(database, 'test', record, dataset);
  assert.equal(result.experiments.length, 1);
  assert.equal(result.experiments[0].candidateMatches, false);
  assert.equal(result.experiments[0].candidateConfigMatches, true);
  assert.equal(result.experiments[0].sourceMatches, true);
  assert.equal(result.experiments[0].baselineRowsMatch, true);
  assert.equal(result.experiments[0].resultRowsMatch, true);
  assert.equal(result.experiments[0].inputMatches, true);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('003 cannot pass with upload/generation alone or without a published-version run', () => {
  const stages = ['application', 'login', 'model', 'ordinary-client', 'upload', 'generation', 'static', 'baseline-publish', 'dataset-ui', 'baseline', 'trace-ui', 'diagnosis', 'optimization', 'candidate', 'publish', 'published-run', 'persistence', 'cleanup'];
  assert.equal(scenarioResult(stages.map(id => ({ id, status: 'PASS' })), '003').status, 'PASS');
  for(const missing of ['dataset-ui','trace-ui','diagnosis','persistence','published-run']) assert.equal(scenarioResult(stages.filter(id => id !== missing).map(id => ({ id, status: 'PASS' })), '003').status, 'PARTIAL');
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

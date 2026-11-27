import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function stableHash(value) {
  const stable = item => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function assertCandidateProof(experiment, username, record, dataset) {
  assert.equal(experiment.user, username);assert.equal(experiment.optimizationRecordId, record.id);assert.equal(experiment.sourceExperimentId, record.sourceExperimentId);
  const snapshot = JSON.parse(experiment.configSnapshotJson);const proof = snapshot.verification;
  assert.equal(snapshot.verificationOnly, true);assert.equal(proof.version, 1);assert.equal(proof.candidateHash, stableHash(record.candidateFiles));
  assert.equal(proof.datasetId, dataset.id);assert.deepEqual(proof.caseIds, dataset.cases.map(item => item.id));assert.equal(proof.inputHash, stableHash(dataset.cases));
  assert.equal(typeof proof.result.ok, 'boolean');assert.equal(proof.result.fullCoverage, true);assert.equal(proof.result.measured, 1);assert.ok(!proof.result.incomplete && !proof.result.skipped);
  return snapshot;
}

export function candidateVerificationDiagnostics(database, username, record, dataset) {
  const db = new DatabaseSync(database, { readOnly: true });
  const status = value => ['pending_retest', 'retesting', 'retest_passed', 'retest_failed', 'optimizing', 'done', 'partial', 'failed', 'cancelled', 'running', 'draft'].includes(value) ? value : 'other';
  try {
    const rows = id => db.prepare('SELECT id, executionId, datasetInput, input, referenceOutput, actualOutput FROM ExperimentCase WHERE experimentId=? AND deletedAt IS NULL ORDER BY id').all(id).map(item => ({ ...item, results: db.prepare('SELECT evaluatorId, status, verdict, score, pointsJson, humanScore FROM ExperimentEvalResult WHERE caseId=? ORDER BY evaluatorId').all(item.id) }));
    const experiments = db.prepare('SELECT * FROM Experiment WHERE user=? AND optimizationRecordId=? ORDER BY createdAt DESC LIMIT 10').all(username, record.id).map(experiment => {
      let snapshot;try { snapshot = JSON.parse(experiment.configSnapshotJson || '{}'); } catch { return { validSnapshot: false }; }
      const proof = snapshot.verification || {};
      const source = db.prepare('SELECT * FROM Experiment WHERE user=? AND id=? AND deletedAt IS NULL').get(username, experiment.sourceExperimentId);
      const selected = (Array.isArray(proof.caseIds) ? proof.caseIds : []).map(id => dataset.cases.find(item => item.id === id));
      return {
        status: status(experiment.status), archived: Boolean(experiment.deletedAt), proofVersion: proof.version === 1,
        candidateMatches: proof.candidateHash === stableHash(record.candidateFiles),
        candidateConfigMatches: proof.candidateConfigHash === stableHash({ ...snapshot, verification: undefined }),
        sourceFound: Boolean(source), sourceMatches: Boolean(source && source.evaluatorIdsJson === experiment.evaluatorIdsJson && source.evaluatorConfigsJson === experiment.evaluatorConfigsJson && proof.sourceHash === stableHash({ snapshot: source.configSnapshotJson, evaluators: source.evaluatorIdsJson, configs: source.evaluatorConfigsJson })),
        baselineRowsMatch: Boolean(source && proof.baselineHash === stableHash(rows(source.id))),
        resultRowsMatch: proof.resultsHash === stableHash(rows(experiment.id)),
        inputMatches: proof.datasetId === dataset.id && selected.length === dataset.cases.length && selected.every(Boolean) && proof.inputHash === stableHash(selected),
        cancelled: db.prepare('SELECT COUNT(*) AS count FROM ExperimentCancellation WHERE experimentId IN (?, ?)').get(experiment.id, experiment.sourceExperimentId).count > 0,
        fullCoverage: proof.result?.fullCoverage === true, resultBound: proof.result?.experimentId === experiment.id,
      };
    });
    return { status: status(record.status), linkedLiveExperiment: Boolean(record.retestExperimentId), linkedVerification: record.sourceRefs.some(ref => ref.type === 'verification-result'), experiments };
  } finally { db.close(); }
}

export function readArchivedVerification(database, username, record, dataset) {
  const ref = record.sourceRefs.find(item => item.type === 'verification-result' && item.experimentDeleted && item.fullCoverage);
  assert.ok(ref?.experimentId, 'No archived candidate verification reference');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const experiment = db.prepare('SELECT * FROM Experiment WHERE id=? AND user=?').get(ref.experimentId, username);assert.ok(experiment?.deletedAt, 'Expected an archived experiment');assert.equal(experiment.status, 'done');
    const snapshot = assertCandidateProof(experiment, username, record, dataset);const proof = snapshot.verification;
    assert.equal(proof.candidateConfigHash, stableHash({ ...snapshot, verification: undefined }));
    const source = db.prepare('SELECT * FROM Experiment WHERE id=? AND user=? AND deletedAt IS NULL').get(experiment.sourceExperimentId, username);assert.ok(source);
    assert.equal(source.evaluatorIdsJson, experiment.evaluatorIdsJson);assert.equal(source.evaluatorConfigsJson, experiment.evaluatorConfigsJson);
    assert.equal(proof.sourceHash, stableHash({ snapshot: source.configSnapshotJson, evaluators: source.evaluatorIdsJson, configs: source.evaluatorConfigsJson }));
    const rows = id => db.prepare('SELECT id, executionId, datasetInput, input, referenceOutput, actualOutput FROM ExperimentCase WHERE experimentId=? AND deletedAt IS NULL ORDER BY id').all(id).map(item => ({ ...item, results: db.prepare('SELECT evaluatorId, status, verdict, score, pointsJson, humanScore FROM ExperimentEvalResult WHERE caseId=? ORDER BY evaluatorId').all(item.id) }));
    assert.equal(proof.baselineHash, stableHash(rows(source.id)));assert.equal(proof.resultsHash, stableHash(rows(experiment.id)));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ExperimentCancellation WHERE experimentId IN (?, ?)').get(source.id, experiment.id).count, 0);
    const cases = db.prepare('SELECT * FROM ExperimentCase WHERE experimentId=? AND deletedAt IS NULL ORDER BY id').all(experiment.id);
    const results = cases.flatMap(item => db.prepare('SELECT * FROM ExperimentEvalResult WHERE caseId=?').all(item.id));
    return { ...experiment, configSnapshot: snapshot, cases, results, archivedEvidence: true };
  } finally { db.close(); }
}

export function readFrozenSkillSnapshot(database, username, taskId) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const task = db.prepare('SELECT configJson FROM GrayscaleTask WHERE id=? AND user=?').get(taskId, username);assert.ok(task, 'Frozen execution task missing');
    const config = JSON.parse(task.configJson);const snapshot = config.skillSnapshots?.[config.boundSide || 'b'];assert.ok(snapshot?.files, 'Executed Skill snapshot missing');return snapshot;
  } finally { db.close(); }
}

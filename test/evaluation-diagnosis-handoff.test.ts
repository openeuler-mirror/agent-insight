import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('case evidence, report ownership, historical Skill versions and plan imports', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'evaluation-diagnosis-test-'));
  const database = path.join(dir, 'test.db');
  process.env.DATABASE_URL = 'file:' + database;
  process.env.AGENT_INSIGHT_STORAGE_DIR = dir;
  writeFileSync(database, '');
  execFileSync(path.resolve('node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], { env: process.env });
  const { prismaRaw: db } = await import('../src/lib/storage/prisma');
  const { buildSnapshot, previewSnapshot, importDiagnosis, submitDiagnosis, getDiagnosis, skillSnapshot } = await import('../src/lib/diagnosis/service');
  const { POST: createDiagnosis } = await import('../src/app/api/experiments/[id]/cases/[caseId]/diagnoses/route');
  const { hashInteractions } = await import('../src/lib/engine/agent-debug/trace-adapter');
  const { AGENT_DEBUG_GENERATOR } = await import('../src/lib/engine/agent-debug/types');
  const user = 'diagnosis-test';
  const trace = 'trace-test';
  const skillName = 'test-skill';
  try {
    await db.user.create({ data: { username: user, apiKey: 'test-key' } });
    const skill = await db.skill.create({ data: { user, name: skillName, category: 'test', versions: { create: { version: 1, content: 'original', files: '[]' } } } });
    const interactions = [{ role: 'assistant', content: 'test answer' }];
    await db.execution.create({ data: { id: trace, taskId: trace, user, invokedSkills: JSON.stringify([{ name: skillName, version: null }]) } });
    await db.session.create({ data: { taskId: trace, user, interactions: JSON.stringify(interactions) } });
    const experiment = await db.experiment.create({ data: { name: 'example', user } });
    const example = await db.experimentCase.create({ data: { experimentId: experiment.id, executionId: trace, input: 'task', actualOutput: 'actual', referenceOutput: 'expected' } });
    const result = await db.experimentEvalResult.create({ data: { experimentId: experiment.id, caseId: example.id, evaluatorId: 'test', status: 'done', score: 95.7, pointsJson: '[{"score":85.7}]' } });
    const context = { params: Promise.resolve({ id: experiment.id, caseId: example.id }) };
    const post = (key?: string) => createDiagnosis(new Request('http://localhost/api/diagnoses', { method: 'POST', headers: key ? { 'x-witty-api-key': key } : {}, body: JSON.stringify({ user, resultIds: [result.id], preview: true }) }), context);
    assert.equal((await post()).status, 401);
    const previewResponse = await post('test-key');
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.snapshot.skills[0].version, null);
    assert.equal(preview.snapshot.results[0].score, 95.7);
    await assert.rejects(buildSnapshot('someone-else', experiment.id, example.id, [result.id]), /不存在/);
    await db.experimentEvalResult.update({ where: { id: result.id }, data: { humanScore: 80 } });
    const snapshot = await buildSnapshot(user, experiment.id, example.id, [result.id]);
    await assert.rejects(submitDiagnosis(user, snapshot, { requestKey: 'test', expectedInputHash: preview.inputHash }), /已变化/);
    const inputHash = previewSnapshot(snapshot).inputHash;
    const report = { issues: [{ id: 'issue1', module: 'reflection' }, { id: 'issue2', module: 'system' }], findings: [
      { id: 'f1', evidence: 'trace step 2', correctionGuidance: 'verify before answering', summary: 'missing check', severity: 'medium', issueRefs: [{ issueId: 'issue1', role: 'root' }] },
      { id: 'f2', evidence: 'network', correctionGuidance: 'check network', summary: 'timeout', severity: 'medium', issueRefs: [{ issueId: 'issue2', role: 'root' }] },
    ] };
    const run = await db.diagnosisRun.create({ data: { user, requestKey: 'existing', experimentId: experiment.id, caseId: example.id, executionId: trace, inputHash, inputSnapshotJson: JSON.stringify(snapshot), status: 'done', reportJson: JSON.stringify(report), generatorVersion: `${AGENT_DEBUG_GENERATOR}:evaluation-input-v1` } });
    await t.test('new requests create distinct runs while retries remain idempotent', async (t) => {
      // Keep jobs pending so this API test never starts a real diagnosis model.
      const updateMany = db.diagnosisRun.updateMany;
      Object.defineProperty(db.diagnosisRun, 'updateMany', { configurable: true, value: async () => ({ count: 0 }) });
      t.after(() => Object.defineProperty(db.diagnosisRun, 'updateMany', { configurable: true, value: updateMany }));
      const confirm = async (requestKey: string) => {
        const response = await createDiagnosis(new Request('http://localhost/api/diagnoses', {
          method: 'POST', headers: { 'x-witty-api-key': 'test-key' },
          body: JSON.stringify({ resultIds: [result.id], requestKey, expectedInputHash: inputHash }),
        }), context);
        assert.equal(response.status, 200);
        return response.json();
      };
      const first = await confirm('new-first');
      assert.notEqual(first.runId, run.id);
      assert.equal((await confirm('new-first')).runId, first.runId);
      await db.diagnosisRun.update({ where: { id: first.runId }, data: { status: 'running', leaseUntil: new Date(Date.now() + 90_000) } });
      const second = await confirm('new-second');
      assert.notEqual(second.runId, first.runId);
      assert.notEqual(second.runId, run.id);
      assert.equal((await confirm('new-first')).runId, first.runId);
      await db.diagnosisRun.update({ where: { id: first.runId }, data: { status: 'done' } });
      assert.equal((await confirm('new-first')).runId, first.runId);
      assert.equal(await db.diagnosisRun.count({ where: { user, caseId: example.id } }), 3);
      assert.equal((await getDiagnosis(user, run.id)).id, run.id);
    });
    assert.equal((await getDiagnosis(user, run.id)).eligibility.f2, '系统或环境问题不直接进入 Skill 修改');
    const stored = await skillSnapshot(user, skillName, 1);
    const input = { runId: run.id, findingIds: ['f1'], baseVersion: 1, expectedContentHash: stored.contentHash, constraints: 'preserve tools' };
    await assert.rejects(importDiagnosis(user, skillName, input), /执行版本未记录/);
    await assert.rejects(importDiagnosis(user, skillName, { ...input, baselineVerified: true }), /执行版本未记录/);
    const frozen: typeof snapshot = { ...snapshot, skills: [{ ...snapshot.skills[0], version: 1, contentHash: null }] };
    await db.diagnosisRun.update({ where: { id: run.id }, data: { inputSnapshotJson: JSON.stringify(frozen) } });
    await assert.rejects(importDiagnosis(user, skillName, { ...input, baselineVerified: true }), /缺少内容校验信息/);
    frozen.skills[0] = { ...snapshot.skills[0], version: 1, contentHash: stored.contentHash, files: stored.files };
    await db.diagnosisRun.update({ where: { id: run.id }, data: { inputSnapshotJson: JSON.stringify(frozen) } });
    await assert.rejects(importDiagnosis(user, skillName, { ...input, baseVersion: 2 }), /必须使用执行时/);
    await assert.rejects(importDiagnosis(user, 'another', input), /未记录调用/);
    await assert.rejects(importDiagnosis(user, skillName, { ...input, baselineVerified: true, findingIds: ['f2'] }), /环境问题/);
    const imported = await importDiagnosis(user, skillName, input);
    assert.deepEqual(await importDiagnosis(user, skillName, input), imported);
    const plan = await db.skillOptPlan.findUniqueOrThrow({ where: { sessionId: imported.sessionId }, include: { items: true } });
    assert.equal(plan.status, 'draft');
    assert.equal(plan.items.length, 1);
    assert.equal(JSON.parse(plan.items[0].sourceRefsJson)[0].id, run.id);
    assert.equal(await db.skillVersion.count({ where: { skillId: skill.id } }), 1);
    const { canAccessDiagnosisSession } = await import('../src/lib/diagnosis/http');
    assert.equal(await canAccessDiagnosisSession(new Request('http://localhost', { headers: { 'x-witty-api-key': 'test-key' } }), imported.sessionId), true);
    assert.equal(await canAccessDiagnosisSession(new Request('http://localhost?user=' + user), imported.sessionId), false);
    await db.user.create({ data: { username: 'other', apiKey: 'other-key' } });
    assert.equal(await canAccessDiagnosisSession(new Request('http://localhost', { headers: { 'x-witty-api-key': 'other-key' } }), imported.sessionId), false);
    for (const status of ['pending', 'running']) {
      const interrupted = await db.diagnosisRun.create({ data: {
        user, requestKey: status, executionId: trace, inputHash, inputSnapshotJson: JSON.stringify(snapshot),
        status, generatorVersion: 'test', createdAt: new Date(0), leaseUntil: new Date(0),
      } });
      assert.equal((await getDiagnosis(user, interrupted.id)).status, 'failed');
    }
    await db.execution.update({ where: { id: trace }, data: { invokedSkills: JSON.stringify([{ name: skillName, version: 1 }]) } });
    await db.experimentEvalResult.update({ where: { id: result.id }, data: { score: null, evidenceJson: 'legacy unstructured evidence' } });
    const known = await buildSnapshot(user, experiment.id, example.id, [result.id]);
    assert.equal(known.results[0].score, null);
    assert.equal(known.results[0].evidence, 'legacy unstructured evidence');
    const knownRun = await db.diagnosisRun.create({ data: { user, requestKey: 'known', executionId: trace, inputHash: previewSnapshot(known).inputHash, inputSnapshotJson: JSON.stringify(known), status: 'done', reportJson: JSON.stringify(report), generatorVersion: 'test' } });
    await db.skillVersion.update({ where: { skillId_version: { skillId: skill.id, version: 1 } }, data: { content: 'changed' } });
    const changed = await skillSnapshot(user, skillName, 1);
    await assert.rejects(importDiagnosis(user, skillName, { ...input, runId: knownRun.id, expectedContentHash: changed.contentHash, baselineVerified: true }), /基线已变化/);
    await db.execution.update({ where: { id: trace }, data: { invokedSkills: '[]', skill: 'configured-but-not-invoked' } });
    const noSkill = await buildSnapshot(user, experiment.id, example.id, [result.id]);
    assert.deepEqual(noSkill.skills, []);
    assert.equal(noSkill.traceHash, hashInteractions(interactions));
    assert.equal((await getDiagnosis(user, run.id)).snapshot.skills[0].name, skillName);
  } finally { await db.$disconnect(); }
});

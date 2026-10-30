/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = mkdtempSync(path.join(os.tmpdir(), 'skill-verification-integration-'));
let prisma: typeof import('@/lib/storage/prisma')['prismaRaw'];
let adapter: typeof import('@/lib/skill-workbench/optimization-adapter');
let verifier: typeof import('@/lib/engine/skill-opt/experiment-verification');
let selfVerify: typeof import('@/lib/engine/skill-opt/self-verify');
let settings: typeof import('@/lib/storage/server-config');
let staticCalls = 0, clientCalls = 0, localCalls = 0, judgeCalls = 0;
let staticMode: 'ok' | 'blocked' | 'failed' = 'ok';
let candidateScore = 90;
let candidateVerdict: string | null = null;
let evidence: typeof import('@/lib/skill-workbench/verification-evidence');
let retest: typeof import('@/lib/skill-workbench/retest-service');
let clientFailure = false;
let judgedScore = 0.8;
let clientInputs: Array<Record<string, any>> = [];
const files = { 'SKILL.md': '---\nname: fixture\ndescription: Answer arithmetic questions with the result.\n---\n# Arithmetic\nReturn the correct sum.' };

test.before(async () => {
  writeFileSync(path.join(directory, 'test.db'), '');
  process.env.DATABASE_URL = `file:${path.join(directory, 'test.db')}`;
  process.env.AGENT_INSIGHT_HOME = directory;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { stdio: 'pipe', env: process.env });
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function (id, ...args) {
    if (id === '@opencode-ai/sdk') return { createOpencodeClient: () => assert.fail('no live runtime in integration fixtures') };
    if (id === '@/lib/engine/general-agent') return { runGeneralAgent: async () => { localCalls++; return { output: '42' }; } };
    if (id === '@/lib/engine/evaluation/judge') return { judgeAnswer: async () => { judgeCalls++; return { score: judgedScore, reason: 'Measured requirement coverage' }; } };
    if (id === '@/lib/engine/skill-issues/static-evaluator/llm-evaluator' || id === './llm-evaluator') return {
      runLlmStaticEvaluation: async () => {
        staticCalls++;
        return { ok: staticMode !== 'failed', errorMessage: staticMode === 'failed' ? 'fixture unavailable' : null,
          dimensionScores: { '结构规范性': 5 }, overallComments: {}, issues: staticMode === 'blocked'
            ? [{ severity: 'high', dimension: '安全风险性', summary: 'Remove unsafe operation', evidence: 'confirmed unsafe operation' }] : [] };
      },
    };
    if (id === '@/lib/skill-workbench/client-execution') return { executeSkillCaseOnClient: async (input: Record<string, any>) => {
      clientCalls++; clientInputs.push(input);
      if (clientFailure) throw new Error('client offline');
      const row = await prisma.experimentCase.create({ data: { experimentId: input.experimentId, input: input.query, actualOutput: 'candidate answer', referenceOutput: input.referenceOutput } });
      return { sessionId: row.id, output: row.actualOutput, experimentCaseId: row.id };
    } };
    if (id === '@/lib/engine/experiment/run-experiment') return { evaluateEvalExperimentCase: async (experimentId: string, caseId: string) => {
      const result = await prisma.experimentEvalResult.create({ data: { experimentId, caseId, evaluatorId: 'custom-fixture', status: 'done', score: candidateScore, verdict: candidateVerdict, summary: '必须返回 42', pointsJson: JSON.stringify([{status:'missing',label:'结果等于42',suggestion:'修正计算'}]) } });
      return [result];
    } };
    return original.call(this, id, ...args);
  };
  try {
    ({ prismaRaw: prisma } = await import('@/lib/storage/prisma'));
    adapter = await import('@/lib/skill-workbench/optimization-adapter');
    verifier = await import('@/lib/engine/skill-opt/experiment-verification');
    selfVerify = await import('@/lib/engine/skill-opt/self-verify');
    evidence = await import('@/lib/skill-workbench/verification-evidence');
    retest = await import('@/lib/skill-workbench/retest-service');
    settings = await import('@/lib/storage/server-config');
  } finally { loader._load = original; }
});
test.after(async () => { await prisma?.$disconnect(); });
test.beforeEach(() => { staticCalls = clientCalls = localCalls = judgeCalls = 0; staticMode = 'ok'; candidateScore = 90; candidateVerdict = null; clientFailure = false; clientInputs = []; });

async function owner() {
  const user = randomUUID();
  await settings.saveUserSettings(user, { activeConfigId: 'fixture-model', configs: [{ id: 'fixture-model', name: 'fixture', apiKey: 'test-only', model: 'fixture-model', baseUrl: 'http://127.0.0.1:1/v1' }] });
  return user;
}

async function optimizationFixture(source = 'generated') {
  const user = await owner();
  const opt = await prisma.skillOptSession.create({ data: { user, skillName: 'fixture', baseVersion: 0, files: JSON.stringify({ '/workspace/SKILL.md': { content: files['SKILL.md'] } }) } });
  const session = await prisma.skillWorkbenchSession.create({ data: { user, source, skillName: 'fixture', workVersion: 0, filesJson: JSON.stringify(files), optSessionId: opt.id } });
  const run = await adapter.beginWorkbenchOptimizationRun({ user, optSessionId: opt.id, runId: opt.id, sourceKind: 'user', sourceRefs: [] });
  assert.equal(run?.kind, 'started');
  return { user, opt, session, run: run! };
}

test('successful unchanged candidate performs exactly one static evaluation', async () => {
  const { user, session, run } = await optimizationFixture();
  await adapter.finishWorkbenchOptimizationRun({ user, workbenchSessionId: session.id, taskId: run.taskId, recordId: run.recordId, sourceKind: 'user', sourceRefs: [], repair: async () => assert.fail('must not repair') });
  assert.equal(staticCalls, 1);
  assert.equal(await prisma.skillSnapshotEvaluation.count({ where: { sessionId: session.id } }), 1);
});

test('repair changing content re-evaluates and attaches the new result', async () => {
  const { user, opt, session, run } = await optimizationFixture();
  staticMode = 'blocked';
  await adapter.finishWorkbenchOptimizationRun({ user, workbenchSessionId: session.id, taskId: run.taskId, recordId: run.recordId, sourceKind: 'user', sourceRefs: [], repair: async () => {
    staticMode = 'ok';
    await prisma.skillOptSession.update({ where: { id: opt.id }, data: { files: JSON.stringify({ '/workspace/SKILL.md': { content: `${files['SKILL.md']}\nOnly safe operations.` } }) } });
  } });
  assert.equal(staticCalls, 2);
  const rows = await prisma.skillSnapshotEvaluation.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].contentHash, rows[1].contentHash);
});

test('failed/partial static evaluation is not reused', async () => {
  const { user, session, run } = await optimizationFixture();
  staticMode = 'failed';
  await adapter.finishWorkbenchOptimizationRun({ user, workbenchSessionId: session.id, taskId: run.taskId, recordId: run.recordId, sourceKind: 'user', sourceRefs: [], repair: async () => {} });
  assert.equal(staticCalls, 2);
});

async function sourceFixture(user?: string) {
  user ??= await owner();
  const caseId = randomUUID(), datasetId = randomUUID();
  const item = { id: caseId, input: 'What is six times seven?', expectedOutput: '42', tags: [], evaluationFocus: '', trajectory: '' };
  await prisma.agentEvalDataset.create({ data: { id: datasetId, user, name: 'behavior', casesJson: JSON.stringify([item]), caseCount: 1, projectionReady: true } });
  const target = { workerId: 'fixture-worker', host: 'fixture-host', platform: 'opencode', agent: 'build', model: 'fixture/model' };
  const experiment = await prisma.experiment.create({ data: { user, name: 'original', status: 'done', scope: 'skill-workbench', skillName: 'fixture', skillVersion: 0, preset: 'use-case', evaluatorIdsJson: '["custom-fixture"]', evaluatorConfigsJson: '{"version":1}' } });
  const row = await prisma.experimentCase.create({ data: { experimentId: experiment.id, input: item.input, datasetInput: item.input, referenceOutput: item.expectedOutput, actualOutput: 'old answer' } });
  await prisma.experimentEvalResult.create({ data: { experimentId: experiment.id, caseId: row.id, evaluatorId: 'custom-fixture', status: 'done', score: 60 } });
  const task = await prisma.grayscaleTask.create({ data: { user, skillId: 'fixture', skillName: 'fixture', skillVersion: 0, skillVersionId: 'fixture-v0', taskName: 'original',
    configJson: JSON.stringify({ evalExperimentId: experiment.id, boundSide: 'b', executionTarget: target, skillSnapshots: { b: { name: 'fixture', version: 0, files } } }),
    caseStatesJson: JSON.stringify({ [caseId]: { b: { runs: [{ status: 'pass', experimentCaseId: row.id, score: 60 }] } } }),
  } });
  await prisma.experiment.update({ where: { id: experiment.id }, data: { configSnapshotJson: JSON.stringify({ evaluatorIds: ['custom-fixture'], datasetId, caseIds: [caseId], grayscaleTaskId: task.id, boundSide: 'b', executionTarget: target, customEvaluatorSnapshots: { schemaVersion: 1, cards: { 'custom-fixture': { prompt: 'frozen grading rule' } } } }) } });
  return { user, datasetId, item, experiment, task, target };
}

test('original client and frozen evaluators execute only the candidate; old scores are reused', async () => {
  const fixture = await sourceFixture();
  const result = await verifier.verifyFromSourceExperiment({ user: fixture.user, skillName: 'fixture', baseVersion: 0, baseFiles: files, candidateFiles: { 'SKILL.md': `${files['SKILL.md']}\nImproved.` }, maxCases: 5 });
  assert.equal(clientCalls, 1); assert.equal(localCalls, 0); assert.equal(judgeCalls, 0);
  assert.equal(result?.baseMean, 60); assert.equal(result?.candMean, 90); assert.equal(result?.reused, 1); assert.equal(result?.ok, true);
  assert.deepEqual(clientInputs[0].executionTarget, fixture.target);
  const saved = await prisma.experiment.findUniqueOrThrow({ where: { id: result!.experimentId } });
  assert.equal(saved.evaluatorConfigsJson, '{"version":1}');
  assert.equal(JSON.parse(saved.configSnapshotJson!).customEvaluatorSnapshots.cards['custom-fixture'].prompt, 'frozen grading rule');
});

test('changed baseline or dataset, partial evidence, and client failure never become successful behavior comparisons', async () => {
  const fixture = await sourceFixture();
  const input = { user: fixture.user, skillName: 'fixture', baseVersion: 0, baseFiles: files, candidateFiles: files, maxCases: 5 };
  const changed = await verifier.verifyFromSourceExperiment({ ...input, baseFiles: { 'SKILL.md': 'changed' } });
  assert.match(changed!.incomplete!, /不一致/); assert.equal(clientCalls, 0);
  await prisma.agentEvalDataset.update({ where: { id: fixture.datasetId }, data: { casesJson: JSON.stringify([{ ...fixture.item, expectedOutput: '43' }]) } });
  assert.match((await verifier.verifyFromSourceExperiment(input))!.incomplete!, /变化/); assert.equal(clientCalls, 0);
  await prisma.agentEvalDataset.update({ where: { id: fixture.datasetId }, data: { casesJson: JSON.stringify([fixture.item]) } });
  clientFailure = true;
  assert.match((await verifier.verifyFromSourceExperiment(input))!.incomplete!, /offline/);
});

test('source experiments filter trigger cases before applying the behavioral case limit', async () => {
  const fixture = await sourceFixture();
  const trigger = { ...fixture.item, id: 'trigger-only', expectedOutput: 'Skill should trigger' };
  await prisma.agentEvalDataset.update({ where: { id: fixture.datasetId }, data: { casesJson: JSON.stringify([trigger, fixture.item]) } });
  const source = await prisma.experiment.findUniqueOrThrow({ where: { id: fixture.experiment.id } });
  await prisma.experiment.update({ where: { id: source.id }, data: { configSnapshotJson: JSON.stringify({
    ...JSON.parse(source.configSnapshotJson!), caseIds: [trigger.id, fixture.item.id, fixture.item.id],
  }) } });
  const result = await verifier.verifyFromSourceExperiment({ user: fixture.user, skillName: 'fixture', baseVersion: 0, baseFiles: files, candidateFiles: files, maxCases: 1 });
  assert.equal(result?.measured, 1);
  assert.equal(result?.incomplete, undefined);
  assert.equal(clientCalls, 1);
  assert.equal(clientInputs[0].datasetCaseId, fixture.item.id);
});

test('regression is rejected; cancellation is propagated instead of producing a pass', async () => {
  const fixture = await sourceFixture();
  const input = { user: fixture.user, skillName: 'fixture', baseVersion: 0, baseFiles: files, candidateFiles: files, maxCases: 5 };
  candidateScore = 40;
  assert.equal((await verifier.verifyFromSourceExperiment(input))?.ok, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(verifier.verifyFromSourceExperiment({ ...input, signal: controller.signal }));
});

test('local behavior reuses persisted base scores and rejudges cached output when criteria change', async () => {
  const user = await owner();
  const skill = await prisma.skill.create({ data: { user, name: 'fixture', description: '' } });
  const cases = [{ id: 'c', input: 'Return the answer to six times seven', expectedOutput: '42', tags: [], evaluationFocus: '', trajectory: '' }];
  const input = { user, skillName: 'fixture', skillId: skill.id, baseVersion: 0, baseFiles: files, candidateFiles: files, candidateSkillMd: files['SKILL.md'], cases };
  assert.equal((await selfVerify.verifyBehavioral(input)).measured, 1);
  assert.equal(localCalls, 2); assert.equal(judgeCalls, 2);
  const second = await selfVerify.verifyBehavioral(input);
  assert.equal(second.reused, 1); assert.equal(localCalls, 3); assert.equal(judgeCalls, 3);
  const third = await selfVerify.verifyBehavioral({ ...input, cases: [{ ...cases[0], expectedOutput: 'The result is 42.' }] });
  assert.equal(third.reused, 1); assert.equal(localCalls, 4); assert.equal(judgeCalls, 5);
  judgedScore = NaN;
  assert.match((await selfVerify.verifyBehavioral({ ...input, cases: [{ ...cases[0], input: 'Different task' }] })).incomplete!, /0\/1/);
  judgedScore = 0.8;
});


test('0→0 does not repair a failed target; explicit pass and non-regression are required', async () => {
  const fixture = await sourceFixture();
  await prisma.experimentEvalResult.updateMany({ where: { experimentId: fixture.experiment.id }, data: { score: 0, verdict: 'fail' } });
  const input = { user: fixture.user, skillName: 'fixture', baseVersion: 0, baseFiles: files, candidateFiles: files, maxCases: 5 };
  candidateScore = 0; candidateVerdict = 'fail';
  const failed = await verifier.verifyFromSourceExperiment(input);
  assert.equal(failed?.ok, false); assert.equal(failed?.targetFailures?.length, 1);
  assert.match(failed!.targetFailures![0].reason!, /修正计算/);
  candidateScore = 100; candidateVerdict = 'pass';
  assert.equal((await verifier.verifyFromSourceExperiment(input))?.ok, true);
  assert.equal(verifier.summarizeBehavior([{ caseId: 'a', base: 80, cand: 70, delta: -10, reason: '' }, { caseId: 'b', base: 0, cand: 100, delta: 100, reason: '' }], 2).ok, false);
});

test('final candidate links evidence; explicit retest reuses it without execution; changed content and results invalidate it', async () => {
  const fixture = await sourceFixture();
  const session = await prisma.skillWorkbenchSession.create({ data: { user: fixture.user, skillName: 'fixture', source: 'management', workVersion: 0 } });
  const record = await prisma.skillOptimizationRecord.create({ data: { user: fixture.user, sessionId: session.id, skillName: 'fixture', baseVersion: 0, sourceKind: 'user', candidateVersionLabel: 'v1-candidate', status: 'pending_retest', candidateFilesJson: JSON.stringify(files), sourceExperimentId: fixture.experiment.id } });
  const result = await verifier.verifyFromSourceExperiment({ user: fixture.user, skillName: 'fixture', baseVersion: 0, baseFiles: files, candidateFiles: files, optimizationRecordId: record.id, maxCases: 5 });
  const input = { user: fixture.user, recordId: record.id, skillName: 'fixture', baseVersion: 0, files, sourceExperimentId: fixture.experiment.id };
  assert.equal((await evidence.linkCandidateVerification(input))?.status, 'retest_passed');
  const reused = await retest.retestOptimizationCandidate({ user: fixture.user, recordId: record.id, skillName: 'fixture' });
  assert.equal(reused.reused, true); assert.equal(clientCalls, 1);
  assert.equal(await evidence.cleanupOptimizationVerificationExperiments({ user: fixture.user, recordId: record.id }), 1);
  assert.equal((await evidence.findCandidateVerification(input))?.archived, true);
  const archivedReuse = await retest.retestOptimizationCandidate({ user: fixture.user, recordId: record.id, skillName: 'fixture' });
  assert.equal(archivedReuse.reused, true); assert.equal(archivedReuse.experimentId, null); assert.equal(clientCalls, 1);
  assert.equal((await prisma.skillOptimizationRecord.findUniqueOrThrow({ where: { id: record.id } })).retestExperimentId, null);
  assert.equal(await evidence.cleanupOptimizationVerificationExperiments({ user: fixture.user, recordId: record.id }), 0);
  assert.equal(await evidence.findCandidateVerification({ ...input, files: { 'SKILL.md': 'changed after verification' } }), null);
  const source = await prisma.experiment.findUniqueOrThrow({ where: { id: fixture.experiment.id } });
  await prisma.experiment.update({ where: { id: source.id }, data: { evaluatorConfigsJson: '{"changed":true}' } });
  assert.equal(await evidence.findCandidateVerification(input), null);
  await prisma.experiment.update({ where: { id: source.id }, data: { evaluatorConfigsJson: source.evaluatorConfigsJson } });
  await prisma.agentEvalDataset.update({ where: { id: fixture.datasetId }, data: { casesJson: JSON.stringify([{ ...fixture.item, expectedOutput: '43' }]) } });
  assert.equal(await evidence.findCandidateVerification(input), null);
  await prisma.agentEvalDataset.update({ where: { id: fixture.datasetId }, data: { casesJson: JSON.stringify([fixture.item]) } });
  await prisma.experimentEvalResult.updateMany({ where: { experimentId: result!.experimentId }, data: { score: 0 } });
  assert.equal(await evidence.findCandidateVerification(input), null);
  const freshRetest = await retest.retestOptimizationCandidate({ user: fixture.user, recordId: record.id, skillName: 'fixture' });
  assert.equal(freshRetest.reused, false); assert.equal(clientCalls, 2);
  assert.equal(await evidence.cleanupOptimizationVerificationExperiments({ user: fixture.user, recordId: record.id }), 0);
  const formal = await prisma.experiment.findUniqueOrThrow({ where: { id: freshRetest.experimentId! } });
  assert.equal(formal.deletedAt, null); assert.equal(JSON.parse(formal.configSnapshotJson!).verificationPurpose, 'retest');
});

test('optimization finalization cleans all temporary rounds and preserves source, formal retest and reusable proof', async () => {
  const { user, session, run } = await optimizationFixture('management');
  const source = await sourceFixture(user);
  const input = { user, skillName: 'fixture', baseVersion: 0, baseFiles: files, candidateFiles: files,
    optimizationRecordId: run.recordId, maxCases: 5 };
  const first = await verifier.verifyFromSourceExperiment({ ...input, candidateFiles: { ...files, 'SKILL.md': `${files['SKILL.md']}\nFirst round` } });
  const formal = await verifier.verifyFromSourceExperiment({ ...input, verificationPurpose: 'retest' });
  const final = await verifier.verifyFromSourceExperiment(input);
  const legacyData = { user, name: 'legacy verification', status: 'done', scope: 'skill-workbench', preset: 'retest',
    skillName: 'fixture', skillVersion: 0, optimizationRecordId: run.recordId, configSnapshotJson: '{"verificationOnly":true}' };
  const legacy = await prisma.experiment.create({ data: legacyData });
  const laterLegacyRetest = await prisma.experiment.create({ data: { ...legacyData, createdAt: new Date(Date.now() + 60_000) } });
  assert.equal(await evidence.cleanupOptimizationVerificationExperiments({ user, recordId: run.recordId! }), 0);
  assert.equal(await evidence.cleanupOptimizationVerificationExperiments({ user: 'another-user', recordId: run.recordId! }), 0);
  await adapter.finishWorkbenchOptimizationRun({ user, workbenchSessionId: session.id, taskId: run.taskId,
    recordId: run.recordId, sourceKind: 'user', sourceRefs: [] });
  for (const id of [first!.experimentId, final!.experimentId, legacy.id]) {
    assert.ok((await prisma.experiment.findUniqueOrThrow({ where: { id } })).deletedAt);
  }
  for (const id of [source.experiment.id, formal!.experimentId, laterLegacyRetest.id]) {
    assert.equal((await prisma.experiment.findUniqueOrThrow({ where: { id } })).deletedAt, null);
  }
  const record = await prisma.skillOptimizationRecord.findUniqueOrThrow({ where: { id: run.recordId } });
  assert.equal(record.status, 'retest_passed'); assert.equal(record.retestExperimentId, null);
  assert.ok(JSON.parse(record.sourceRefsJson).some((ref: any) => ref.type === 'verification-result' && ref.experimentDeleted));
  const reused = await retest.retestOptimizationCandidate({ user, recordId: record.id, skillName: 'fixture' });
  assert.equal(reused.reused, true); assert.equal(clientCalls, 3);
});

test('failed optimization cleans failed temporary experiments; active experiments and manual deletion are excluded', async () => {
  const { user, session, run } = await optimizationFixture('management');
  await sourceFixture(user);
  clientFailure = true;
  const failed = await verifier.verifyFromSourceExperiment({ user, skillName: 'fixture', baseVersion: 0, baseFiles: files,
    candidateFiles: files, optimizationRecordId: run.recordId, maxCases: 5 });
  const active = await prisma.experiment.create({ data: { user, name: 'still running', scope: 'skill-workbench', preset: 'retest',
    skillName: 'fixture', skillVersion: 0, optimizationRecordId: run.recordId, status: 'running', configSnapshotJson: '{"verificationOnly":true}' } });
  await adapter.finishWorkbenchOptimizationRun({ user, workbenchSessionId: session.id, taskId: run.taskId,
    recordId: run.recordId, sourceKind: 'user', sourceRefs: [], error: 'fixture failure' });
  assert.ok((await prisma.experiment.findUniqueOrThrow({ where: { id: failed!.experimentId } })).deletedAt);
  assert.equal((await prisma.experiment.findUniqueOrThrow({ where: { id: active.id } })).deletedAt, null);
  clientFailure = false;
  const result = await verifier.verifyFromSourceExperiment({ user, skillName: 'fixture', baseVersion: 0, baseFiles: files,
    candidateFiles: files, optimizationRecordId: run.recordId, maxCases: 5 });
  await prisma.experiment.update({ where: { id: result!.experimentId }, data: { deletedAt: new Date() } });
  assert.equal(await evidence.findCandidateVerification({ user, recordId: run.recordId!, skillName: 'fixture', baseVersion: 0, files }), null);
});

test('confirmed cancellation cleans temporary results without converting the optimization status', async () => {
  const { user, run } = await optimizationFixture('management');
  await sourceFixture(user);
  const result = await verifier.verifyFromSourceExperiment({ user, skillName: 'fixture', baseVersion: 0,
    baseFiles: files, candidateFiles: files, optimizationRecordId: run.recordId, maxCases: 5 });
  const { finishOptimizationCancellation } = await import('@/lib/skill-workbench/optimization-cancellation');
  await finishOptimizationCancellation(run.taskId);
  assert.equal(await evidence.cleanupOptimizationVerificationExperiments({ user, recordId: run.recordId! }), 1);
  assert.ok((await prisma.experiment.findUniqueOrThrow({ where: { id: result!.experimentId } })).deletedAt);
  assert.equal((await prisma.skillOptimizationRecord.findUniqueOrThrow({ where: { id: run.recordId } })).status, 'optimization_cancelled');
});



test('optimizer output limit retains full evidence on disk and does not truncate normal output', async () => {
  const { OPTIMIZATION_OUTPUT_PLUGIN } = await import('@/lib/engine/skill-opt/optimization-context');
  const module = await import('data:text/javascript;base64,' + Buffer.from(OPTIMIZATION_OUTPUT_PLUGIN).toString('base64'));
  const hook = (await module.OptimizationOutput({ directory }))['tool.execute.after'];
  const original = 'start' + 'x'.repeat(20000) + 'end';
  const output = { output: original };
  await hook({ tool: 'bash' }, output);
  assert.ok(output.output.length < 8192); assert.match(output.output, /^start/); assert.match(output.output, /end$/);
  const file = output.output.match(/完整输出：([^。]+)/);
  assert.ok(file); assert.equal(readFileSync(file[1], 'utf8'), original);
  const small = { output: 'passed: 10, failed: 0' }; await hook({ tool: 'bash' }, small); assert.equal(small.output, 'passed: 10, failed: 0');
});


test('dynamic closure is restricted to validated original issue IDs, not duplicate problems on untested executions', async () => {
  const fixture = await sourceFixture();
  const skill = await prisma.skill.create({ data: { user: fixture.user, name: 'fixture' } });
  const trace = await prisma.execution.create({ data: { user: fixture.user } });
  await prisma.experimentCase.updateMany({ where: { experimentId: fixture.experiment.id }, data: { executionId: trace.id } });
  const issues = [];
  for (let i = 0; i < 2; i++) {
    const evaluation = await prisma.evaluation.create({ data: { user: fixture.user, skillId: skill.id, version: 0, type: 'dynamic', executionId: i === 0 ? trace.id : null, runId: `experiment:${fixture.experiment.id}:fixture` } });
    issues.push(await prisma.skillIssue.create({ data: { user: fixture.user, skillId: skill.id, version: 0, source: 'dynamic', evaluationId: evaluation.id, dedupKey: 'same', severity: 'high', summary: 'Return 42' } }));
  }
  const session = await prisma.skillWorkbenchSession.create({ data: { user: fixture.user, skillName: 'fixture', source: 'management', workVersion: 0 } });
  const record = await prisma.skillOptimizationRecord.create({ data: { user: fixture.user, sessionId: session.id, skillName: 'fixture', baseVersion: 0, candidateVersionLabel: 'v1-candidate', candidateFilesJson: JSON.stringify(files), sourceExperimentId: fixture.experiment.id, status: 'pending_retest' } });
  candidateVerdict = 'pass'; candidateScore = 100;
  const verified = await verifier.verifyFromSourceExperiment({ user: fixture.user, skillName: 'fixture', baseVersion: 0, baseFiles: files, candidateFiles: files, optimizationRecordId: record.id, maxCases: 5 });
  const { applyCompletedOptimizationPlan } = await import('@/lib/skill-workbench/optimization-plan-state');
  const result = await applyCompletedOptimizationPlan({ user: fixture.user, workbenchSessionId: session.id, resolvedRunId: record.id, sourceRefs: issues.map(issue => ({ type: 'issue', id: issue.id })), verificationExperimentId: verified!.experimentId });
  assert.equal(result.resolvedIssues, 1);
  assert.notEqual((await prisma.skillIssue.findUniqueOrThrow({ where: { id: issues[0].id } })).resolvedAt, null);
  assert.equal((await prisma.skillIssue.findUniqueOrThrow({ where: { id: issues[1].id } })).resolvedAt, null);
});




test('sampled coverage remains incomplete even when every sampled target passes', async () => {
  const fixture = await sourceFixture();
  const second = { ...fixture.item, id: randomUUID(), input: 'What is 7 times 6?' };
  await prisma.agentEvalDataset.update({ where: { id: fixture.datasetId }, data: { casesJson: JSON.stringify([fixture.item, second]) } });
  const source = await prisma.experiment.findUniqueOrThrow({ where: { id: fixture.experiment.id } });
  await prisma.experiment.update({ where: { id: source.id }, data: { configSnapshotJson: JSON.stringify({ ...JSON.parse(source.configSnapshotJson!), caseIds: [fixture.item.id, second.id] }) } });
  const result = await verifier.verifyFromSourceExperiment({ user: fixture.user, skillName: 'fixture', baseVersion: 0, baseFiles: files, candidateFiles: files, maxCases: 1 });
  assert.equal(result?.ok, true); assert.equal(result?.fullCoverage, false); assert.equal(clientCalls, 1);
});

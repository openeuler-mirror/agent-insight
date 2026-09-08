import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { prisma } from '../src/lib/storage/prisma';
import { bootstrap } from '../src/lib/evaluation-harness/catalog';
import { createAsset, listAssets, saveCredential, credentialConfig, getAsset } from '../src/lib/evaluation-harness/store';
import { createRun, executeRun, reviseDataset, staticAnalysis } from '../src/lib/evaluation-harness/service';
async function main() {
  assert.match(process.env.DATABASE_URL || '', /harness-e2e/, 'Use an isolated harness-e2e database');
  const user = 'harness-e2e-' + Date.now();
  process.env.EVALUATION_CREDENTIAL_KEY = randomBytes(32).toString('base64');
  await bootstrap(user);
  let assets = await listAssets(user);
  const target = (v: number) => assets.find((a: any) => a.kind === 'target' && a.assetKey === 'loan-agent' && a.version === v)!,
    dataset = assets.find((a: any) => a.kind === 'dataset')!,
    rules = assets.find((a: any) => a.assetKey === 'business-rules')!;
  const config = {
    name: '真实 HTTP 基线',
    targetId: target(1).id,
    datasetId: dataset.id,
    evaluatorIds: [rules.id],
    timeoutSeconds: 10,
    retries: 1,
    threshold: 90,
    concurrency: 2
  };
  const first = await createRun(user, config),
    bad = await executeRun(user, first);
  assert.equal(bad.summary.fail, 2);
  assert.equal(bad.summary.score, 50);
  assert.equal(bad.summary.gate, 'blocked');
  assert.equal(bad.experiment.cases.length, 4);
  assert.ok(bad.experiment.cases.every((c: any) => c.executionId && c.traceAttempts.length === 1));
  console.log('PASS real HTTP baseline, multi-turn, native Trace, business failures never retried');
  const second = await createRun(user, {
      ...config,
      targetId: target(2).id,
      sourceExperimentId: first,
      name: '真实修复回归'
    }),
    good = await executeRun(user, second);
  assert.equal(good.summary.score, 100);
  assert.equal(good.summary.gate, 'pass');
  assert.equal(good.manifest.dataset.contentHash, bad.manifest.dataset.contentHash);
  console.log('PASS fixed external target, unchanged dataset, regression 50 -> 100');
  const traceBindings = Object.fromEntries(good.experiment.cases.map((c: any) => [JSON.parse(c.caseValuesJson).id, c.executionId]));
  const replayConfig = { ...config, targetId: target(2).id, traceSource: 'existing', traceBindings, name: '已有 Trace 逐轮重新评估' };
  const beforeExecutions = await prisma.execution.count({ where: { user } });
  const beforeSessions = await prisma.session.count({ where: { user } });
  const replayId = await createRun(user, replayConfig);
  const replayed = await executeRun(user, replayId);
  assert.equal(replayed.summary.score, 100);
  assert.equal(replayed.summary.gate, 'pass');
  assert.equal(await prisma.execution.count({ where: { user } }), beforeExecutions);
  assert.equal(await prisma.session.count({ where: { user } }), beforeSessions);
  assert.ok(replayed.experiment.cases.every((c: any) => Object.values(traceBindings).includes(c.executionId) && c.traceAttempts.length === 0));
  assert.notEqual(replayed.manifest.comparisonHash, good.manifest.comparisonHash);
  await assert.rejects(() => createRun(user, { ...replayConfig, targetId: target(1).id }), /版本不一致/);
  await assert.rejects(() => createRun(user, { ...replayConfig, traceBindings: {} }), /每个待评 Case/);
  const caseIds = Object.keys(traceBindings);
  await assert.rejects(() => createRun(user, { ...replayConfig, traceBindings: { ...traceBindings, [caseIds[0]]: traceBindings[caseIds[1]] } }), /逐轮输入/);
  await assert.rejects(() => createRun(user, { ...replayConfig, traceBindings: { ...traceBindings, [caseIds[0]]: 'unknown-private-trace' } }), /无权访问/);
  console.log('PASS existing Trace replay: four cases 100%, original Trace IDs, zero new executions/sessions/attempts; reject wrong version, input, missing or inaccessible source');
  const revised = {
      ...good.results[0].case,
      note: '修订备注，历史不变'
    },
    newVersion = await reviseDataset(user, second, revised.id, revised);
  assert.equal(newVersion.version, 2);
  assert.equal(JSON.parse((await getAsset(user, dataset.id)).contentJson).cases[0].note, '');
  console.log('PASS case writeback creates new dataset version; old snapshot unchanged');
  await assert.rejects(() => getAsset('other-user', dataset.id));
  await staticAnalysis(user, target(1).id);
  const privateCredential = await saveCredential(user, 'encryption-test', {
    apiKey: 'synthetic-not-a-live-key',
    baseUrl: 'https://example.com/v1',
    model: 'test-model'
  });
  const raw = await prisma.evaluationCredential.findUnique({
    where: {
      id: privateCredential.id
    }
  });
  assert.ok(!raw!.ciphertext.includes('synthetic'));
  assert.equal((await credentialConfig(user, privateCredential.id)).apiKey, 'synthetic-not-a-live-key');
  console.log('PASS static analysis independent, tenant isolation and credential encryption');
  console.log(JSON.stringify({
    user,
    baseline: first,
    regression: second,
    score: good.summary.score
  }));
  await prisma.$disconnect();
}
main().catch(async e => {
  console.error(e);
  await prisma.$disconnect();
  process.exitCode = 1;
});

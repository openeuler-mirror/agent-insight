import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('experiment cancellation persists intent, isolates cases, blocks late work and preserves source records', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'experiment-cancellation-'));
  process.env.DATABASE_URL = `file:${path.join(directory, 'test.db')}`;
  await fs.writeFile(path.join(directory, 'test.db'), '');
  execFileSync(path.resolve('node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' });
  const { prismaRaw: prisma } = await import('../src/lib/storage/prisma');
  const { deleteExperimentExecution, reconcileCancellation } = await import('../src/lib/engine/experiment/cancellation-service');
  const { assertExperimentActive, withExperimentCancellation, markExperimentCleanupUnconfirmed } = await import('../src/lib/engine/experiment/cancellation-context');
  t.after(async () => { await prisma.$disconnect(); await fs.rm(directory, { recursive: true, force: true }); });
  const experiment = await prisma.experiment.create({ data: { user: 'owner', name: 'cancel test', status: 'running', cases: { create: [{ id: 'case-a' }, { id: 'case-b' }] } } });
  await assert.rejects(() => deleteExperimentExecution('other', experiment.id), /不存在/);
  await assert.rejects(() => deleteExperimentExecution('owner', experiment.id, 'foreign'), /不属于/);
  const running = withExperimentCancellation(experiment.id, 'case-a', (signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  }));
  // Wait until the operation has entered its cancellable body.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const cancelled = await deleteExperimentExecution('owner', experiment.id, 'case-a');
  await assert.rejects(() => running, /已取消/);
  await assert.rejects(() => assertExperimentActive(experiment.id, 'case-a'), /已取消/);
  await assertExperimentActive(experiment.id, 'case-b');
  assert.equal((await prisma.experiment.findUniqueOrThrow({ where: { id: experiment.id } })).deletedAt, null);
  assert.ok((await prisma.experimentCase.findUniqueOrThrow({ where: { id: 'case-a' } })).deletedAt);
  assert.equal((await reconcileCancellation(cancelled.id)).status, 'completed');
  assert.equal((await deleteExperimentExecution('owner', experiment.id, 'case-a')).id, cancelled.id);
  await deleteExperimentExecution('owner', experiment.id);
  await assert.rejects(() => assertExperimentActive(experiment.id), /已取消/);
  assert.equal(await prisma.experimentCase.count({ where: { experimentId: experiment.id } }), 2);

  const single = await prisma.experiment.create({ data: { user: 'owner', name: 'last case', status: 'running', watchMode: true,
    cases: { create: { id: 'last-case' } } } });
  await deleteExperimentExecution('owner', single.id, 'last-case');
  const deletedSingle = await prisma.experiment.findUniqueOrThrow({ where: { id: single.id } });
  assert.ok(deletedSingle.deletedAt);
  assert.equal(deletedSingle.status, 'cancelled');
  assert.equal(deletedSingle.watchMode, false);
  assert.equal(await prisma.experimentCase.count({ where: { experimentId: single.id, deletedAt: null } }), 0);

  const apiExperiment = await prisma.experiment.create({ data: { user: 'owner', name: 'delete response', status: 'running',
    cases: { create: [{ id: 'api-case-a' }, { id: 'api-case-b' }] } } });
  const { DELETE: deleteCase } = await import('../src/app/api/experiments/[id]/cases/[caseId]/route');
  const deleteByApi = async (caseId: string) => {
    const response = await deleteCase(new Request(`http://localhost/api/experiments/${apiExperiment.id}/cases/${caseId}?user=owner`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: apiExperiment.id, caseId }) });
    assert.ok(response.ok);
    return response.json();
  };
  assert.equal((await deleteByApi('api-case-a')).experimentDeleted, false);
  assert.equal((await deleteByApi('api-case-b')).experimentDeleted, true);

  const legacy = await prisma.experiment.create({ data: { user: 'owner', name: 'orphaned zero-case', status: 'running',
    cases: { create: { id: 'legacy-case', deletedAt: new Date() } } } });
  const legacyCancellation = await prisma.experimentCancellation.create({ data: { id: 'legacy-cancellation', user: 'owner',
    experimentId: legacy.id, caseKey: 'legacy-case' } });
  await reconcileCancellation(legacyCancellation.id);
  assert.ok((await prisma.experiment.findUniqueOrThrow({ where: { id: legacy.id } })).deletedAt);

  const oldClient = await prisma.reliabilityClient.create({ data: { clientId: 'old-client', user: 'owner', name: 'old client',
    lastSeenAt: new Date(), processStartedAt: new Date(Date.now() - 60_000) } });
  const unsupportedCommand = await prisma.reliabilityCommand.create({ data: { commandId: 'unsupported-cancel',
    clientId: oldClient.clientId, user: 'owner', action: 'CANCEL_EXPERIMENT_RUN', status: 'FAILED',
    errorCode: 'ACTION_NOT_ALLOWED', completedAt: new Date(), expiresAt: new Date(Date.now() + 30_000) } });
  const unsupportedExperiment = await prisma.experiment.create({ data: { user: 'owner', name: 'old client cancel',
    status: 'cancelled', deletedAt: new Date() } });
  const unsupportedCancellation = await prisma.experimentCancellation.create({ data: { id: 'unsupported-cancellation',
    user: 'owner', experimentId: unsupportedExperiment.id, caseKey: 'unsupported-case',
    targetsJson: JSON.stringify([{ kind: 'benchmark', runId: 'unsupported-run', clientId: oldClient.clientId,
      commandId: unsupportedCommand.commandId }]) } });
  const stillPending = await reconcileCancellation(unsupportedCancellation.id);
  assert.equal(stillPending.status, 'pending');
  assert.match(stillPending.error || '', /更新并重启该客户端/);
  assert.equal(await prisma.reliabilityCommand.count({ where: { clientId: oldClient.clientId } }), 1);

  const skill = await prisma.experiment.create({ data: { user: 'owner', name: 'A/B cancel', scope: 'grayscale-ab', status: 'running',
    configSnapshotJson: JSON.stringify({ caseIds: ['shared-case', 'keep-case'] }),
    cases: { create: ['a', 'b'].map((side) => ({ id: `skill-${side}`, caseValuesJson: JSON.stringify({ __agentInsightDatasetCase: { caseId: 'shared-case' } }) })) } } });
  await prisma.experimentLocalExecution.create({ data: { id: 'remote-platform-operation', experimentId: skill.id, caseKey: 'dataset:shared-case' } });
  const skillCancellation = await deleteExperimentExecution('owner', skill.id, 'dataset:shared-case');
  assert.equal((await reconcileCancellation(skillCancellation.id)).status, 'pending');
  assert.equal(await prisma.experimentCase.count({ where: { experimentId: skill.id, deletedAt: { not: null } } }), 2);
  await assert.rejects(() => assertExperimentActive(skill.id, 'dataset:shared-case'), /已取消/);
  await assertExperimentActive(skill.id, 'dataset:keep-case');
  await prisma.experimentLocalExecution.delete({ where: { id: 'remote-platform-operation' } });
  assert.equal((await reconcileCancellation(skillCancellation.id)).status, 'completed');
  await assertExperimentActive(skill.id, 'dataset:keep-case');
  const last = await deleteExperimentExecution('owner', skill.id, 'dataset:keep-case');
  await reconcileCancellation(last.id);
  const deletedSkill = await prisma.experiment.findUniqueOrThrow({ where: { id: skill.id } });
  assert.equal(deletedSkill.status, 'cancelled');
  assert.ok(deletedSkill.deletedAt);

  const uncertain = await prisma.experiment.create({ data: { user: 'owner', name: 'cleanup uncertain', cases: { create: { id: 'uncertain-case' } } } });
  await withExperimentCancellation(uncertain.id, 'uncertain-case', async () => { markExperimentCleanupUnconfirmed(); });
  const uncertainCancellation = await deleteExperimentExecution('owner', uncertain.id);
  assert.equal((await reconcileCancellation(uncertainCancellation.id)).status, 'pending');
  assert.equal(await prisma.experimentLocalExecution.count({ where: { experimentId: uncertain.id } }), 1);
});

test('executor cancellation is durable before acceptance and does not start a runner', async (t) => {
  const { createBenchmarkExecutor } = require('../services/executor/src/index.cjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-cancellation-'));
  const executor = createBenchmarkExecutor({ baseDir: directory, clientId: 'client', deviceCredential: 'secret', insightBaseUrl: 'http://127.0.0.1', runAgent: async () => { throw new Error('must not run'); } });
  t.after(async () => { await executor.close(); await fs.rm(directory, { recursive: true, force: true }); });
  assert.equal((await executor.cancel('run-cancelled')).status, 'cancelled');
  assert.ok(await executor.store.cancellation('run-cancelled'));
  await executor.recover();
  assert.equal(executor.activeRunId, null);
  assert.equal((await executor.cancel('run-cancelled')).status, 'cancelled');
});

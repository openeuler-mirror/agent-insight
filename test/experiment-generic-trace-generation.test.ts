import path from 'node:path';
import { createIsolatedDatabase } from './helpers/isolated-database';
const database = createIsolatedDatabase();

import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  assertTraceGenerationTarget,
  canReconcileGeneratedTraceAttempt,
  collectTraceGenerationCases,
  isTraceGenerationCommandTerminal,
  isTraceGenerationFailureRetryable,
  loadTraceGenerationRetryRequest,
  parseTraceIdFromCommandResult,
  reconcileGeneratedTraceCase,
} = require('@/lib/engine/experiment/trace-generation') as typeof import('@/lib/engine/experiment/trace-generation');
const { GET: getExperiment } = require('@/app/api/experiments/[id]/route') as typeof import('@/app/api/experiments/[id]/route');
const { prisma } = require('@/lib/storage/prisma') as typeof import('@/lib/storage/prisma');
test.after(async () => { await prisma.$disconnect(); database.dispose(); });

const TEST_USER = `generic-trace-${Date.now()}`;
const CLIENT_ID = `generic-client-${Date.now()}`;

test('generic trace generation collects every unbound case with a user input', async (t) => {
  t.after(async () => {
    await prisma.experiment.deleteMany({ where: { user: TEST_USER } });
  });
  const experiment = await prisma.experiment.create({
    data: {
      user: TEST_USER,
      name: 'generic generation',
      agentName: 'build',
      evaluatorIdsJson: JSON.stringify(['preset-agent-trace-quality']),
      cases: {
        create: [
          { input: 'first dataset input' },
          { input: '  second dataset input  ' },
          { input: '' },
          { input: 'already bound', executionId: 'existing-execution' },
        ],
      },
    },
  });

  const cases = await collectTraceGenerationCases(experiment.id);
  assert.deepEqual(cases.map((item) => item.input), [
    'first dataset input',
    'second dataset input',
  ]);
});

test('generic trace generation only accepts an online command-capable selected client', async (t) => {
  t.after(async () => {
    await prisma.reliabilityClient.deleteMany({ where: { clientId: CLIENT_ID } });
  });
  const capabilities = {
    platforms: [{
      id: 'opencode',
      agents: ['build'],
      runExperimentCase: { version: 2, returnsTraceId: true },
      actions: ['RUN_EXPERIMENT_CASE'],
    }],
    actions: ['RUN_EXPERIMENT_CASE'],
    faultInjection: { ready: false },
  };
  await prisma.reliabilityClient.create({
    data: {
      clientId: CLIENT_ID,
      user: TEST_USER,
      name: 'generic host',
      status: 'online',
      serviceHealth: 'healthy',
      lastSeenAt: new Date(),
      capabilitiesJson: JSON.stringify(capabilities),
    },
  });
  await assert.doesNotReject(() => assertTraceGenerationTarget({
    user: TEST_USER,
    workerId: CLIENT_ID,
    platform: 'opencode',
    agent: 'build',
  }));
  await assert.rejects(
    () => assertTraceGenerationTarget({
      user: TEST_USER,
      workerId: CLIENT_ID,
      platform: 'opencode',
      agent: 'missing-agent',
    }),
    (error: Error & { code?: string }) => error.code === 'execution_target_unavailable',
  );
  await prisma.reliabilityClient.update({
    where: { clientId: CLIENT_ID },
    data: {
      capabilitiesJson: JSON.stringify({
        ...capabilities,
        platforms: [{ id: 'opencode', agents: ['build'], actions: ['RUN_EXPERIMENT_CASE'] }],
      }),
    },
  });
  await assert.rejects(
    () => assertTraceGenerationTarget({
      user: TEST_USER,
      workerId: CLIENT_ID,
      platform: 'opencode',
      agent: 'build',
    }),
    (error: Error & { code?: string }) => error.code === 'execution_target_unavailable',
  );
});

test('generic trace binding consumes the client Trace ID and never normalizes user input', () => {
  assert.equal(
    parseTraceIdFromCommandResult(JSON.stringify({ traceId: 'ses_trace_01' })),
    'ses_trace_01',
  );
  assert.equal(
    parseTraceIdFromCommandResult(JSON.stringify({ state: 'TRACE_STARTED', traceId: 'ses_early' })),
    'ses_early',
  );
  assert.equal(parseTraceIdFromCommandResult(JSON.stringify({ state: 'AGENT_EXITED' })), null);
  assert.equal(isTraceGenerationCommandTerminal('RUNNING'), false);
  assert.equal(isTraceGenerationCommandTerminal('FAILED'), true);
  assert.equal(canReconcileGeneratedTraceAttempt('DELIVERY_FAILED'), true);
  assert.equal(canReconcileGeneratedTraceAttempt('MODEL_UNAVAILABLE'), false);
  assert.equal(isTraceGenerationFailureRetryable('TRACE_INGEST_TIMEOUT'), true);
  assert.equal(isTraceGenerationFailureRetryable('CLIENT_BUSY'), true);
  assert.equal(isTraceGenerationFailureRetryable('TRACE_ID_MISSING'), false);
  assert.equal(isTraceGenerationFailureRetryable('PLATFORM_NOT_AVAILABLE'), false);
  for (const code of [
    'AGENT_TIMEOUT',
    'MODEL_ERROR',
    'MODEL_NO_RESPONSE',
    'MODEL_START_TIMEOUT',
    'MODEL_UNAVAILABLE',
    'AGENT_EXIT_NONZERO',
    'AGENT_NO_OUTPUT',
  ]) {
    assert.equal(isTraceGenerationFailureRetryable(code), false, `${code} must not auto-retry`);
  }
});

test('experiment detail exposes a failed generic trace generation state', async (t) => {
  const user = `generic-detail-${Date.now()}`;
  t.after(async () => {
    await prisma.experiment.deleteMany({ where: { user } });
  });
  const experiment = await prisma.experiment.create({
    data: {
      user,
      name: 'generic generation detail',
      agentName: 'build',
      status: 'failed',
      evaluatorIdsJson: JSON.stringify(['preset-agent-trace-quality']),
      cases: {
        create: {
          input: 'dataset user input',
          traceGenerationCommandId: `missing-command-${Date.now()}`,
          traceGenerationError: 'trace generation timed out',
        },
      },
    },
  });

  const response = await getExperiment(
    new Request(`http://localhost/api/experiments/${experiment.id}?user=${user}`),
    { params: Promise.resolve({ id: experiment.id }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.traceProgress, { total: 1, ready: 0, failed: 1, pending: 0 });
  assert.equal(body.cases[0].input, 'dataset user input');
  assert.equal(body.cases[0].traceStatus, 'failed');
  assert.equal(body.cases[0].traceError, 'trace generation timed out');
});

test('experiment detail keeps an automatic retry in pending state', async (t) => {
  const user = `generic-retry-detail-${Date.now()}`;
  t.after(async () => {
    await prisma.experiment.deleteMany({ where: { user } });
  });
  const experiment = await prisma.experiment.create({
    data: {
      user,
      name: 'generic retry detail',
      agentName: 'build',
      status: 'running',
      evaluatorIdsJson: JSON.stringify(['preset-agent-trace-quality']),
      cases: {
        create: {
          input: 'dataset user input',
          traceGenerationError: 'previous transient failure',
        },
      },
    },
    include: { cases: true },
  });
  await prisma.experimentTraceAttempt.create({
    data: {
      experimentId: experiment.id,
      caseId: experiment.cases[0].id,
      attemptNo: 2,
      workerId: 'client-1',
      platform: 'opencode',
      agent: 'build',
      status: 'retry_wait',
      failureCode: 'CLIENT_BUSY',
      errorMessage: 'client busy',
    },
  });

  const response = await getExperiment(
    new Request(`http://localhost/api/experiments/${experiment.id}?user=${user}`),
    { params: Promise.resolve({ id: experiment.id }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.traceProgress, { total: 1, ready: 0, failed: 0, pending: 1 });
  assert.equal(body.cases[0].traceStatus, 'pending');
  assert.equal(body.cases[0].traceAttemptNo, 2);
  assert.equal(body.cases[0].traceAttemptStatus, 'retry_wait');
});

test('late long-poll command success is reconciled into the failed Attempt and Case', async (t) => {
  const stamp = Date.now();
  const user = `generic-late-command-${stamp}`;
  const clientId = `generic-late-client-${stamp}`;
  const traceId = `ses_generic_late_${stamp}`;
  t.after(async () => {
    await prisma.experiment.deleteMany({ where: { user } });
    await prisma.execution.deleteMany({ where: { user, taskId: traceId } });
    await prisma.session.deleteMany({ where: { user, taskId: traceId } });
    await prisma.reliabilityClient.deleteMany({ where: { clientId } });
  });
  await prisma.reliabilityClient.create({
    data: {
      clientId,
      user,
      name: 'late command client',
      status: 'online',
      serviceHealth: 'healthy',
      lastSeenAt: new Date(),
      capabilitiesJson: '{}',
    },
  });
  const experiment = await prisma.experiment.create({
    data: {
      user,
      name: 'late command reconciliation',
      agentName: 'build',
      status: 'failed',
      evaluatorIdsJson: '[]',
      cases: { create: { input: 'the user input', traceGenerationError: '客户端控制连接已断开' } },
    },
    include: { cases: true },
  });
  const commandId = `cmd_generic_late_${stamp}`;
  await prisma.reliabilityCommand.create({
    data: {
      commandId,
      clientId,
      user,
      action: 'RUN_EXPERIMENT_CASE',
      payloadJson: JSON.stringify({ platform: 'opencode', agent: 'build', input: 'the user input' }),
      status: 'SUCCEEDED',
      resultJson: JSON.stringify({ state: 'AGENT_EXITED', traceId }),
      expiresAt: new Date(Date.now() + 60_000),
      completedAt: new Date(),
    },
  });
  await prisma.experimentTraceAttempt.create({
    data: {
      experimentId: experiment.id,
      caseId: experiment.cases[0].id,
      attemptNo: 1,
      workerId: clientId,
      platform: 'opencode',
      agent: 'build',
      commandId,
      status: 'failed',
      failureCode: 'DELIVERY_FAILED',
      errorMessage: '客户端控制连接已断开',
    },
  });
  await prisma.session.create({
    data: {
      taskId: traceId,
      user,
      interactions: JSON.stringify([{ role: 'assistant', content: 'done' }]),
      endTime: new Date(),
    },
  });
  const execution = await prisma.execution.create({
    data: {
      id: traceId,
      taskId: traceId,
      user,
      agentName: 'build',
      query: '"the user input"',
      finalResult: 'finished',
      isSubagent: false,
    },
  });

  assert.equal(await reconcileGeneratedTraceCase({
    user,
    caseId: experiment.cases[0].id,
    minAttemptNo: 2,
  }), false, 'a new manual cycle must not bind an older Attempt');
  assert.equal(
    (await prisma.experimentCase.findUnique({ where: { id: experiment.cases[0].id } }))?.executionId,
    null,
  );
  assert.equal(await reconcileGeneratedTraceCase({ user, caseId: experiment.cases[0].id }), true);
  const [reconciledCase, reconciledAttempt] = await Promise.all([
    prisma.experimentCase.findUnique({ where: { id: experiment.cases[0].id } }),
    prisma.experimentTraceAttempt.findUnique({
      where: { caseId_attemptNo: { caseId: experiment.cases[0].id, attemptNo: 1 } },
    }),
  ]);
  assert.equal(reconciledCase?.executionId, execution.id);
  assert.equal(reconciledCase?.taskId, traceId);
  assert.equal(reconciledCase?.actualOutput, 'finished');
  assert.equal(reconciledCase?.traceGenerationError, null);
  assert.equal(reconciledAttempt?.traceId, traceId);
  assert.equal(reconciledAttempt?.status, 'ready');

  const retryRequest = await loadTraceGenerationRetryRequest({
    user,
    experimentId: experiment.id,
    caseId: experiment.cases[0].id,
  });
  assert.equal(retryRequest?.workerId, clientId);
  assert.equal(retryRequest?.cases[0]?.input, 'the user input');
});

test('experiment wizard and run route split generic generation from reliability FI', () => {
  const wizard = fs.readFileSync(
    path.join(process.cwd(), 'src/components/eval/ExperimentWizard.tsx'),
    'utf8',
  );
  const route = fs.readFileSync(
    path.join(process.cwd(), 'src/app/api/experiments/[id]/run/route.ts'),
    'utf8',
  );
  const client = fs.readFileSync(
    path.join(process.cwd(), 'scripts/reliability-client.cjs'),
    'utf8',
  );
  const generation = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/engine/experiment/trace-generation.ts'),
    'utf8',
  );
  const retryRoute = fs.readFileSync(
    path.join(process.cwd(), 'src/app/api/experiments/[id]/cases/[caseId]/retry/route.ts'),
    'utf8',
  );

  assert.doesNotMatch(wizard, /isBuiltinReliabilityDataset/);
  assert.match(wizard, /agent-datasets\?user=.*view=summary/);
  assert.match(wizard, /agent-datasets\/\$\{encodeURIComponent\(nextId\)\}.*view=items/);
  assert.match(wizard, /fiOrchestrate: isReliabilityDataset/);
  assert.match(wizard, /generationCasesFromDataset\(selectedDataset\)/);
  assert.match(wizard, /useState\(\s*String\(DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS\)/);
  assert.match(wizard, /timeoutSeconds: agentTimeoutSeconds/);
  assert.equal(route.match(/: DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS;/g)?.length, 2);
  assert.match(generation, /req\.timeoutSeconds \?\? DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS/);
  assert.match(generation, /Number\(payload\.timeoutSeconds\) \|\| DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS/);
  assert.match(route, /if \(wantGenerate && !wantFi\)/);
  assert.match(route, /generateExperimentTraces/);
  assert.match(route, /caseIds: generated\.readyCaseIds/);
  assert.match(client, /buildExperimentCaseArgs/);
  assert.match(client, /buildExperimentCaseInvocation/);
  assert.match(client, /\['run', '--format', 'json', '--agent', input\.agent\]/);
  assert.match(client, /args\.push\('--auto'\)/);
  assert.match(client, /parseOpencodeSlashCommand\(input\.input\)/);
  assert.match(client, /args\.push\('--command', slashCommand\.command\)/);
  assert.match(client, /return \{ args, stdin: input\.input \}/);
  assert.match(client, /traceId/);
  assert.match(generation, /taskId: input\.traceId/);
  assert.match(generation, /parseTraceIdFromCommandResult\(command\?\.resultJson\)/);
  assert.match(generation, /select: \{ interactions: true, endTime: true \}/);
  assert.doesNotMatch(generation, /query:\s*input\.item\.input/);
  assert.doesNotMatch(generation, /if \(!dispatched\.delivered\)/);
  assert.match(retryRoute, /generateExperimentTraces\(genericRequest, \{ forceNewTrace: true \}\)/);
  assert.match(retryRoute, /prepareGeneratedTraceRetry\(id, caseId\)/);
  assert.ok(
    retryRoute.indexOf('if (genericRequest)') < retryRoute.indexOf('const failedResults'),
    'generated Trace retry must take precedence over evaluation retry even after an Execution is bound',
  );
  assert.ok(
    retryRoute.indexOf('if (row.fiTaskId && row.fiRunId && row.faultInjectionType)')
      < retryRoute.indexOf('const failedResults'),
    'FI-generated Trace retry must take precedence over evaluation retry',
  );
  assert.doesNotMatch(retryRoute, /if \(row\.executionId\)/);
  assert.match(retryRoute, /if \(failedResults\.length\)/);
});

test('ordinary trace generation admits two attempts, refills one slot and keeps Case commands separate', async (t) => {
  const { generateExperimentTraces } = require('@/lib/engine/experiment/trace-generation') as typeof import('@/lib/engine/experiment/trace-generation');
  const user = `${TEST_USER}-parallel`;
  await prisma.reliabilityClient.create({ data: { clientId: 'parallel-client', user, name: 'parallel', lastSeenAt: new Date() } });
  t.after(async () => { await prisma.reliabilityClient.deleteMany({ where: { clientId: 'parallel-client' } }); });
  const experiment = await prisma.experiment.create({ data: { user, name: 'parallel', status: 'running', configSnapshotJson: '{"executionConcurrency":2}',
    cases: { create: [{ input: 'one' }, { input: 'two' }, { input: 'three' }] } }, include: { cases: true } });
  t.after(async () => { await prisma.experiment.deleteMany({ where: { id: experiment.id } }); await prisma.reliabilityCommand.deleteMany({ where: { user } }); });
  const controller = new AbortController();
  const work = generateExperimentTraces({ user, experimentId: experiment.id, workerId: 'parallel-client', platform: 'opencode', agent: 'build',
    executionConcurrency: 2, signal: controller.signal, cases: experiment.cases.map((row: { id: string; input: string }) => ({ caseId: row.id, input: row.input })) });
  const commands = () => prisma.reliabilityCommand.findMany({ where: { user, action: 'RUN_EXPERIMENT_CASE' }, orderBy: { createdAt: 'asc' } });
  const waitCount = async (count: number) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { const rows = await commands(); if (rows.length === count) return rows; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`expected ${count} commands`);
  };
  try {
    const first = await waitCount(2);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await commands()).length, 2);
    await prisma.reliabilityCommand.update({ where: { commandId: first[0].commandId }, data: { status: 'FAILED', errorCode: 'MODEL_ERROR' } });
    const all = await waitCount(3);
    assert.equal(new Set(all.map((row: { payloadJson: string }) => JSON.parse(row.payloadJson).correlation.caseRunId)).size, 3);
    assert.equal(await prisma.experimentTraceAttempt.count({ where: { experimentId: experiment.id, status: { in: ['dispatching', 'running', 'waiting_trace'] } } }), 2);
    await prisma.reliabilityCommand.updateMany({ where: { user }, data: { status: 'FAILED', errorCode: 'MODEL_ERROR' } });
    const result = await work;
    assert.equal(result.failedCaseIds.length, 3);
    assert.equal(await prisma.experimentTraceAttempt.count({ where: { experimentId: experiment.id } }), 3);
  } finally { controller.abort(); await work.catch(() => undefined); }
});

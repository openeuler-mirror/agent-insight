import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-benchmark-'))
process.env.DATABASE_URL = `file:${path.join(testDir, 'benchmark.db')}`
process.env.AGENT_INSIGHT_DATA_DIR = testDir

const user = `benchmark-test-${Date.now()}-${process.pid}`
const clientId = `benchmark-client-${Date.now()}-${process.pid}`
const datasetPath = process.env.SWE_BENCH_DATASET_PATH
  || path.join(os.homedir(), '.agent-insight', 'data', 'imports', 'swe-bench-verified', 'test.parquet')
const pythonPath = process.env.SWE_BENCH_PYTHON
  || path.join(
    os.homedir(),
    '.agent-insight',
    'vendor',
    'SWE-bench',
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
const bridgePath = path.resolve('scripts/benchmark/load_official_swebench_dataset.py')
const missingOfficialPrerequisite = [datasetPath, pythonPath, bridgePath]
  .find((item) => !fs.existsSync(item))

let prisma: typeof import('@/lib/storage/prisma').prisma
let importBenchmarkDataset: typeof import('@/lib/benchmark/dataset-service').importBenchmarkDataset
let importOfficialSweBenchVerifiedDataset:
  typeof import('../benchmarks/swe-bench/dataset').importOfficialSweBenchVerifiedDataset
let createExperiment: typeof import('@/app/api/experiments/route').POST
let runExperiment: typeof import('@/app/api/experiments/[id]/run/route').POST
let listExecutionTargets: typeof import('@/app/api/benchmark/v1/execution-targets/route').GET
let setCommandDispatcher: typeof import('@/lib/benchmark/scheduler').setBenchmarkCommandDispatcherForTest
let resumeDispatches: typeof import('@/lib/benchmark/scheduler').resumeBenchmarkDispatchesAtStartup
let reapStaleRuns: typeof import('@/lib/benchmark/scheduler').reapStaleBenchmarkRuns

test.before(async () => {
  const sqliteModule = 'node:sqlite'
  const { DatabaseSync } = await import(sqliteModule) as {
    DatabaseSync: new (filename: string) => { exec(sql: string): void; close(): void }
  }
  const database = new DatabaseSync(path.join(testDir, 'benchmark.db'))
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE AgentEvalDataset (
      id TEXT PRIMARY KEY, user TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      targetAgent TEXT NOT NULL DEFAULT '', targetSkill TEXT NOT NULL DEFAULT '', tagsJson TEXT NOT NULL DEFAULT '[]',
      fieldsJson TEXT NOT NULL DEFAULT '[]', casesJson TEXT NOT NULL DEFAULT '[]', caseCount INTEGER NOT NULL DEFAULT 0,
      referenceCasesJson TEXT NOT NULL DEFAULT '[]', projectionReady INTEGER NOT NULL DEFAULT 0,
      datasetKind TEXT NOT NULL DEFAULT 'ideal_output', createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE Experiment (
      id TEXT PRIMARY KEY, user TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'single',
      agentName TEXT NOT NULL DEFAULT '', evaluatorIdsJson TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft',
      scope TEXT NOT NULL DEFAULT '', skillName TEXT NOT NULL DEFAULT '', skillVersion INTEGER, preset TEXT,
      skillContextJson TEXT, configSnapshotJson TEXT, sourceExperimentId TEXT, optimizationRecordId TEXT,
      watchMode INTEGER NOT NULL DEFAULT 0, watchEnabledAt DATETIME, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ExperimentCase (
      id TEXT PRIMARY KEY, experimentId TEXT NOT NULL, executionId TEXT, taskId TEXT, input TEXT NOT NULL DEFAULT '',
      datasetInput TEXT, actualOutput TEXT NOT NULL DEFAULT '', referenceOutput TEXT, evaluatorContextJson TEXT,
      groupId TEXT, faultInjectionType TEXT, caseValuesJson TEXT, fiTaskId TEXT, fiRunId TEXT,
      traceGenerationCommandId TEXT, traceGenerationError TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (experimentId) REFERENCES Experiment(id) ON DELETE CASCADE
    );
    CREATE TABLE ReliabilityClient (
      id TEXT PRIMARY KEY, clientId TEXT NOT NULL UNIQUE, user TEXT NOT NULL, name TEXT NOT NULL, hostname TEXT,
      reportedIp TEXT, observedIp TEXT, os TEXT, arch TEXT, status TEXT NOT NULL DEFAULT 'offline',
      serviceHealth TEXT NOT NULL DEFAULT 'unknown', supervisor TEXT, processStartedAt DATETIME,
      restartCount INTEGER NOT NULL DEFAULT 0, lastSeenAt DATETIME NOT NULL, agentVersion TEXT,
      capabilitiesJson TEXT NOT NULL DEFAULT '{}', capabilitiesRevision TEXT, unboundAt DATETIME,
      unboundToClientId TEXT, machineId TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ReliabilityClientCredential (
      id TEXT PRIMARY KEY, clientId TEXT NOT NULL, credentialHash TEXT NOT NULL UNIQUE,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, lastUsedAt DATETIME, revokedAt DATETIME,
      FOREIGN KEY (clientId) REFERENCES ReliabilityClient(clientId) ON DELETE CASCADE
    );
    CREATE TABLE BenchmarkDataset (
      id TEXT PRIMARY KEY, agentEvalDatasetId TEXT NOT NULL UNIQUE, user TEXT NOT NULL, name TEXT NOT NULL,
      adapterKey TEXT NOT NULL, contentHash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
      caseCount INTEGER NOT NULL DEFAULT 0, sourceJson TEXT NOT NULL DEFAULT '{}',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agentEvalDatasetId) REFERENCES AgentEvalDataset(id) ON DELETE CASCADE,
      UNIQUE (user, name)
    );
    CREATE TABLE BenchmarkDatasetCase (
      id TEXT PRIMARY KEY, datasetId TEXT NOT NULL, externalCaseId TEXT NOT NULL, rawCaseJson TEXT NOT NULL,
      publicPayloadJson TEXT NOT NULL, privatePayloadJson TEXT NOT NULL, sourceFingerprint TEXT NOT NULL,
      publicFingerprint TEXT NOT NULL, privateFingerprint TEXT NOT NULL, ordinal INTEGER NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (datasetId) REFERENCES BenchmarkDataset(id) ON DELETE CASCADE,
      UNIQUE (datasetId, externalCaseId), UNIQUE (datasetId, ordinal)
    );
    CREATE TABLE BenchmarkExperimentBinding (
      experimentId TEXT PRIMARY KEY, datasetId TEXT NOT NULL, datasetContentHash TEXT NOT NULL, adapterKey TEXT NOT NULL,
      selectionJson TEXT NOT NULL, runConfigJson TEXT NOT NULL, schedulerStatus TEXT NOT NULL DEFAULT 'idle',
      expectedCaseCount INTEGER NOT NULL, callbackOrigin TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (experimentId) REFERENCES Experiment(id) ON DELETE CASCADE,
      FOREIGN KEY (datasetId) REFERENCES BenchmarkDataset(id)
    );
    CREATE TABLE BenchmarkCaseRun (
      id TEXT PRIMARY KEY, experimentId TEXT NOT NULL, experimentCaseId TEXT NOT NULL, datasetCaseId TEXT,
      ordinal INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', adapterKey TEXT NOT NULL, clientId TEXT NOT NULL,
      publicPayloadJson TEXT, privatePayloadJson TEXT, taskEnvelopeJson TEXT,
      taskDigest TEXT, progressJson TEXT, runFactsJson TEXT, cleanupJson TEXT, completionDigest TEXT,
      failureCode TEXT, failureMessage TEXT, retryOfRunId TEXT, lastProgressAt DATETIME,
      startedAt DATETIME, finishedAt DATETIME, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (experimentId) REFERENCES Experiment(id) ON DELETE CASCADE,
      FOREIGN KEY (experimentCaseId) REFERENCES ExperimentCase(id) ON DELETE CASCADE,
      FOREIGN KEY (datasetCaseId) REFERENCES BenchmarkDatasetCase(id) ON DELETE SET NULL
    );
    CREATE TABLE BenchmarkArtifact (
      id TEXT PRIMARY KEY, runId TEXT NOT NULL, name TEXT NOT NULL, mediaType TEXT NOT NULL,
      sha256 TEXT NOT NULL, sizeBytes INTEGER NOT NULL, storagePath TEXT NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES BenchmarkCaseRun(id) ON DELETE CASCADE,
      UNIQUE (runId, name)
    );
    CREATE TABLE BenchmarkDispatchOutbox (
      id TEXT PRIMARY KEY, runId TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'agent_execution',
      commandId TEXT UNIQUE, requestJson TEXT NOT NULL, requestDigest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attemptCount INTEGER NOT NULL DEFAULT 0,
      nextAttemptAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, leasedUntil DATETIME,
      responseJson TEXT, errorCode TEXT, errorMessage TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES BenchmarkCaseRun(id) ON DELETE CASCADE
    );
  `)
  database.close()
  const [
    storage,
    datasetService,
    officialDataset,
    experimentRoute,
    runRoute,
    executionTargetsRoute,
    scheduler,
  ] = await Promise.all([
    import('@/lib/storage/prisma'),
    import('@/lib/benchmark/dataset-service'),
    import('../benchmarks/swe-bench/dataset'),
    import('@/app/api/experiments/route'),
    import('@/app/api/experiments/[id]/run/route'),
    import('@/app/api/benchmark/v1/execution-targets/route'),
    import('@/lib/benchmark/scheduler'),
  ])
  prisma = storage.prisma
  importBenchmarkDataset = datasetService.importBenchmarkDataset
  importOfficialSweBenchVerifiedDataset = officialDataset.importOfficialSweBenchVerifiedDataset
  createExperiment = experimentRoute.POST
  runExperiment = runRoute.POST
  listExecutionTargets = executionTargetsRoute.GET
  setCommandDispatcher = scheduler.setBenchmarkCommandDispatcherForTest
  resumeDispatches = scheduler.resumeBenchmarkDispatchesAtStartup
  reapStaleRuns = scheduler.reapStaleBenchmarkRuns
})

test.after(async () => {
  setCommandDispatcher?.()
  delete process.env.AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL
  delete process.env.AGENT_INSIGHT_DATA_DIR
  await prisma?.$disconnect()
  fs.rmSync(testDir, { recursive: true, force: true })
})

async function waitForAcceptedRun(experimentId: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const run = await prisma.benchmarkCaseRun.findFirst({ where: { experimentId } })
    if (run?.status === 'running_agent') return run
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('benchmark run was not accepted in time')
}

async function waitForRunStatus(experimentId: string, status: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const run = await prisma.benchmarkCaseRun.findFirst({ where: { experimentId } })
    if (run?.status === status) return run
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`benchmark run did not reach ${status} in time`)
}

function hasForbiddenEvaluatorKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenEvaluatorKey)
  if (!value || typeof value !== 'object') return false
  const forbidden = new Set([
    'patch',
    'test_patch',
    'FAIL_TO_PASS',
    'PASS_TO_PASS',
    'environment_setup_commit',
    'image',
    'eval_script',
    'eval_type',
    'log_parser',
    'goldPatch',
    'testPatch',
    'failToPass',
    'passToPass',
    'environmentSetupCommit',
    'evaluation',
  ])
  return Object.entries(value).some(
    ([key, item]) => forbidden.has(key) || hasForbiddenEvaluatorKey(item),
  )
}

test('benchmark first phase imports, freezes, builds and dispatches one SWE-bench task', async () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve('benchmarks/swe-bench/fixtures/smoke-case.json'), 'utf8'),
  )
  const imported = await importBenchmarkDataset({
    user,
    name: 'synthetic SWE-bench smoke',
    adapterKey: 'swe-bench',
    source: { kind: 'synthetic-test-fixture' },
    cases: [fixture],
  })
  const repeated = await importBenchmarkDataset({
    user,
    name: 'synthetic SWE-bench smoke',
    adapterKey: 'swe-bench',
    source: { kind: 'synthetic-test-fixture' },
    cases: [fixture],
  })
  assert.equal(repeated.id, imported.id)
  assert.equal(repeated.reused, true)

  const dataset = await prisma.benchmarkDataset.findUnique({
    where: { id: imported.id },
    include: { cases: true },
  })
  assert.ok(dataset)
  assert.equal(dataset.cases.length, 1)
  assert.equal(dataset.cases[0].publicPayloadJson.includes('hidden answer'), false)
  assert.equal(dataset.cases[0].privatePayloadJson.includes('hidden answer'), true)

  await prisma.reliabilityClient.create({
    data: {
      clientId,
      user,
      name: 'benchmark executor',
      status: 'online',
      serviceHealth: 'healthy',
      lastSeenAt: new Date(),
      capabilitiesJson: JSON.stringify({
        platforms: [{
          id: 'codex',
          agents: ['review'],
          models: ['gpt-5.3-codex'],
          runExperimentCase: { version: 2, returnsTraceId: true },
          actions: ['RUN_EXPERIMENT_CASE', 'RUN_BENCHMARK_CASE'],
        }],
        components: {
          'git-workspace/v1': { ready: true },
          'agent-runtime/codex/v1': { ready: true },
          'git-patch/v1': { ready: true },
        },
      }),
    },
  })
  await prisma.reliabilityClientCredential.create({
    data: {
      clientId,
      credentialHash: createHash('sha256').update('benchmark-test-device').digest('hex'),
    },
  })

  const missingDatasetResponse = await listExecutionTargets(new Request(
    `http://insight.test/api/benchmark/v1/execution-targets?user=${encodeURIComponent(user)}`,
  ))
  assert.equal(missingDatasetResponse.status, 400)
  assert.equal((await missingDatasetResponse.json()).error.code, 'BENCHMARK_DATASET_REQUIRED')

  const targetsResponse = await listExecutionTargets(new Request(
    `http://insight.test/api/benchmark/v1/execution-targets?user=${encodeURIComponent(user)}&datasetId=${encodeURIComponent(imported.id)}`,
  ))
  assert.equal(targetsResponse.status, 200)
  const targetsBody = await targetsResponse.json() as {
    items: Array<{ clientId: string; platform: string; agents: string[]; models: string[]; ready: boolean }>
  }
  assert.deepEqual(targetsBody.items.map(item => ({
    clientId: item.clientId,
    platform: item.platform,
    agents: item.agents,
    models: item.models,
    ready: item.ready,
  })), [{
    clientId,
    platform: 'codex',
    agents: ['review'],
    models: ['gpt-5.3-codex'],
    ready: true,
  }])

  const unavailableTargetResponse = await createExperiment(new Request('http://insight.test/api/experiments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user,
      scope: 'benchmark',
      name: 'unreported agent',
      benchmark: {
        datasetId: imported.id,
        caseSelection: { mode: 'explicit', caseIds: [dataset.cases[0].id] },
        executionTarget: { clientId },
        runConfig: { platform: 'codex', agent: 'build' },
      },
    }),
  }))
  assert.equal(unavailableTargetResponse.status, 409)
  assert.equal(
    ((await unavailableTargetResponse.json()) as { error: { code: string } }).error.code,
    'EXECUTION_TARGET_UNAVAILABLE',
  )

  const createResponse = await createExperiment(new Request('http://insight.test/api/experiments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user,
      scope: 'benchmark',
      name: 'SWE-bench smoke',
      agentName: 'codex / review',
      benchmark: {
        datasetId: imported.id,
        caseSelection: { mode: 'explicit', caseIds: [dataset.cases[0].id] },
        executionTarget: { clientId },
        runConfig: {
          platform: 'codex',
          agent: 'review',
          model: 'configured-default',
          agentTimeoutSeconds: 60,
          maxParallelAgentCases: 1,
        },
      },
    }),
  }))
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json() as { id: string; caseCount: number }
  assert.equal(created.caseCount, 1)

  const frozen = await prisma.benchmarkCaseRun.findFirst({ where: { experimentId: created.id } })
  assert.equal(frozen?.status, 'pending')
  assert.equal(frozen?.taskEnvelopeJson, null)

  const calls: Array<{ user: string; clientId: string; request: Record<string, unknown> }> = []
  setCommandDispatcher(async (input) => {
    calls.push(input)
    if (calls.length === 1) throw new Error('synthetic connection reset')
    if (calls.length === 2) {
      return {
        commandId: 'cmd_busy',
        status: 'busy',
        code: 'CLIENT_BUSY',
        message: 'client busy',
      }
    }
    return {
      commandId: `cmd_accepted_${calls.length}`,
      status: 'accepted',
      receipt: { runId: input.request.runId },
    }
  })

  process.env.AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL = 'http://127.0.0.1:3000'
  const runResponse = await runExperiment(
    new Request(`http://insight.test/api/experiments/${created.id}/run?user=${encodeURIComponent(user)}`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ id: created.id }) },
  )
  delete process.env.AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL
  assert.equal(runResponse.status, 202)
  const runResponseBody = await runResponse.json() as { runId: string }
  const acceptedRun = await waitForAcceptedRun(created.id)
  assert.equal(acceptedRun.id, runResponseBody.runId)
  assert.equal(calls.length, 3)
  assert.equal(calls[0].clientId, clientId)
  assert.equal(calls[0].user, user)
  assert.deepEqual(calls[0].request, calls[1].request)
  assert.deepEqual(calls[2].request, calls[1].request)
  assert.equal(JSON.stringify(calls[2].request).includes('hidden answer'), false)
  assert.equal(JSON.stringify(calls[2].request).includes('hidden test'), false)

  const dispatched = calls[2].request as {
    callbackBaseUrl: string
    task: {
      context: { runId: string }
      agentConfig: { platform: string; agent: string }
      task: { benchmarkPayload: Record<string, unknown> }
    }
  }
  assert.equal(
    dispatched.callbackBaseUrl,
    `http://127.0.0.1:3000/api/benchmark/v1/runs/${encodeURIComponent(acceptedRun.id)}`,
  )
  assert.equal(dispatched.task.context.runId, acceptedRun.id)
  assert.deepEqual(dispatched.task.agentConfig, {
    platform: 'codex',
    agent: 'review',
    model: 'configured-default',
    timeoutSeconds: 60,
  })
  assert.equal(dispatched.task.task.benchmarkPayload.instanceId, 'example__project-1')
  const outbox = await prisma.benchmarkDispatchOutbox.findUnique({ where: { runId: acceptedRun.id } })
  assert.equal(outbox?.status, 'accepted')
  assert.equal(outbox?.attemptCount, 3)
  assert.equal(outbox?.commandId, 'cmd_accepted_3')
  const binding = await prisma.benchmarkExperimentBinding.findUnique({
    where: { experimentId: created.id },
  })
  assert.equal(binding?.callbackOrigin, 'http://insight.test')

  await prisma.$transaction([
    prisma.benchmarkDispatchOutbox.update({
      where: { runId: acceptedRun.id },
      data: { status: 'unknown', attemptCount: 1, nextAttemptAt: new Date() },
    }),
    prisma.benchmarkCaseRun.update({
      where: { id: acceptedRun.id },
      data: { status: 'dispatch_unknown' },
    }),
  ])
  assert.equal(await resumeDispatches(), 1)
  await waitForAcceptedRun(created.id)
  const resumedOutbox = await prisma.benchmarkDispatchOutbox.findUnique({
    where: { runId: acceptedRun.id },
  })
  assert.equal(resumedOutbox?.status, 'accepted')
  assert.equal(resumedOutbox?.attemptCount, 2)
  assert.equal(calls.length, 4)
  assert.deepEqual(calls[3].request, calls[2].request)

  await assert.rejects(
    () => importBenchmarkDataset({
      user,
      name: 'synthetic SWE-bench smoke',
      adapterKey: 'swe-bench',
      cases: [{ ...fixture, problem_statement: 'silently replaced task' }],
    }),
    (error: Error & { code?: string }) => error.code === 'DATASET_IN_USE',
  )

  await prisma.reliabilityClient.update({
    where: { clientId },
    data: {
      capabilitiesJson: JSON.stringify({
        platforms: [{
          id: 'codex',
          agents: ['review'],
          runExperimentCase: { version: 2, returnsTraceId: true },
          actions: ['RUN_EXPERIMENT_CASE', 'RUN_BENCHMARK_CASE'],
        }],
        components: { 'git-workspace/v1': { ready: true } },
      }),
    },
  })
  const missingCapabilityResponse = await createExperiment(new Request('http://insight.test/api/experiments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user,
      scope: 'benchmark',
      name: 'missing capabilities',
      benchmark: {
        datasetId: imported.id,
        executionTarget: { clientId },
        runConfig: { platform: 'codex', agent: 'review' },
      },
    }),
  }))
  assert.equal(missingCapabilityResponse.status, 409)
  const missingCapabilityBody = await missingCapabilityResponse.json() as {
    error: { code: string }
  }
  assert.equal(missingCapabilityBody.error.code, 'EXECUTOR_CAPABILITY_MISSING')
})

test('watchdog settles a stale running Agent task once', async () => {
  const suffix = `${Date.now()}_${process.pid}`
  const experimentId = `exp_stale_${suffix}`
  const caseId = `case_stale_${suffix}`
  const runId = `erun_stale_${suffix}`
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve('benchmarks/swe-bench/fixtures/smoke-case.json'), 'utf8'),
  )
  const dataset = await importBenchmarkDataset({
    user,
    name: `stale watchdog dataset ${suffix}`,
    adapterKey: 'swe-bench',
    source: { kind: 'synthetic-test-fixture' },
    cases: [fixture],
  })
  const now = new Date('2026-09-10T03:00:00.000Z')
  const staleAt = new Date(now.getTime() - 61_000)

  await prisma.experiment.create({
    data: {
      id: experimentId,
      user,
      name: 'stale watchdog fixture',
      scope: 'benchmark',
      status: 'running',
      evaluatorIdsJson: '[]',
    },
  })
  await prisma.experimentCase.create({
    data: { id: caseId, experimentId, input: 'stale task' },
  })
  await prisma.benchmarkExperimentBinding.create({
    data: {
      experimentId,
      datasetId: dataset.id,
      datasetContentHash: dataset.contentHash,
      adapterKey: 'swe-bench',
      selectionJson: '{}',
      runConfigJson: '{"timeoutSeconds":60}',
      schedulerStatus: 'running',
      expectedCaseCount: 1,
      callbackOrigin: 'http://insight.test',
    },
  })
  await prisma.benchmarkCaseRun.create({
    data: {
      id: runId,
      experimentId,
      experimentCaseId: caseId,
      ordinal: 0,
      status: 'running_agent',
      adapterKey: 'swe-bench',
      clientId,
      startedAt: staleAt,
      lastProgressAt: staleAt,
      progressJson: '{"kind":"execution","stage":"preparing"}',
    },
  })
  await prisma.benchmarkDispatchOutbox.create({
    data: {
      runId,
      requestJson: '{"timeoutSeconds":60}',
      requestDigest: `sha256:${'e'.repeat(64)}`,
      status: 'accepted',
    },
  })

  assert.equal(await reapStaleRuns({ now, graceMs: 0, experimentId }), 0)
  await prisma.benchmarkCaseRun.update({
    where: { id: runId },
    data: { progressJson: '{"kind":"execution","stage":"agent_running"}' },
  })
  assert.equal(await reapStaleRuns({ now, graceMs: 0, experimentId }), 1)
  assert.equal(await reapStaleRuns({ now, graceMs: 0, experimentId }), 0)
  const [run, experiment, binding] = await Promise.all([
    prisma.benchmarkCaseRun.findUnique({ where: { id: runId } }),
    prisma.experiment.findUnique({ where: { id: experimentId } }),
    prisma.benchmarkExperimentBinding.findUnique({ where: { experimentId } }),
  ])
  assert.equal(run?.status, 'execution_failed')
  assert.equal(run?.failureCode, 'BENCHMARK_RUN_STALE_TIMEOUT')
  assert.equal(experiment?.status, 'failed')
  assert.equal(binding?.schedulerStatus, 'failed')
})

test('real SWE-bench Verified data crosses create/run APIs and the client command boundary', {
  skip: missingOfficialPrerequisite
    ? `missing external prerequisite: ${missingOfficialPrerequisite}`
    : false,
  timeout: 180_000,
}, async () => {
  const officialUser = `${user}-official`
  const officialClientId = `${clientId}-official`
  const imported = await importOfficialSweBenchVerifiedDataset({
    user: officialUser,
    name: 'official SWE-bench Verified API flow',
    datasetPath,
    pythonPath,
  })
  assert.equal(imported.caseCount, 500)

  const dataset = await prisma.benchmarkDataset.findUnique({
    where: { id: imported.id },
    include: { cases: { orderBy: { ordinal: 'asc' }, take: 1 } },
  })
  assert.ok(dataset)
  assert.equal(dataset.caseCount, 500)
  const firstCase = dataset.cases[0]
  assert.ok(firstCase)

  await prisma.reliabilityClient.create({
    data: {
      clientId: officialClientId,
      user: officialUser,
      name: 'official dataset executor',
      status: 'online',
      serviceHealth: 'healthy',
      lastSeenAt: new Date(),
      capabilitiesJson: JSON.stringify({
        platforms: [{
          id: 'opencode',
          agents: ['build'],
          models: ['configured-default'],
          runExperimentCase: { version: 2, returnsTraceId: true },
          actions: ['RUN_EXPERIMENT_CASE', 'RUN_BENCHMARK_CASE'],
        }],
        components: {
          'git-workspace/v1': { ready: true },
          'agent-runtime/opencode/v1': { ready: true },
          'git-patch/v1': { ready: true },
        },
      }),
    },
  })
  await prisma.reliabilityClientCredential.create({
    data: {
      clientId: officialClientId,
      credentialHash: createHash('sha256').update('benchmark-official-device').digest('hex'),
    },
  })

  const createResponse = await createExperiment(new Request('http://insight.test/api/experiments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: officialUser,
      scope: 'benchmark',
      name: 'SWE-bench Verified real API flow',
      agentName: 'opencode',
      benchmark: {
        datasetId: imported.id,
        caseSelection: { mode: 'all' },
        executionTarget: { clientId: officialClientId },
        runConfig: {
          platform: 'opencode',
          agent: 'build',
          model: 'configured-default',
          agentTimeoutSeconds: 60,
          maxParallelAgentCases: 1,
        },
      },
    }),
  }))
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json() as { id: string; caseCount: number }
  assert.equal(created.caseCount, 500)
  assert.equal(await prisma.experimentCase.count({ where: { experimentId: created.id } }), 500)
  assert.equal(await prisma.benchmarkCaseRun.count({
    where: { experimentId: created.id, status: 'pending' },
  }), 500)

  const calls: Array<{ user: string; clientId: string; request: Record<string, unknown> }> = []
  setCommandDispatcher(async (input) => {
    calls.push(input)
    return {
      commandId: `cmd_official_${calls.length}`,
      status: 'accepted',
      receipt: { runId: input.request.runId },
    }
  })

  const runResponse = await runExperiment(
    new Request(
      `http://insight.test/api/experiments/${created.id}/run?user=${encodeURIComponent(officialUser)}`,
      { method: 'POST' },
    ),
    { params: Promise.resolve({ id: created.id }) },
  )
  assert.equal(runResponse.status, 202)
  const runResponseBody = await runResponse.json() as { runId: string }
  const acceptedRun = await waitForAcceptedRun(created.id)
  assert.equal(acceptedRun.id, runResponseBody.runId)
  assert.equal(calls.length, 1)

  const outbound = calls[0].request as {
    runId: string
    requestDigest: string
    task: {
      context: { runId: string }
      task: { benchmarkPayload: { instanceId: string } }
    }
  }
  assert.equal(outbound.runId, acceptedRun.id)
  assert.equal(outbound.task.context.runId, acceptedRun.id)
  assert.equal(outbound.task.task.benchmarkPayload.instanceId, firstCase.externalCaseId)
  assert.equal(hasForbiddenEvaluatorKey(outbound), false)
  assert.equal(await prisma.benchmarkCaseRun.count({
    where: { experimentId: created.id, status: 'running_agent' },
  }), 1)
  assert.equal(await prisma.benchmarkCaseRun.count({
    where: { experimentId: created.id, status: 'pending' },
  }), 499)

  const rejectedCreateResponse = await createExperiment(new Request('http://insight.test/api/experiments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: officialUser,
      scope: 'benchmark',
      name: 'SWE-bench executor rejection',
      benchmark: {
        datasetId: imported.id,
        caseSelection: { mode: 'explicit', caseIds: [firstCase.id] },
        executionTarget: { clientId: officialClientId },
        runConfig: { platform: 'opencode', agent: 'build', maxParallelAgentCases: 1 },
      },
    }),
  }))
  assert.equal(rejectedCreateResponse.status, 201)
  const rejectedExperiment = await rejectedCreateResponse.json() as { id: string }
  setCommandDispatcher(async () => ({
    commandId: 'cmd_rejected',
    status: 'rejected',
    code: 'TASK_REJECTED',
    message: 'task rejected',
  }))
  const rejectedRunResponse = await runExperiment(
    new Request(
      `http://insight.test/api/experiments/${rejectedExperiment.id}/run?user=${encodeURIComponent(officialUser)}`,
      { method: 'POST' },
    ),
    { params: Promise.resolve({ id: rejectedExperiment.id }) },
  )
  assert.equal(rejectedRunResponse.status, 202)
  const rejectedRun = await waitForRunStatus(rejectedExperiment.id, 'dispatch_failed')
  assert.equal(rejectedRun.failureCode, 'TASK_REJECTED')
  const rejectedOutbox = await prisma.benchmarkDispatchOutbox.findUnique({
    where: { runId: rejectedRun.id },
  })
  assert.equal(rejectedOutbox?.commandId, 'cmd_rejected')
  assert.equal(rejectedOutbox?.status, 'failed')
  setCommandDispatcher()
})

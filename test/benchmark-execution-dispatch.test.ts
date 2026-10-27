import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-benchmark-'))
process.env.DATABASE_URL = `file:${path.join(testDir, 'benchmark.db')}`
process.env.AGENT_INSIGHT_HOME = testDir
fs.closeSync(fs.openSync(path.join(testDir, 'benchmark.db'), 'a'))

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
  const schema = spawnSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push',
    '--schema', path.resolve('prisma/schema.prisma'), '--skip-generate'], { env: process.env, encoding: 'utf8', timeout: 30000 })
  assert.equal(schema.status, 0, schema.stderr)
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
  delete process.env.AGENT_INSIGHT_HOME
  await prisma?.$disconnect()
  fs.rmSync(testDir, { recursive: true, force: true })
})

async function waitForAcceptedRun(experimentId: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const run = await prisma.benchmarkCaseRun.findFirst({ where: { experimentId, status: 'running_agent' } })
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
    executionConcurrency: 1,
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

test('xGovernor experiment APIs freeze the confirmed environment and keep native model choices independent', async () => {
  const { describeProfile, normalizeExecutionConfig } = require('../packages/benchmark-protocol/execution.cjs')
  const config = normalizeExecutionConfig({ profiles: { 'xgovernor-local-docker': {
    sourceRevision: 'a'.repeat(40),
    runtimes: { 'pi-agent': { kind: 'pi', namespace: 'runtime_pi', agents: ['pi-agent'] } },
    models: { 'sandbox/model': { provider: 'sandbox', model: 'model', apiKeyEnv: 'FIXTURE_KEY' } },
  } } })
  const profile = describeProfile('xgovernor-local-docker', config.profiles['xgovernor-local-docker'])
  const sandboxClient = `${clientId}-sandbox`
  const capabilities = {
    platforms: [{ id: 'pi-agent', agents: ['pi-agent'], models: ['native/model'], actions: ['RUN_EXPERIMENT_CASE', 'RUN_BENCHMARK_CASE'], runExperimentCase: { version: 2, returnsTraceId: true }, runBenchmarkCase: { version: 1, returnsTraceId: true } }],
    components: { 'execution-backend/v1': { ready: true }, 'agent-runtime/pi-agent/v1': { ready: true }, 'git-workspace/v1': { ready: true }, 'git-patch/v1': { ready: true } },
    executionProfiles: [{ profile, benchmarks: ['swe-bench'], ready: true, note: '' }],
  }
  await prisma.reliabilityClient.create({ data: { clientId: sandboxClient, user, name: 'sandbox fixture', arch: 'x64', status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), capabilitiesJson: JSON.stringify(capabilities) } })
  const imported = await importBenchmarkDataset({ user, name: 'sandbox API fixture', adapterKey: 'swe-bench', source: { kind: 'synthetic-test-fixture' }, cases: [JSON.parse(fs.readFileSync(path.resolve('benchmarks/swe-bench/fixtures/smoke-case.json'), 'utf8'))] })
  const { GET: listAgents } = await import('@/app/api/experiments/agents/route')
  const candidates = await (await listAgents(new Request(`http://insight.test/api/experiments/agents?user=${encodeURIComponent(user)}`))).json()
  const target = candidates.agents.flatMap((agent: any) => agent.targets).find((item: any) => item.workerId === sandboxClient)
  assert.deepEqual(target.models.map((item: any) => item.id), ['', 'native/model'])
  assert.deepEqual(target.benchmarkEnvironments['swe-bench'].models.map((item: any) => item.id), ['', 'sandbox/model'])
  assert.equal(target.benchmarkEnvironments['swe-bench'].profile.definitionDigest, profile.definitionDigest)
  const create = (executionProfileDigest: string) => createExperiment(new Request('http://insight.test/api/experiments', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user, scope: 'benchmark', name: 'confirmed environment', benchmark: {
      datasetId: imported.id, caseSelection: { mode: 'all' }, executionTarget: { clientId: sandboxClient }, runConfig: { platform: 'pi-agent', agent: 'pi-agent', model: 'sandbox/model', executionProfileDigest },
    } }),
  }))
  const changed = await create(`sha256:${'0'.repeat(64)}`)
  assert.equal(changed.status, 409)
  assert.equal((await changed.json()).error.code, 'EXECUTION_PROFILE_CHANGED')
  const created = await create(profile.definitionDigest)
  assert.equal(created.status, 201)
  const binding = await prisma.benchmarkExperimentBinding.findUniqueOrThrow({ where: { experimentId: (await created.json()).id } })
  const frozen = JSON.parse(binding.runConfigJson)
  assert.equal(frozen.executionProfile.definitionDigest, profile.definitionDigest)
  assert.equal(frozen.executionArch, 'amd64')
  const run = await prisma.benchmarkCaseRun.findFirstOrThrow({ where: { experimentId: binding.experimentId } })
  const { getBenchmarkAdapter } = await import('@/lib/benchmark/adapter-registry')
  const { prepareBenchmarkEvaluation } = await import('@/lib/benchmark/evaluation-preparation-service')
  const adapter = getBenchmarkAdapter('swe-bench')
  const split = adapter.validateAndSplitCase(JSON.parse(fs.readFileSync(path.resolve('benchmarks/swe-bench/fixtures/smoke-case.json'), 'utf8')))
  const task = adapter.buildAgentTask({ publicPayload: split.publicPayload, context: { runId: run.id, experimentId: binding.experimentId, caseId: run.experimentCaseId }, runConfig: frozen })
  const bytes = Buffer.from('diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n')
  fs.mkdirSync(path.join(testDir, 'data', 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(testDir, 'data', 'artifacts', 'frozen-image.patch'), bytes)
  await prisma.benchmarkArtifact.create({ data: { id: 'artifact_frozen_image', runId: run.id, name: 'model.patch', mediaType: 'text/x-diff', sizeBytes: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, storagePath: 'artifacts/frozen-image.patch' } })
  const privatePayload = split.privatePayload as Record<string, unknown>
  const evaluationImage = 'swr.example.test/benchmark/case:latest'
  await prisma.benchmarkCaseRun.update({ where: { id: run.id }, data: { status: 'submitted', taskEnvelopeJson: JSON.stringify(task), runFactsJson: '{}', privatePayloadJson: JSON.stringify({ ...privatePayload, evaluation: { image: evaluationImage, script: 'pytest', type: 'pytest', logParser: 'pytest' } }) } })
  await prisma.benchmarkExperimentBinding.update({ where: { experimentId: binding.experimentId }, data: { callbackOrigin: 'http://insight.test' } })
  const prepared = await prepareBenchmarkEvaluation(run.id)
  const evaluation = await prisma.benchmarkEvaluation.findUniqueOrThrow({ where: { id: prepared.evaluationRunId } })
  assert.equal(JSON.parse(evaluation.requestJson).payload.executionImage, undefined)
  assert.equal(JSON.parse(evaluation.requestJson).payload.instance.image, evaluationImage)
  const retry = await prepareBenchmarkEvaluation(run.id, { forceNewAttempt: true, retryOfEvaluationId: evaluation.id })
  const retried = await prisma.benchmarkEvaluation.findUniqueOrThrow({ where: { id: retry.evaluationRunId } })
  assert.equal(JSON.parse(retried.requestJson).payload.executionImage, undefined)
  assert.equal(JSON.parse(retried.requestJson).payload.instance.image, evaluationImage)
  capabilities.executionProfiles[0].ready = false
  capabilities.executionProfiles[0].note = 'Docker 未就绪'
  await prisma.reliabilityClient.update({ where: { clientId: sandboxClient }, data: { capabilitiesJson: JSON.stringify(capabilities) } })
  const unavailable = await create(profile.definitionDigest)
  assert.equal(unavailable.status, 409)
  assert.equal((await unavailable.json()).error.code, 'EXECUTOR_NOT_READY')
})

for (const absoluteDeadline of [false, true]) test(absoluteDeadline
  ? 'watchdog enforces a frozen phase deadline despite a fresh heartbeat'
  : 'watchdog settles a stale running Agent task once', async () => {
  const suffix = `${Date.now()}_${process.pid}_${absoluteDeadline}`
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
      lastProgressAt: absoluteDeadline ? now : staleAt,
      progressJson: JSON.stringify({ kind: 'execution', stage: 'preparing', ...(absoluteDeadline ? { progress: { stageDeadlineAt: new Date(now.getTime() + 1_000).toISOString() } } : {}) }),
    },
  })
  await prisma.benchmarkDispatchOutbox.create({
    data: {
      runId,
      requestJson: JSON.stringify({ timeoutSeconds: 60, ...(absoluteDeadline ? { task: { execution: {} } } : {}) }),
      requestDigest: `sha256:${'e'.repeat(64)}`,
      status: 'accepted',
    },
  })

  await prisma.experimentEvalResult.create({ data: { experimentId, caseId, evaluatorId: 'benchmark:swe-bench', status: 'pending' } })

  assert.equal(await reapStaleRuns({ now, graceMs: 0, experimentId }), 0)
  await prisma.benchmarkCaseRun.update({
    where: { id: runId },
    data: { progressJson: JSON.stringify({ kind: 'execution', stage: 'agent_running', ...(absoluteDeadline ? { progress: { stageDeadlineAt: staleAt.toISOString() } } : {}) }) },
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

test('parallel Case claims use project limits and restore default budgets when omitted', async (t) => {
  const previousConfigDir = process.env.AGENT_INSIGHT_CONFIG_DIR
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-budgets-config-'))
  process.env.AGENT_INSIGHT_CONFIG_DIR = configDir
  const configure = (scheduling: Record<string, number>) => fs.writeFileSync(path.join(configDir, 'platform.local.yaml'), JSON.stringify({ benchmarks: { scheduling } }))
  t.after(() => {
    if (previousConfigDir === undefined) delete process.env.AGENT_INSIGHT_CONFIG_DIR
    else process.env.AGENT_INSIGHT_CONFIG_DIR = previousConfigDir
    fs.rmSync(configDir, { recursive: true, force: true })
  })
  const { prepareNextBenchmarkCaseRun } = await import('@/lib/benchmark/orchestrator')
  const fixture = JSON.parse(fs.readFileSync(path.resolve('benchmarks/swe-bench/fixtures/smoke-case.json'), 'utf8'))
  const dataset = await importBenchmarkDataset({ user, name: `parallel-${Date.now()}`, adapterKey: 'swe-bench', source: { kind: 'test' },
    cases: [1, 2, 3].map((i) => ({ ...fixture, instance_id: `example__parallel-${i}` })) })
  const clientId = `parallel-client-${Date.now()}`
  const capabilities = { platforms: [{ id: 'codex', agents: ['review'], runExperimentCase: { version: 2, returnsTraceId: true }, actions: ['RUN_EXPERIMENT_CASE', 'RUN_BENCHMARK_CASE'] }],
    components: { 'git-workspace/v1': { ready: true }, 'agent-runtime/codex/v1': { ready: true }, 'git-patch/v1': { ready: true }, 'concurrent-execution/v1': { ready: true } } }
  await prisma.reliabilityClient.create({ data: { clientId, user, name: 'parallel', status: 'online', serviceHealth: 'healthy', capabilitiesJson: JSON.stringify(capabilities), lastSeenAt: new Date() } })
  const response = await createExperiment(new Request('http://insight.test/api/experiments', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user, scope: 'benchmark', name: 'parallel claims',
      benchmark: { datasetId: dataset.id, executionTarget: { clientId }, caseSelection: { mode: 'all' },
        runConfig: { platform: 'codex', agent: 'review', executionConcurrency: 2 } } }) }))
  assert.equal(response.status, 201)
  const experiment = await response.json()
  await prisma.experiment.update({ where: { id: experiment.id }, data: { status: 'running' } })
  const claim = () => prepareNextBenchmarkCaseRun({ experimentId: experiment.id, callbackOrigin: 'http://platform.test' })
  const claimed = (await Promise.all([claim(), claim(), claim()])).filter((row) => row !== null)
  assert.equal(claimed.length, 2)
  assert.equal(new Set(claimed.map((row) => row.runId)).size, 2)
  await prisma.benchmarkCaseRun.update({ where: { id: claimed[0].runId }, data: { status: 'submitted' } })
  configure({ maxPendingEvaluations: 2 })
  assert.equal(await claim(), null)
  configure({ maxPendingEvaluationsPerUser: 2 })
  assert.equal(await claim(), null)
  configure({})
  assert.ok(await claim())
  assert.equal(await claim(), null)
})

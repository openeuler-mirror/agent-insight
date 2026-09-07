import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { deviceCredentialHash } from '../packages/benchmark-protocol/src/executor-contracts'

const require = createRequire(import.meta.url)
const { createBenchmarkExecutor } = require('../services/executor/src/index.cjs') as {
  createBenchmarkExecutor(options: Record<string, unknown>): {
    listen(host?: string, port?: number): Promise<{ port: number }>
    close(): Promise<void>
  }
}
const { runExperimentCase } = require('../scripts/reliability-client.cjs') as {
  runExperimentCase(config: Record<string, unknown>, payload: Record<string, unknown>): Promise<Record<string, unknown>>
}

const enabled = process.env.RUN_BENCHMARK_REAL_E2E === 'true'
const agentInsightHome = process.env.AGENT_INSIGHT_DATA_DIR || path.join(os.homedir(), '.agent-insight')
const databasePath = path.resolve(
  process.env.BENCHMARK_TEST_DATABASE_PATH
    || path.join(agentInsightHome, 'data', 'witty_insight.db'),
)
const externalEvaluatorOrigin = process.env.SWE_BENCH_E2E_EVALUATOR_BASE_URL?.replace(/\/$/, '') || ''
const externalEvaluatorToken = process.env.SWE_BENCH_E2E_EVALUATOR_TOKEN || ''
const controllerImage = process.env.SWE_BENCH_CONTROLLER_IMAGE || 'agent-insight-benchmark-evaluator:dev'
const caseExternalId = process.env.SWE_BENCH_E2E_CASE || 'pallets__flask-5014'
const model = process.env.SWE_BENCH_E2E_MODEL || 'deepseek/deepseek-v4-flash'
const agentTimeoutSeconds = Number(process.env.SWE_BENCH_E2E_AGENT_TIMEOUT_SECONDS || 900)
const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
const opencodeAvailable = spawnSync('/usr/local/bin/opencode', ['--version'], { stdio: 'ignore' }).status === 0
const controllerAvailable = Boolean(externalEvaluatorOrigin) || spawnSync(
  'docker', ['image', 'inspect', controllerImage], { stdio: 'ignore' },
).status === 0
const skipReason = !enabled
  ? 'set RUN_BENCHMARK_REAL_E2E=true for the all-real 01-13 test'
  : !fs.existsSync(databasePath)
    ? `real database missing: ${databasePath}`
    : !dockerAvailable
      ? 'Docker daemon unavailable'
      : !controllerAvailable
        ? `Controller image missing: ${controllerImage}`
        : Boolean(externalEvaluatorOrigin) !== Boolean(externalEvaluatorToken)
          ? 'external Evaluator URL and Token must be configured together'
        : !opencodeAvailable
          ? 'OpenCode CLI unavailable'
          : false

type RealCasePrivatePayload = {
  evaluation?: { image?: unknown }
}

type RealCaseRun = {
  status: string
  failureCode: string | null
  failureMessage: string | null
  runFactsJson: string | null
  cleanupJson: string | null
  artifacts: Array<{ storagePath: string }>
  evaluations: Array<{ id: string; status: string }>
}

type RealEvaluation = {
  status: string
  rawResultJson: string | null
  runtimeFactsJson: string | null
  cleanupJson: string | null
  normalizedResultJson: string | null
  artifacts: Array<{ name: string; storagePath: string }>
  dispatch: { status: string } | null
}

type RealExperimentResult = {
  status: string
  progress: { completed: number; pending: number }
  metrics: { primary: { denominator: number } | null }
  cases: Array<{
    outcome: string | null
    execution: { traceId: string | null }
    evaluation: { evaluationId: string; status: string } | null
  }>
}

async function listen(
  server: http.Server,
  host = '127.0.0.1',
): Promise<{ origin: string; port: number; close(): Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address() as { port: number }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function toRequest(req: http.IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks)
  return new Request(`${origin}${req.url}`, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : body,
  })
}

async function writeResponse(response: Response, res: http.ServerResponse): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  res.end(Buffer.from(await response.arrayBuffer()))
}

async function waitFor<T>(load: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await load()
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    value = await load()
  }
  if (!done(value)) throw new Error('all-real Benchmark E2E timed out')
  return value
}

test('steps 01-13 run OpenCode, Docker Controller and official SWE-bench Harness end to end', {
  skip: skipReason,
  timeout: 3_600_000,
}, async (t) => {
  process.env.AGENT_INSIGHT_DATA_DIR = agentInsightHome
  process.env.DATABASE_URL = `file:${databasePath}`
  process.env.PATH = `/usr/local/bin:${process.env.PATH || ''}`
  const token = externalEvaluatorToken || `real-e2e-${randomBytes(24).toString('base64url')}`
  process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN = token

  const [
    storage,
    createExperiment,
    runExperiment,
    artifact,
    artifactContent,
    runProgress,
    runComplete,
    evaluationProgress,
    evaluationArtifact,
    evaluationComplete,
    experimentResult,
  ] = await Promise.all([
    import('@/lib/storage/prisma'),
    import('@/app/api/experiments/route'),
    import('@/app/api/experiments/[id]/run/route'),
    import('@/app/api/benchmark/v1/artifacts/route'),
    import('@/app/api/benchmark/v1/artifacts/[artifactId]/content/route'),
    import('@/app/api/benchmark/v1/runs/[runId]/progress/route'),
    import('@/app/api/benchmark/v1/runs/[runId]/complete/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/progress/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/artifacts/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/complete/route'),
    import('@/app/api/benchmark/v1/experiments/[experimentId]/route'),
  ])
  const prisma = storage.prisma
  let publicOrigin = ''
  const platformServer = http.createServer(async (req, res) => {
    try {
      const request = await toRequest(req, publicOrigin)
      const url = new URL(request.url)
      let response: Response
      if (req.method === 'POST' && url.pathname === '/api/experiments') {
        response = await createExperiment.POST(request)
      } else if (req.method === 'POST' && /^\/api\/experiments\/[^/]+\/run$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await runExperiment.POST(request, { params: Promise.resolve({ id }) })
      } else if (req.method === 'POST' && url.pathname === '/api/benchmark/v1/artifacts') {
        response = await artifact.POST(request)
      } else if (req.method === 'GET' && /^\/api\/benchmark\/v1\/artifacts\/[^/]+\/content$/.test(url.pathname)) {
        const artifactId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await artifactContent.GET(request, { params: Promise.resolve({ artifactId }) })
      } else if (req.method === 'POST' && /^\/api\/benchmark\/v1\/runs\/[^/]+\/progress$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await runProgress.POST(request, { params: Promise.resolve({ runId }) })
      } else if (req.method === 'POST' && /^\/api\/benchmark\/v1\/runs\/[^/]+\/complete$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await runComplete.POST(request, { params: Promise.resolve({ runId }) })
      } else if (req.method === 'POST' && /^\/api\/benchmark\/v1\/evaluations\/[^/]+\/progress$/.test(url.pathname)) {
        const evaluationId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await evaluationProgress.POST(request, { params: Promise.resolve({ evaluationId }) })
      } else if (req.method === 'POST' && /^\/api\/benchmark\/v1\/evaluations\/[^/]+\/artifacts$/.test(url.pathname)) {
        const evaluationId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await evaluationArtifact.POST(request, { params: Promise.resolve({ evaluationId }) })
      } else if (req.method === 'POST' && /^\/api\/benchmark\/v1\/evaluations\/[^/]+\/complete$/.test(url.pathname)) {
        const evaluationId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await evaluationComplete.POST(request, { params: Promise.resolve({ evaluationId }) })
      } else if (req.method === 'GET' && /^\/api\/benchmark\/v1\/experiments\/[^/]+$/.test(url.pathname)) {
        const experimentId = decodeURIComponent(url.pathname.split('/').at(-1) || '')
        response = await experimentResult.GET(request, { params: Promise.resolve({ experimentId }) })
      } else {
        response = new Response('{}', { status: 404 })
      }
      await writeResponse(response, res)
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  const platform = await listen(platformServer, '0.0.0.0')
  publicOrigin = `http://host.docker.internal:${platform.port}`
  process.env.AGENT_INSIGHT_PUBLIC_BASE_URL = publicOrigin

  const suffix = `${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  const clientId = `real_e2e_client_${suffix}`
  const deviceCredential = `dc_${randomBytes(32).toString('base64url')}`
  const executorBaseDir = path.join(agentInsightHome, 'client', 'benchmark-real-e2e', suffix)
  const controllerName = `agent-insight-real-e2e-${suffix.toLowerCase()}`
  let executor: ReturnType<typeof createBenchmarkExecutor> | null = null
  let experimentId = ''
  let runId = ''
  let evaluationId = ''
  let controllerStarted = false
  try {
    const dataset = await prisma.benchmarkDataset.findFirst({
      where: { adapterKey: 'swe-bench', status: 'ready' },
      orderBy: { createdAt: 'asc' },
    })
    assert.ok(dataset, 'real SWE-bench dataset is required')
    const datasetCase = await prisma.benchmarkDatasetCase.findFirst({
      where: { datasetId: dataset.id, externalCaseId: caseExternalId },
    })
    assert.ok(datasetCase, `real SWE-bench case missing: ${caseExternalId}`)
    const privatePayload = JSON.parse(datasetCase.privatePayloadJson) as RealCasePrivatePayload
    const caseImage = String(privatePayload.evaluation?.image || '')
    assert.ok(caseImage, 'real Case does not contain an evaluation image')
    const dockerArch = String(spawnSync(
      'docker', ['info', '--format', '{{.Architecture}}'], { encoding: 'utf8' },
    ).stdout || '').trim().toLowerCase()
    const resolvedCaseImage = ['arm64', 'aarch64'].includes(dockerArch)
      ? caseImage.replace('.x86_64.', '.arm64.')
      : caseImage.replace('.arm64.', '.x86_64.')
    if (!externalEvaluatorOrigin && spawnSync(
      'docker', ['image', 'inspect', resolvedCaseImage], { stdio: 'ignore' },
    ).status !== 0) {
      t.skip(`Case image is not local; this test never pulls it automatically: ${resolvedCaseImage}`)
      return
    }

    let evaluatorOrigin = externalEvaluatorOrigin
    if (!evaluatorOrigin) {
      const controller = spawnSync('docker', [
        'run', '--rm', '-d', '--pull', 'never',
        '--name', controllerName,
        '--add-host', 'host.docker.internal:host-gateway',
        '-v', '/var/run/docker.sock:/var/run/docker.sock',
        '--tmpfs', '/data:rw,nosuid,nodev',
        '-e', `EVALUATOR_PLATFORM_TOKEN=${token}`,
        '-e', 'SWE_BENCH_IMAGE_SOURCE=official',
        '-e', 'SWE_BENCH_IMAGE_ARCH=auto',
        '-e', 'SWE_BENCH_ALLOW_NON_OFFICIAL=false',
        '-p', '127.0.0.1::8080',
        controllerImage,
      ], { encoding: 'utf8' })
      assert.equal(controller.status, 0, String(controller.stderr || controller.stdout))
      controllerStarted = true
      const portResult = spawnSync('docker', ['port', controllerName, '8080/tcp'], { encoding: 'utf8' })
      assert.equal(portResult.status, 0, String(portResult.stderr || portResult.stdout))
      const published = String(portResult.stdout || '').trim()
      const controllerPort = Number(published.slice(published.lastIndexOf(':') + 1))
      assert.ok(Number.isInteger(controllerPort) && controllerPort > 0)
      evaluatorOrigin = `http://127.0.0.1:${controllerPort}`
    }
    process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL = evaluatorOrigin
    const healthResponse = await waitFor(
      async () => fetch(`${evaluatorOrigin}/health`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null),
      (response) => response?.ok === true,
      30_000,
    )
    assert.ok(healthResponse)
    const health = await healthResponse.json() as Record<string, unknown>
    assert.equal(health.status, 'healthy')
    if (externalEvaluatorOrigin) {
      t.diagnostic(`one-command evaluator health=${JSON.stringify(health)}`)
    }

    executor = createBenchmarkExecutor({
      clientId,
      deviceCredential,
      insightBaseUrl: publicOrigin,
      baseDir: executorBaseDir,
      fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
        const target = new URL(input instanceof Request ? input.url : String(input))
        if (target.hostname === 'host.docker.internal') target.hostname = '127.0.0.1'
        return fetch(target, init)
      },
      runAgent: (payload: Record<string, unknown>) => runExperimentCase({
        clientId,
        workspaceBase: path.join(executorBaseDir, 'fallback-workspace'),
      }, payload),
      logError: (...values: unknown[]) => t.diagnostic(values.map(String).join(' ')),
    })
    const executorAddress = await executor.listen('127.0.0.1', 0)
    const executorOrigin = `http://127.0.0.1:${executorAddress.port}`
    await prisma.reliabilityClient.create({
      data: {
        id: `rclient_${randomUUID().replaceAll('-', '')}`,
        clientId,
        user: dataset.user,
        name: `Real E2E ${caseExternalId}`,
        status: 'online',
        serviceHealth: 'healthy',
        lastSeenAt: new Date(),
        executorBaseUrl: executorOrigin,
        executorReachability: 'reachable',
        executorCheckedAt: new Date(),
        capabilitiesJson: JSON.stringify({
          platforms: [{ id: 'opencode', models: [model], agents: ['build'] }],
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
        id: `rcred_${randomUUID().replaceAll('-', '')}`,
        clientId,
        credentialHash: deviceCredentialHash(deviceCredential),
      },
    })

    const createdResponse = await fetch(`${platform.origin}/api/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user: dataset.user,
        scope: 'benchmark',
        name: `All-real SWE-bench E2E ${caseExternalId}`,
        agentName: 'build',
        benchmark: {
          datasetId: dataset.id,
          caseSelection: { mode: 'explicit', caseIds: [datasetCase.id] },
          executionTarget: { clientId },
          runConfig: {
            platform: 'opencode',
            agent: 'build',
            model,
            agentTimeoutSeconds,
            maxParallelAgentCases: 1,
          },
        },
      }),
    })
    const createdText = await createdResponse.text()
    assert.equal(createdResponse.status, 201, createdText)
    experimentId = String((JSON.parse(createdText) as Record<string, unknown>).id)
    const startResponse = await fetch(
      `${platform.origin}/api/experiments/${experimentId}/run?user=${encodeURIComponent(dataset.user)}`,
      { method: 'POST' },
    )
    const startedText = await startResponse.text()
    assert.equal(startResponse.status, 202, startedText)
    runId = String((JSON.parse(startedText) as Record<string, unknown>).runId)

    const run = await waitFor<RealCaseRun | null>(
      async () => await prisma.benchmarkCaseRun.findUnique({
        where: { id: runId },
        include: { artifacts: true, evaluations: { orderBy: { attemptNo: 'desc' }, take: 1 } },
      }) as unknown as RealCaseRun | null,
      (value) => ['evaluated', 'evaluation_failed', 'submission_invalid', 'execution_failed', 'dispatch_failed'].includes(value?.status || ''),
      (agentTimeoutSeconds + 2_400) * 1_000,
    )
    assert.ok(run)
    assert.equal(run.status, 'evaluated', `${run.failureCode || ''}: ${run.failureMessage || ''}`)
    assert.ok(run.artifacts[0])
    evaluationId = run.evaluations[0]?.id || ''
    assert.ok(evaluationId)
    assert.equal(run.evaluations[0].status, 'completed')
    const patchPath = path.join(agentInsightHome, 'data', run.artifacts[0].storagePath)
    const patch = await fsp.readFile(patchPath, 'utf8')
    assert.match(patch, /^diff --git /m)
    const facts = JSON.parse(run.runFactsJson || '{}') as Record<string, unknown>
    assert.match(String(facts.traceId || ''), /^ses_/)
    assert.ok(run.cleanupJson)
    const executorCleanup = JSON.parse(run.cleanupJson) as Record<string, unknown>
    assert.equal(executorCleanup.status, 'succeeded')

    const evaluation = await prisma.benchmarkEvaluation.findUnique({
      where: { id: evaluationId },
      include: { artifacts: true, dispatch: true },
    }) as unknown as RealEvaluation | null
    assert.ok(evaluation)
    assert.equal(evaluation.status, 'completed')
    assert.equal(evaluation.dispatch?.status, 'accepted')
    assert.equal(evaluation.artifacts.length, 3)
    assert.deepEqual(
      evaluation.artifacts.map((item) => item.name).sort(),
      ['report.json', 'run_instance.log', 'test_output.txt'],
    )
    assert.ok(evaluation.rawResultJson)
    assert.ok(evaluation.runtimeFactsJson)
    assert.ok(evaluation.cleanupJson)
    assert.ok(evaluation.normalizedResultJson)
    const runtimeFacts = JSON.parse(evaluation.runtimeFactsJson) as Record<string, unknown>
    assert.match(String(runtimeFacts.caseImage || ''), /@sha256:/)
    const normalizedResult = JSON.parse(evaluation.normalizedResultJson) as Record<string, unknown>
    assert.equal(normalizedResult.status, 'done')
    assert.equal(normalizedResult.verdict, 'pass')
    assert.equal(normalizedResult.score, 100)

    const resultResponse = await fetch(
      `${platform.origin}/api/benchmark/v1/experiments/${experimentId}?user=${encodeURIComponent(dataset.user)}`,
    )
    assert.equal(resultResponse.status, 200)
    const result = await resultResponse.json() as RealExperimentResult
    assert.equal(result.status, 'completed')
    assert.equal(result.progress.completed, 1)
    assert.equal(result.progress.pending, 0)
    assert.equal(result.metrics.primary?.denominator, 1)
    assert.equal(result.cases[0].execution.traceId, facts.traceId)
    assert.equal(result.cases[0].evaluation?.evaluationId, evaluationId)
    t.diagnostic(`experiment=${experimentId} run=${runId} evaluation=${evaluationId} opencodeSession=${String(facts.traceId)} outcome=${result.cases[0].outcome}`)
    t.diagnostic(`executor cleanup=${run.cleanupJson} evaluation evidence=${evaluation.artifacts.map((item) => item.name).sort().join(',')} image=${String(runtimeFacts.caseImage)} evaluator cleanup=${evaluation.cleanupJson} normalized=${evaluation.normalizedResultJson}`)
    t.diagnostic(`model.patch=${patch.slice(0, 2_000)}`)
  } finally {
    if (executor) await executor.close().catch(() => undefined)
    if (controllerStarted) {
      const logs = spawnSync('docker', ['logs', controllerName], { encoding: 'utf8' })
      if (!evaluationId) t.diagnostic(`${logs.stdout || ''}${logs.stderr || ''}`.trim())
      spawnSync('docker', ['stop', '--time', '10', controllerName], { stdio: 'ignore' })
    }
    await platform.close()
    if (experimentId) await prisma.experiment.deleteMany({ where: { id: experimentId } })
    await prisma.reliabilityClient.deleteMany({ where: { clientId } })
    if (runId) {
      await fsp.rm(path.join(agentInsightHome, 'data', 'benchmark-artifacts', runId), { recursive: true, force: true })
    }
    if (evaluationId) {
      await fsp.rm(path.join(agentInsightHome, 'data', 'benchmark-evaluation-artifacts', evaluationId), { recursive: true, force: true })
    }
    await fsp.rm(executorBaseDir, { recursive: true, force: true })
    delete process.env.AGENT_INSIGHT_PUBLIC_BASE_URL
    delete process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL
    delete process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN
    await prisma.$disconnect()
  }
})

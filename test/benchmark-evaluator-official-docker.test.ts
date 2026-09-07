import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import type { Prisma } from '@prisma/client'

const controllerDockerEnabled = process.env.RUN_SWE_BENCH_CONTROLLER_DOCKER_TEST === 'true'
const enabled = process.env.RUN_SWE_BENCH_DOCKER_TEST === 'true' || controllerDockerEnabled
const controllerImage = process.env.SWE_BENCH_CONTROLLER_IMAGE || 'agent-insight-benchmark-evaluator:dev'
const databasePath = path.resolve(
  process.env.BENCHMARK_TEST_DATABASE_PATH
    || path.join(os.homedir(), '.agent-insight', 'data', 'witty_insight.db'),
)
const pythonPath = process.env.SWE_BENCH_PYTHON
  || path.join(os.homedir(), '.agent-insight', 'vendor', 'SWE-bench', '.venv', 'bin', 'python')
const sourceRunId = process.env.SWE_BENCH_SMOKE_EXECUTION_RUN_ID
  || 'erun_56961f9212164183917ef336686cd7d6'
const dockerCheck = spawnSync('docker', ['info', '--format', '{{.Architecture}}'], { encoding: 'utf8' })
const skipReason = !enabled
  ? 'set RUN_SWE_BENCH_DOCKER_TEST=true for the real Docker acceptance test'
  : !fs.existsSync(databasePath)
      ? `real database missing: ${databasePath}`
      : !fs.existsSync(pythonPath)
        ? `official SWE-bench Python missing: ${pythonPath}`
        : false

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

async function writeResponse(response: Response, res: http.ServerResponse) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  res.end(Buffer.from(await response.arrayBuffer()))
}

test(`steps 09-13 run a real local Artifact through the official SWE-bench Case container${controllerDockerEnabled ? ' from the Dockerized Controller' : ''}`, {
  skip: skipReason,
  timeout: 3_600_000,
}, async (t) => {
  process.env.DATABASE_URL = `file:${databasePath}`
  process.env.AGENT_INSIGHT_DATA_DIR = path.join(os.homedir(), '.agent-insight')
  process.env.SWE_BENCH_PYTHON = pythonPath
  process.env.SWE_BENCH_IMAGE_SOURCE = process.env.SWE_BENCH_IMAGE_SOURCE || 'official'
  process.env.SWE_BENCH_IMAGE_ARCH = process.env.SWE_BENCH_IMAGE_ARCH || 'auto'
  process.env.SWE_BENCH_ALLOW_NON_OFFICIAL = process.env.SWE_BENCH_ALLOW_NON_OFFICIAL || 'false'
  const token = `official-smoke-${Date.now()}-${process.pid}`
  process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN = token

  const [
    storage,
    artifactContent,
    evaluationProgress,
    evaluationArtifact,
    evaluationComplete,
    experimentResult,
    protocol,
    adapterModule,
  ] = await Promise.all([
    import('@/lib/storage/prisma'),
    import('@/app/api/benchmark/v1/artifacts/[artifactId]/content/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/progress/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/artifacts/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/complete/route'),
    import('@/app/api/benchmark/v1/experiments/[experimentId]/route'),
    import('../packages/benchmark-protocol/src/evaluation-contracts'),
    import('../benchmarks/swe-bench/adapter/index'),
  ])
  const prisma = storage.prisma
  let platformOrigin = ''
  const platformServer = http.createServer(async (req, res) => {
    try {
      const request = await toRequest(req, platformOrigin)
      const url = new URL(request.url)
      let response: Response
      if (req.method === 'GET' && /^\/api\/benchmark\/v1\/artifacts\/[^/]+\/content$/.test(url.pathname)) {
        const artifactId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await artifactContent.GET(request, { params: Promise.resolve({ artifactId }) })
      } else if (req.method === 'POST' && /\/progress$/.test(url.pathname)) {
        const evaluationId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await evaluationProgress.POST(request, { params: Promise.resolve({ evaluationId }) })
      } else if (req.method === 'POST' && /\/artifacts$/.test(url.pathname)) {
        const evaluationId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await evaluationArtifact.POST(request, { params: Promise.resolve({ evaluationId }) })
      } else if (req.method === 'POST' && /\/complete$/.test(url.pathname)) {
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
      res.end(JSON.stringify({ error: String(error) }))
    }
  })
  const platform = await listen(platformServer, controllerDockerEnabled ? '0.0.0.0' : '127.0.0.1')
  const callbackOrigin = controllerDockerEnabled
    ? `http://host.docker.internal:${platform.port}`
    : platform.origin
  platformOrigin = callbackOrigin

  const suffix = `${Date.now()}_${process.pid}`
  const experimentId = `exp_official_smoke_${suffix}`
  const experimentUser = `official-smoke-${suffix}`
  const caseId = `case_official_smoke_${suffix}`
  const runId = `erun_official_smoke_${suffix}`
  const evaluationId = `veval_official_smoke_${suffix}`
  const clonedArtifactId = `bart_official_smoke_${suffix}`
  const controllerData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-official-evaluator-'))
  let evidenceDirectory = ''
  let evaluatorListener: { origin: string; close(): Promise<void> } | undefined
  let controllerContainerName = ''
  let controllerCompleted = false
  try {
    const source = await prisma.benchmarkCaseRun.findUnique({
      where: { id: sourceRunId },
      include: {
        artifacts: true,
        experiment: { include: { benchmarkBinding: true } },
        experimentCase: true,
      },
    })
    assert.ok(source, `real source run not found: ${sourceRunId}`)
    assert.ok(source.artifacts[0], 'real source run has no Agent Patch Artifact')
    assert.ok(source.experiment.benchmarkBinding)
    const sourceArtifact = source.artifacts[0]
    const task = JSON.parse(source.taskEnvelopeJson || '{}')
    const defaults = adapterModule.sweBenchAdapter.manifest.evaluation
    const job = adapterModule.sweBenchAdapter.buildEvaluationRequest({
      context: {
        evaluationRunId: evaluationId,
        executionRunId: runId,
        experimentId,
        caseId,
        datasetContentHash: source.experiment.benchmarkBinding.datasetContentHash,
      },
      publicPayload: JSON.parse(source.publicPayloadJson || '{}'),
      privatePayload: JSON.parse(source.privatePayloadJson || '{}'),
      artifacts: [{
        artifactId: clonedArtifactId,
        executionRunId: runId,
        name: sourceArtifact.name,
        mediaType: sourceArtifact.mediaType,
        sha256: sourceArtifact.sha256,
        sizeBytes: sourceArtifact.sizeBytes,
      }],
      runConfig: {
        evaluatorKey: defaults.evaluatorKey,
        timeoutSeconds: defaults.defaultTimeoutSeconds,
        cpu: defaults.defaultResources.cpu,
        memoryMiB: defaults.defaultResources.memoryMiB,
        agentModel: task.agentConfig?.model
          || `${task.agentConfig?.platform || 'opencode'}/${task.agentConfig?.agent || 'build'}`,
      },
    })
    const callbackBaseUrl = `${callbackOrigin}/api/benchmark/v1/evaluations/${evaluationId}`
    const dispatchBody = {
      runId: evaluationId,
      evaluationJob: job,
      platformBaseUrl: callbackOrigin,
      callbackBaseUrl,
      timeoutSeconds: job.limits.timeoutSeconds,
    }
    const requestDigest = protocol.benchmarkEvaluationDispatchDigest(dispatchBody)
    const request = { ...dispatchBody, requestDigest }
    assert.equal(JSON.stringify(job).includes('goldPatch'), false)
    if (dockerCheck.status !== 0) {
      t.skip(`Docker daemon unavailable: ${String(dockerCheck.stderr || '').trim()}`)
      return
    }

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.experiment.create({
        data: {
          id: experimentId,
          user: experimentUser,
          name: `Official SWE-bench evaluator smoke ${suffix}`,
          agentName: source.experiment.agentName,
          evaluatorIdsJson: JSON.stringify(['benchmark:swe-bench']),
          status: 'running',
          scope: 'benchmark',
        },
      })
      await tx.experimentCase.create({
        data: {
          id: caseId,
          experimentId,
          input: source.experimentCase.input,
          datasetInput: source.experimentCase.datasetInput,
          caseValuesJson: source.experimentCase.caseValuesJson,
        },
      })
      await tx.benchmarkExperimentBinding.create({
        data: {
          experimentId,
          datasetId: source.experiment.benchmarkBinding!.datasetId,
          datasetContentHash: source.experiment.benchmarkBinding!.datasetContentHash,
          adapterKey: 'swe-bench',
          selectionJson: '{}',
          runConfigJson: source.experiment.benchmarkBinding!.runConfigJson,
          schedulerStatus: 'running',
          expectedCaseCount: 1,
          callbackOrigin,
        },
      })
      await tx.benchmarkCaseRun.create({
        data: {
          id: runId,
          experimentId,
          experimentCaseId: caseId,
          datasetCaseId: source.datasetCaseId,
          ordinal: 0,
          status: 'submitted',
          adapterKey: 'swe-bench',
          clientId: source.clientId,
          executorBaseUrl: source.executorBaseUrl,
          publicPayloadJson: source.publicPayloadJson,
          privatePayloadJson: source.privatePayloadJson,
          taskEnvelopeJson: source.taskEnvelopeJson,
          taskDigest: source.taskDigest,
        },
      })
      await tx.benchmarkArtifact.create({
        data: {
          id: clonedArtifactId,
          runId,
          name: sourceArtifact.name,
          mediaType: sourceArtifact.mediaType,
          sha256: sourceArtifact.sha256,
          sizeBytes: sourceArtifact.sizeBytes,
          storagePath: sourceArtifact.storagePath,
        },
      })
      await tx.benchmarkEvaluation.create({
        data: {
          id: evaluationId,
          caseRunId: runId,
          status: 'queued',
          adapterKey: 'swe-bench',
          evaluatorKey: 'swe-bench',
          requestJson: JSON.stringify(job),
          requestDigest,
          callbackBaseUrl,
          timeoutSeconds: job.limits.timeoutSeconds,
        },
      })
    })

    let evaluatorOrigin: string
    if (controllerDockerEnabled) {
      const imageCheck = spawnSync('docker', ['image', 'inspect', controllerImage], { encoding: 'utf8' })
      assert.equal(imageCheck.status, 0, `Controller image missing: ${controllerImage}`)
      controllerContainerName = `agent-insight-evaluator-smoke-${suffix.toLowerCase()}`
      const started = spawnSync('docker', [
        'run', '--rm', '-d', '--pull', 'never',
        '--name', controllerContainerName,
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
      assert.equal(started.status, 0, String(started.stderr || started.stdout))
      const portResult = spawnSync('docker', ['port', controllerContainerName, '8080/tcp'], { encoding: 'utf8' })
      assert.equal(portResult.status, 0, String(portResult.stderr || portResult.stdout))
      const published = String(portResult.stdout || '').trim()
      const port = Number(published.slice(published.lastIndexOf(':') + 1))
      assert.ok(Number.isInteger(port) && port > 0, `Controller published port invalid: ${published}`)
      evaluatorOrigin = `http://127.0.0.1:${port}`
    } else {
      const { BenchmarkEvaluatorService } = require('../services/evaluator/src/service.cjs') as {
        BenchmarkEvaluatorService: new (options: Record<string, unknown>) => { createServer(): http.Server }
      }
      const service = new BenchmarkEvaluatorService({ dataDir: controllerData, token })
      evaluatorListener = await listen(service.createServer())
      evaluatorOrigin = evaluatorListener.origin
    }
    const healthDeadline = Date.now() + 30_000
    let health: Response | undefined
    while (Date.now() < healthDeadline) {
      try {
        health = await fetch(`${evaluatorOrigin}/health`, {
          headers: { authorization: `Bearer ${token}` },
        })
        if (health.ok) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.equal(health?.status, 200)
    assert.equal((await health!.json()).status, 'healthy')
    const accepted = await fetch(`${evaluatorOrigin}/api/v1/evaluations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': evaluationId,
        'x-agent-insight-request-digest': requestDigest,
      },
      body: JSON.stringify(request),
    })
    assert.equal(accepted.status, 202)
    const deadline = Date.now() + 3_500_000
    let evaluation
    while (Date.now() < deadline) {
      evaluation = await prisma.benchmarkEvaluation.findUnique({
        where: { id: evaluationId },
        include: { artifacts: true },
      })
      if (['completed', 'submission_invalid', 'failed', 'normalization_failed'].includes(evaluation?.status || '')) break
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    assert.ok(evaluation)
    assert.equal(evaluation.status, 'completed')
    assert.equal(evaluation.artifacts.length, 3)
    assert.match(evaluation.runtimeFactsJson || '', /@sha256:/)
    assert.ok(evaluation.rawResultJson)
    assert.ok(evaluation.normalizedResultJson)
    const resultResponse = await fetch(
      `${platform.origin}/api/benchmark/v1/experiments/${experimentId}?user=${encodeURIComponent(experimentUser)}`,
    )
    assert.equal(resultResponse.status, 200)
    const resultBody = await resultResponse.json() as Record<string, any>
    assert.equal(resultBody.status, 'completed')
    assert.equal(resultBody.progress.completed, 1)
    assert.equal(resultBody.progress.pending, 0)
    assert.equal(resultBody.metrics.primary.key, 'resolvedRate')
    assert.equal(resultBody.metrics.primary.denominator, 1)
    assert.equal(resultBody.cases[0].evaluation.evaluationId, evaluationId)
    assert.equal(resultBody.cases[0].nativeMetrics.officialReport, undefined)
    controllerCompleted = true
    evidenceDirectory = path.join(
      os.homedir(), '.agent-insight', 'data', 'benchmark-evaluation-artifacts', evaluationId,
    )
  } finally {
    await evaluatorListener?.close()
    if (controllerContainerName) {
      if (!controllerCompleted) {
        const logs = spawnSync('docker', ['logs', controllerContainerName], { encoding: 'utf8' })
        t.diagnostic(`${logs.stdout || ''}${logs.stderr || ''}`.trim())
      }
      spawnSync('docker', ['stop', '--time', '10', controllerContainerName], { encoding: 'utf8' })
    }
    await platform.close()
    if (process.env.SWE_BENCH_KEEP_SMOKE_ARTIFACTS !== 'true') {
      await prisma.experiment.deleteMany({ where: { id: experimentId } })
      if (evidenceDirectory) await fsp.rm(evidenceDirectory, { recursive: true, force: true })
      fs.rmSync(controllerData, { recursive: true, force: true })
    } else {
      console.log(`kept official smoke experiment=${experimentId} evaluation=${evaluationId} journal=${controllerData}`)
    }
    await prisma.$disconnect()
  }
})

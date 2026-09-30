import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Prisma } from '@prisma/client'

const enabled = process.env.RUN_BENCHMARK_RESULT_API_TEST === 'true'
const databasePath = path.resolve(
  process.env.BENCHMARK_TEST_DATABASE_PATH
    || path.join(os.homedir(), '.agent-insight', 'data', 'witty_insight.db'),
)
const skipReason = !enabled
  ? 'set RUN_BENCHMARK_RESULT_API_TEST=true for the real-database result API test'
  : !fs.existsSync(databasePath)
    ? `real database missing: ${databasePath}`
    : false

async function listen(server: http.Server): Promise<{ origin: string; close(): Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as { port: number }
  return {
    origin: `http://127.0.0.1:${address.port}`,
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

test('benchmark result counts only the latest run after a Case retry', async () => {
  const storage = await import('@/lib/storage/prisma')
  const { getBenchmarkExperimentResult } = await import('@/lib/benchmark/experiment-result-service')
  const experimentDelegate = storage.prisma.experiment as object
  const runDelegate = storage.prisma.benchmarkCaseRun as object
  const originalFindExperiment = Reflect.get(experimentDelegate, 'findFirst')
  const originalFindRuns = Reflect.get(runDelegate, 'findMany')
  const sharedResult = {
    status: 'done',
    verdict: 'pass',
    summary: 'retry passed',
    score: 100,
    errorMessage: null,
  }
  const normalizedResultJson = JSON.stringify({
    status: 'done',
    verdict: 'pass',
    summary: 'retry passed',
    score: 100,
    primaryMetric: { key: 'resolved', value: true, aggregation: 'boolean-rate' },
    points: [],
    evidence: { artifactIds: [], cleanup: {} },
    nativeMetrics: { resolved: true },
  })
  const run = (id: string, evaluationId: string, retryOfRunId: string | null) => ({
    id,
    retryOfRunId,
    ordinal: 0,
    status: 'evaluated',
    runFactsJson: JSON.stringify({ traceId: `trace_${id}` }),
    failureCode: null,
    failureMessage: null,
    datasetCase: { externalCaseId: 'fixture__case-1' },
    artifacts: [
      {
        id: `submission-answer-${id}`,
        name: 'answer.txt',
        mediaType: 'text/plain',
        sha256: `sha256:${'a'.repeat(64)}`,
        sizeBytes: 6,
      },
      {
        id: `submission-trace-${id}`,
        name: 'trace.json',
        mediaType: 'application/json',
        sha256: `sha256:${'b'.repeat(64)}`,
        sizeBytes: 12,
      },
    ],
    experimentCase: { id: 'case-1', results: [sharedResult] },
    evaluations: [{
      id: evaluationId,
      status: 'completed',
      normalizedResultJson,
      artifacts: [],
    }],
  })
  let observedOrderBy: unknown

  Reflect.set(experimentDelegate, 'findFirst', async () => ({
    id: 'experiment-1',
    status: 'done',
    benchmarkBinding: { adapterKey: 'swe-bench', expectedCaseCount: 1 },
  }))
  Reflect.set(runDelegate, 'findMany', async (args: { orderBy?: unknown }) => {
    observedOrderBy = args.orderBy
    return [
      run('historical-run', 'historical-evaluation', null),
      run('retry-run', 'retry-evaluation', 'historical-run'),
    ]
  })

  try {
    const result = await getBenchmarkExperimentResult({
      experimentId: 'experiment-1',
      user: 'test-user',
      page: 1,
      pageSize: 20,
    })
    assert.deepEqual(observedOrderBy, [{ createdAt: 'desc' }, { id: 'desc' }])
    assert.deepEqual(result.progress, { total: 1, completed: 1, pending: 0, coverageRate: 100 })
    assert.deepEqual(result.outcomes, { pass: 1, warn: 0, fail: 0, unknown: 0 })
    assert.deepEqual(result.metrics.primary, {
      key: 'resolvedRate', value: 100, numerator: 1, denominator: 1,
    })
    assert.deepEqual(result.metrics.averageScore, { value: 100, count: 1 })
    assert.deepEqual(result.pagination, { page: 1, pageSize: 20, total: 1 })
    assert.equal(result.cases.length, 1)
    assert.equal(result.cases[0].execution.runId, 'retry-run')
    assert.equal('patchArtifactId' in result.cases[0].execution, false)
    assert.deepEqual(
      result.cases[0].submissions.map((artifact) => artifact.name),
      ['answer.txt', 'trace.json'],
    )
    assert.equal(result.cases[0].evaluation?.evaluationId, 'retry-evaluation')
  } finally {
    Reflect.set(experimentDelegate, 'findFirst', originalFindExperiment)
    Reflect.set(runDelegate, 'findMany', originalFindRuns)
  }
})

test('steps 11-13 persist, normalize, aggregate and expose evidence through HTTP APIs', {
  skip: skipReason,
  timeout: 60_000,
}, async () => {
  process.env.DATABASE_URL = `file:${databasePath}`
  process.env.AGENT_INSIGHT_HOME = path.join(os.homedir(), '.agent-insight')
  const [
    storage,
    artifactRoute,
    completeRoute,
    resultRoute,
    artifactContentRoute,
  ] = await Promise.all([
    import('@/lib/storage/prisma'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/artifacts/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/complete/route'),
    import('@/app/api/benchmark/v1/experiments/[experimentId]/route'),
    import('@/app/api/benchmark/v1/evaluations/[evaluationId]/artifacts/[artifactId]/content/route'),
  ])
  const prisma = storage.prisma
  let origin = ''
  const server = http.createServer(async (req, res) => {
    try {
      const request = await toRequest(req, origin)
      const url = new URL(request.url)
      let response: Response
      if (req.method === 'POST' && /\/evaluations\/[^/]+\/artifacts$/.test(url.pathname)) {
        const evaluationId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await artifactRoute.POST(request, { params: Promise.resolve({ evaluationId }) })
      } else if (req.method === 'POST' && /\/evaluations\/[^/]+\/complete$/.test(url.pathname)) {
        const evaluationId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
        response = await completeRoute.POST(request, { params: Promise.resolve({ evaluationId }) })
      } else if (req.method === 'GET' && /\/evaluations\/[^/]+\/artifacts\/[^/]+\/content$/.test(url.pathname)) {
        const segments = url.pathname.split('/')
        response = await artifactContentRoute.GET(request, {
          params: Promise.resolve({
            evaluationId: decodeURIComponent(segments.at(-4) || ''),
            artifactId: decodeURIComponent(segments.at(-2) || ''),
          }),
        })
      } else if (req.method === 'GET' && /\/experiments\/[^/]+$/.test(url.pathname)) {
        const experimentId = decodeURIComponent(url.pathname.split('/').at(-1) || '')
        response = await resultRoute.GET(request, { params: Promise.resolve({ experimentId }) })
      } else {
        response = new Response('{}', { status: 404 })
      }
      await writeResponse(response, res)
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(error) }))
    }
  })
  const listener = await listen(server)
  origin = listener.origin

  const suffix = `${Date.now()}_${process.pid}`
  const experimentId = `exp_result_api_${suffix}`
  const caseIds = [`case_result_api_a_${suffix}`, `case_result_api_b_${suffix}`]
  const runIds = [`erun_result_api_a_${suffix}`, `erun_result_api_b_${suffix}`]
  const evaluationIds = [`veval_result_api_a_${suffix}`, `veval_result_api_b_${suffix}`]
  const evidenceDirs = evaluationIds.map((id) => path.join(
    os.homedir(), '.agent-insight', 'data', 'benchmark-evaluation-artifacts', id,
  ))
  try {
    const dataset = await prisma.benchmarkDataset.findFirst({
      where: { adapterKey: 'swe-bench', status: 'ready' },
      orderBy: { createdAt: 'asc' },
      include: { cases: { orderBy: { ordinal: 'asc' }, take: 1 } },
    })
    assert.ok(dataset, 'real SWE-bench dataset is required')
    assert.ok(dataset.cases[0], 'real SWE-bench dataset has no cases')
    const datasetCase = dataset.cases[0]
    const instanceId = JSON.parse(datasetCase.publicPayloadJson).instanceId as string
    assert.ok(instanceId)
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.experiment.create({
        data: {
          id: experimentId,
          user: dataset.user,
          name: `Benchmark result API ${suffix}`,
          agentName: 'build',
          evaluatorIdsJson: JSON.stringify(['benchmark:swe-bench']),
          status: 'running',
          scope: 'benchmark',
        },
      })
      await tx.experimentCase.createMany({
        data: caseIds.map((id, index) => ({
          id,
          experimentId,
          input: `result API case ${index}`,
          datasetInput: datasetCase.publicPayloadJson,
        })),
      })
      await tx.benchmarkExperimentBinding.create({
        data: {
          experimentId,
          datasetId: dataset.id,
          datasetContentHash: dataset.contentHash,
          adapterKey: 'swe-bench',
          selectionJson: '{}',
          runConfigJson: '{}',
          schedulerStatus: 'running',
          expectedCaseCount: 2,
          callbackOrigin: origin,
        },
      })
      for (let index = 0; index < 2; index += 1) {
        await tx.benchmarkCaseRun.create({
          data: {
            id: runIds[index],
            experimentId,
            experimentCaseId: caseIds[index],
            datasetCaseId: datasetCase.id,
            ordinal: index,
            status: 'submitted',
            adapterKey: 'swe-bench',
            clientId: `result-api-client-${suffix}`,
            publicPayloadJson: datasetCase.publicPayloadJson,
            privatePayloadJson: datasetCase.privatePayloadJson,
            runFactsJson: JSON.stringify({ traceId: `trace_result_${index}_${suffix}` }),
          },
        })
        await tx.benchmarkEvaluation.create({
          data: {
            id: evaluationIds[index],
            caseRunId: runIds[index],
            status: 'queued',
            adapterKey: 'swe-bench',
            evaluatorKey: 'swe-bench',
            requestJson: '{}',
            requestDigest: `sha256:${String(index).repeat(64)}`,
            callbackBaseUrl: `${origin}/api/benchmark/v1/evaluations/${evaluationIds[index]}`,
            timeoutSeconds: 60,
          },
        })
      }
    })

    const uploadEvidence = async (evaluationId: string, content: string) => {
      const bytes = Buffer.from(content)
      const form = new FormData()
      form.set('metadata', JSON.stringify({
        evaluationId,
        name: 'report.json',
        kind: 'official-report',
        mediaType: 'application/json',
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      }))
      form.set('file', new Blob([bytes]), 'report.json')
      const response = await fetch(`${origin}/api/benchmark/v1/evaluations/${evaluationId}/artifacts`, {
        method: 'POST',
        body: form,
      })
      assert.equal(response.status, 201)
      return await response.json() as { artifactId: string }
    }
    const evidenceA = await uploadEvidence(evaluationIds[0], '{"resolved":false}')
    const validCompletion = {
      status: 'completed',
      rawResult: {
        instanceId,
        resolved: false,
        patchSuccessfullyApplied: true,
        failToPass: { passed: 0, total: 1 },
        passToPass: { passed: 42, total: 42 },
        officialReport: { privateDetail: 'kept only in raw result' },
      },
      evidenceArtifactIds: [evidenceA.artifactId],
      runtimeFacts: { caseImage: 'fixture@sha256:digest' },
      cleanup: { status: 'succeeded' },
    }
    const completeA = () => fetch(`${origin}/api/benchmark/v1/evaluations/${evaluationIds[0]}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validCompletion),
    })
    const accepted = await completeA()
    assert.equal(accepted.status, 200)
    const acceptedBody = await accepted.json()
    assert.equal(acceptedBody.evaluationStatus, 'completed')
    assert.equal(acceptedBody.normalizationStatus, 'completed')
    const repeated = await completeA()
    assert.equal(repeated.status, 200)
    assert.deepEqual(await repeated.json(), acceptedBody)
    const conflict = await fetch(`${origin}/api/benchmark/v1/evaluations/${evaluationIds[0]}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validCompletion, cleanup: { status: 'changed' } }),
    })
    assert.equal(conflict.status, 409)

    const partial = await fetch(
      `${origin}/api/benchmark/v1/experiments/${experimentId}?user=${encodeURIComponent(dataset.user)}`,
    )
    assert.equal(partial.status, 200)
    const partialBody = await partial.json()
    assert.deepEqual(partialBody.progress, { total: 2, completed: 1, pending: 1, coverageRate: 50 })
    assert.deepEqual(partialBody.metrics.primary, {
      key: 'resolvedRate', value: 0, numerator: 0, denominator: 2,
    })
    assert.equal(partialBody.cases[0].nativeMetrics.officialReport, undefined)
    const storedA = await prisma.benchmarkEvaluation.findUnique({ where: { id: evaluationIds[0] } })
    assert.match(storedA?.rawResultJson || '', /privateDetail/)

    const evidenceB = await uploadEvidence(evaluationIds[1], '{"malformed":true}')
    const invalidCompletion = {
      status: 'completed',
      rawResult: { malformed: true },
      evidenceArtifactIds: [evidenceB.artifactId],
      runtimeFacts: {},
      cleanup: { status: 'succeeded' },
    }
    const invalid = await fetch(`${origin}/api/benchmark/v1/evaluations/${evaluationIds[1]}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalidCompletion),
    })
    assert.equal(invalid.status, 422)
    const invalidBody = await invalid.json()
    assert.equal(invalidBody.error.code, 'SWE_RAW_RESULT_INVALID')
    assert.equal(invalidBody.error.retryable, false)
    assert.equal(invalidBody.error.details.acceptedRawResult, true)
    const failedEvaluation = await prisma.benchmarkEvaluation.findUnique({ where: { id: evaluationIds[1] } })
    const failedRun = await prisma.benchmarkCaseRun.findUnique({ where: { id: runIds[1] } })
    assert.equal(failedEvaluation?.status, 'normalization_failed')
    assert.ok(failedEvaluation?.rawResultJson)
    assert.equal(failedRun?.status, 'evaluation_failed')

    const finalResponse = await fetch(
      `${origin}/api/benchmark/v1/experiments/${experimentId}?user=${encodeURIComponent(dataset.user)}&pageSize=1&page=2`,
    )
    assert.equal(finalResponse.status, 200)
    const finalBody = await finalResponse.json()
    assert.equal(finalBody.status, 'completed')
    assert.deepEqual(finalBody.progress, { total: 2, completed: 2, pending: 0, coverageRate: 100 })
    assert.deepEqual(finalBody.outcomes, { pass: 0, warn: 0, fail: 1, unknown: 1 })
    assert.deepEqual(finalBody.pagination, { page: 2, pageSize: 1, total: 2 })
    assert.equal(finalBody.cases[0].outcome, 'unknown')
    const unknownOnly = await fetch(
      `${origin}/api/benchmark/v1/experiments/${experimentId}?user=${encodeURIComponent(dataset.user)}&verdict=unknown`,
    )
    assert.equal((await unknownOnly.json()).pagination.total, 1)
    const serialized = JSON.stringify(finalBody)
    for (const hidden of ['privatePayloadJson', 'requestJson', 'goldPatch', 'testPatch', 'eval_script', 'storagePath', 'privateDetail']) {
      assert.equal(serialized.includes(hidden), false)
    }

    const evidenceResponse = await fetch(
      `${origin}${partialBody.cases[0].evidenceArtifacts[0].contentUrl}?user=${encodeURIComponent(dataset.user)}`,
    )
    assert.equal(evidenceResponse.status, 200)
    assert.equal(await evidenceResponse.text(), '{"resolved":false}')
    const forbidden = await fetch(
      `${origin}${partialBody.cases[0].evidenceArtifacts[0].contentUrl}?user=not-the-owner`,
    )
    assert.equal(forbidden.status, 404)
  } finally {
    await listener.close()
    await prisma.experiment.deleteMany({ where: { id: experimentId } })
    for (const directory of evidenceDirs) {
      await fsp.rm(directory, { recursive: true, force: true })
    }
    await prisma.$disconnect()
  }
})

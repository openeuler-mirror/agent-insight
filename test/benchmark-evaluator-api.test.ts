import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { sendImagePreparationWindow } from '../src/lib/benchmark/image-preparation'

const {
  BenchmarkEvaluatorService,
  evaluationDispatchDigest,
} = require('../services/evaluator/src/service.cjs') as {
  BenchmarkEvaluatorService: new (options: Record<string, unknown>) => {
    createServer(): http.Server
    recover(): Promise<number>
    journal: {
      state(runId: string): Promise<Record<string, unknown> | null>
      result(runId: string): Promise<Record<string, unknown> | null>
    }
  }
  evaluationDispatchDigest(request: Record<string, unknown>): string
}

const { EvaluatorRegistry } = require('../services/evaluator/src/evaluator-registry.cjs') as {
  EvaluatorRegistry: new (evaluators: unknown[]) => unknown
}
const { runEntrypoint } = require('../services/evaluator/src/evaluator-registry.cjs') as {
  runEntrypoint(
    descriptor: Record<string, unknown>,
    args: string[],
    options: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string }>
}
const { runProcess } = require('../benchmarks/swe-bench/evaluator/index.cjs') as {
  runProcess(
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string }>
}
const { AgentInsightPlatformClient, PlatformClientError } = require('../services/evaluator/src/platform-client.cjs') as {
  AgentInsightPlatformClient: new (
    fetchImpl: typeof fetch,
    platformBaseUrl?: string,
  ) => {
    downloadArtifact(request: Record<string, unknown>, descriptor: Record<string, unknown>): Promise<Buffer>
    progress(request: Record<string, unknown>, event: Record<string, unknown>): Promise<unknown>
    complete(request: Record<string, unknown>, completion: Record<string, unknown>): Promise<unknown>
  }
  PlatformClientError: new (code: string, message: string, status: number, retryable: boolean) => Error
}

test('Evaluator platform requests use its deployment-specific Agent Insight address', async () => {
  const requestedUrls: string[] = []
  const client = new AgentInsightPlatformClient(async (input) => {
    const url = String(input)
    requestedUrls.push(url)
    if (url.endsWith('/content')) return new Response('patch')
    return new Response('{"accepted":true,"desiredState":"continue"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }, 'http://119.3.152.42:3000/platform')

  const request = {
    runId: 'beval_remote_callback',
    platformBaseUrl: 'http://127.0.0.1:3000',
    callbackBaseUrl: 'http://127.0.0.1:3000/api/benchmark/v1/evaluations/beval_remote_callback',
  }
  const patch = Buffer.from('patch')

  assert.deepEqual(await client.downloadArtifact(request, {
    artifactId: 'artifact_remote_callback',
    name: 'model.patch',
    sizeBytes: patch.length,
    sha256: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
  }), patch)
  await client.progress(request, { stage: 'running_harness' })

  assert.deepEqual(requestedUrls, [
    'http://119.3.152.42:3000/platform/api/benchmark/v1/artifacts/artifact_remote_callback/content',
    'http://119.3.152.42:3000/platform/api/benchmark/v1/evaluations/beval_remote_callback/progress',
  ])
})

function listen(server: http.Server): Promise<{ origin: string; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done, failed) => server.close((error) => error ? failed(error) : done())),
      })
    })
  })
}

function requestFor(runId: string) {
  const request = {
    runId,
    evaluationJob: {
      protocolVersion: 'benchmark-evaluation/v1',
      evaluationId: runId,
      executionRunId: `erun_${runId}`,
      context: {
        experimentId: `exp_${runId}`,
        caseId: `case_${runId}`,
        datasetContentHash: `sha256:${'d'.repeat(64)}`,
      },
      benchmark: { key: 'swe-bench' },
      evaluator: { key: 'swe-bench' },
      artifacts: [{
        artifactId: `bart_${runId}`,
        executionRunId: `erun_${runId}`,
        name: 'model.patch',
        mediaType: 'text/x-diff',
        sha256: `sha256:${createHash('sha256').update('patch').digest('hex')}`,
        sizeBytes: 5,
      }],
      payload: {
        instance: {
          instance_id: 'pallets__flask-5014',
          repo: 'pallets/flask',
          base_commit: 'a'.repeat(40),
          version: '2.3',
          image: 'swebench/sweb.eval.x86_64.pallets_1776_flask-5014:latest',
          eval_script: 'pytest -q',
          eval_type: 'pass_and_fail',
          log_parser: 'parse_log_pytest',
          FAIL_TO_PASS: ['tests/test_cli.py::test_routes_command'],
          PASS_TO_PASS: ['tests/test_basic.py::test_basic'],
        },
        prediction: {
          instance_id: 'pallets__flask-5014',
          model_name_or_path: 'deepseek/deepseek-v4-flash',
          model_patch_artifact_id: `bart_${runId}`,
        },
      },
      limits: { timeoutSeconds: 60, cpu: 1, memoryMiB: 1024 },
    },
    platformBaseUrl: 'http://agent-insight.test',
    callbackBaseUrl: `http://agent-insight.test/api/benchmark/v1/evaluations/${runId}`,
    timeoutSeconds: 60,
  }
  return { ...request, requestDigest: evaluationDispatchDigest(request) }
}

test('cancel API checks the frozen digest and acknowledges cleanup rather than receipt alone', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'evaluator-cancel-api-'))
  let cleaned = false
  const service = new BenchmarkEvaluatorService({ dataDir: directory, imagePoolConfig: { enabled: false },
    cleanupContainers: async () => ({ status: cleaned ? 'succeeded' : 'failed' }) }) as any
  await service.journal.accept({ runId: 'cancel-api-run', requestDigest: 'original-digest' })
  const listener = await listen(service.createServer())
  t.after(async () => { await listener.close(); await fsp.rm(directory, { recursive: true, force: true }) })
  const cancel = (requestDigest: string) => fetch(`${listener.origin}/api/v1/evaluations`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'cancel', runId: 'cancel-api-run', requestDigest }) })
  assert.equal((await cancel('wrong')).status, 409)
  assert.equal(await service.control.cancelled('cancel-api-run'), null)
  assert.equal((await (await cancel('original-digest')).json()).status, 'cancelling')
  cleaned = true
  assert.equal((await (await cancel('original-digest')).json()).status, 'cancelled')
  await assert.rejects(() => service.start('cancel-api-run'), /停止/)
})

function headers(request: ReturnType<typeof requestFor>) {
  return {
    'content-type': 'application/json',
    'idempotency-key': request.runId,
    'x-agent-insight-request-digest': request.requestDigest,
  }
}

test('platform client omits bearer credentials from callbacks', async () => {
  let authorization: string | null = 'not-called'
  const client = new AgentInsightPlatformClient(async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization')
    return new Response('{"accepted":true,"desiredState":"continue"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })

  await client.progress(
    { callbackBaseUrl: 'http://agent-insight.test/api/benchmark/v1/evaluations/veval_no_auth' },
    { stage: 'running_harness' },
  )
  assert.equal(authorization, null)
})

test('image preparation uses the existing endpoint with token validation even when evaluation is busy', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-pool-api-'))
  const windows: unknown[] = []
  const pool = { config: { prefetch: true }, arch: 'x86_64', async initialize() {}, async close() {},
    async updateWindow(...args: unknown[]) { windows.push(args); return { enabled: true, accepted: true } } }
  const evaluator = { key: 'fixture', benchmarkKey: 'fixture', describeImages: (payload: unknown) => [payload] }
  const service = new BenchmarkEvaluatorService({ dataDir: directory, imagePool: pool, imagePoolToken: 'test-secret',
    registry: new EvaluatorRegistry([evaluator]) }) as any
  service.active.set('busy', Promise.resolve())
  const listener = await listen(service.createServer())
  const previousToken = process.env.BENCHMARK_IMAGE_POOL_PREPARE_TOKEN
  try {
    const payload = { benchmarkKey: 'fixture', evaluatorKey: 'fixture', experimentId: 'test-experiment', revision: 1, cases: [] }
    process.env.BENCHMARK_IMAGE_POOL_PREPARE_TOKEN = 'wrong'
    await assert.rejects(sendImagePreparationWindow(payload, fetch, listener.origin), /403/)
    assert.equal(windows.length, 0)
    process.env.BENCHMARK_IMAGE_POOL_PREPARE_TOKEN = 'test-secret'
    await sendImagePreparationWindow(payload, fetch, listener.origin)
    assert.deepEqual(windows, [[{ benchmarkKey: 'fixture', experimentId: 'test-experiment' }, 1, []]])
    const tampered = await fetch(`${listener.origin}/api/v1/evaluations`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-insight-image-pool-token': 'test-secret' },
      body: JSON.stringify({ ...payload, operation: 'prepare-images', requestDigest: 'changed' }) })
    assert.equal(tampered.status, 422)
  } finally {
    if (previousToken === undefined) delete process.env.BENCHMARK_IMAGE_POOL_PREPARE_TOKEN
    else process.env.BENCHMARK_IMAGE_POOL_PREPARE_TOKEN = previousToken
    await listener.close()
    await fsp.rm(directory, { recursive: true, force: true })
  }
})

test('Controller passes frozen images to Runtime and releases protection only after successful cleanup', async (t) => {
  for (const cleanupSucceeded of [true, false]) {
    await t.test(String(cleanupSucceeded), async () => {
      const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-pool-lifecycle-'))
      const events: string[] = []
      const captured: any[] = []
      const prepared = { key: 'fixture-case', imageId: `sha256:${'a'.repeat(64)}`, pinnedImage: `fixture.example/image@sha256:${'b'.repeat(64)}` }
      const pool = { config: { prefetch: false }, arch: 'x86_64', async initialize() {}, async close() {},
        async acquire(_owner: unknown, specs: unknown[]) { events.push('acquire'); captured.push(specs); return [prepared] },
        async release() { events.push('release') } }
      let cleanupCount = 0
      const evaluator = { key: 'swe-bench',
        describeImages: () => [{ key: 'fixture-case', arch: 'x86_64', references: ['fixture.example/image:latest'] }],
        async evaluate(input: any) { events.push('evaluate'); assert.deepEqual(input.preparedImages, [prepared]);
          return { completion: { status: 'completed', rawResult: {}, runtimeFacts: {}, cleanup: { status: 'succeeded' } }, evidenceFiles: [] } } }
      const service = new BenchmarkEvaluatorService({ dataDir: directory, imagePool: pool,
        registry: new EvaluatorRegistry([evaluator]),
        cleanupContainers: async () => { events.push('cleanup'); return { status: ++cleanupCount === 1 || cleanupSucceeded ? 'succeeded' : 'failed' } },
        platformClient: { async downloadArtifact() { return Buffer.from('patch') }, async progress() {}, async complete() { events.push('complete') } },
      }) as any
      const request = requestFor('pool-lifecycle')
      try {
        await service.journal.accept(request)
        await service.execute(request.runId)
        assert.deepEqual(events, ['cleanup', 'acquire', 'evaluate', 'cleanup', ...(cleanupSucceeded ? ['release'] : []), 'complete'])
        const result = await service.journal.result(request.runId)
        assert.equal(typeof result.completion.runtimeFacts.imagePoolWaitMs, 'number')
        await service.acquireJobImages(request, evaluator, new AbortController().signal)
        assert.deepEqual(captured[1][0].references, [prepared.pinnedImage])
      } finally { await fsp.rm(directory, { recursive: true, force: true }) }
    })
  }
})

test('capacity failure completes one case and the same Controller can execute the next case', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pool-capacity-case-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const completions: any[] = []
  let acquisitions = 0
  let evaluated = 0
  const pool = { config: {}, arch: 'x86_64', async initialize() {}, async close() {}, async release() {},
    async acquire() {
      if (++acquisitions === 1) throw Object.assign(new Error('镜像准备空间不足'), { code: 'IMAGE_POOL_SPACE_LOW', retryable: false })
      return []
    } }
  const evaluator = { key: 'swe-bench', describeImages: () => [{ key: 'fixture', arch: 'x86_64', references: ['fixture.example/image:latest'] }],
    async evaluate() { evaluated++; return { completion: { status: 'completed', rawResult: {}, runtimeFacts: {}, cleanup: { status: 'succeeded' } }, evidenceFiles: [] } } }
  const service = new BenchmarkEvaluatorService({ dataDir: directory, imagePool: pool, registry: new EvaluatorRegistry([evaluator]),
    cleanupContainers: async () => ({ status: 'succeeded' }),
    platformClient: { async downloadArtifact() { return Buffer.from('patch') }, async progress() {},
      async uploadEvidence() { return { artifactId: 'beart_capacity', sha256: `sha256:${'a'.repeat(64)}`, size: 1 } },
      async complete(_request: any, result: any) { completions.push(result); return { accepted: true } } },
  }) as any
  for (const runId of ['capacity-failed', 'capacity-next']) {
    await service.journal.accept(requestFor(runId))
    await service.execute(runId)
  }
  assert.equal(completions[0].status, 'failed')
  assert.equal(completions[0].error.code, 'IMAGE_POOL_SPACE_LOW')
  assert.equal(completions[0].error.retryable, false)
  assert.equal(completions[1].status, 'completed')
  assert.equal(evaluated, 1)
})

test('platform client rejects malformed successful callback acknowledgements as retryable protocol errors', async () => {
  const responses = [
    new Response('not-json', { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response('{"accepted":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
  ]
  const client = new AgentInsightPlatformClient(async () => responses.shift()!)
  const request = {
    callbackBaseUrl: 'http://agent-insight.test/api/benchmark/v1/evaluations/veval_invalid_ack',
  }

  await assert.rejects(
    () => client.progress(request, { stage: 'running_harness' }),
    (error: any) => {
      assert.equal(error.code, 'PROGRESS_CALLBACK_RESPONSE_INVALID')
      assert.equal(error.status, 502)
      assert.equal(error.retryable, true)
      return true
    },
  )
  await assert.rejects(
    () => client.complete(request, {
      status: 'completed',
      rawResult: {},
      evidenceArtifactIds: [],
      runtimeFacts: {},
      cleanup: {},
    }),
    (error: any) => {
      assert.equal(error.code, 'COMPLETION_CALLBACK_RESPONSE_INVALID')
      assert.equal(error.status, 502)
      assert.equal(error.retryable, true)
      return true
    },
  )
})

test('platform client accepts only a terminal completion acknowledgement matching the submitted status', async () => {
  const client = new AgentInsightPlatformClient(async () => new Response(JSON.stringify({
    accepted: true,
    evaluationStatus: 'failed',
    normalizationStatus: 'completed',
    normalizedResult: { status: 'failed' },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))

  const acknowledgement = await client.complete(
    { callbackBaseUrl: 'http://agent-insight.test/api/benchmark/v1/evaluations/veval_valid_ack' },
    {
      status: 'failed',
      rawResult: {},
      evidenceArtifactIds: [],
      runtimeFacts: {},
      cleanup: {},
    },
  ) as Record<string, unknown>
  assert.equal(acknowledgement.evaluationStatus, 'failed')
})

test('aborted evaluator subprocesses fail with EVALUATION_TIMEOUT even when SIGTERM exits zero', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-timeout-'))
  const scriptPath = path.join(dataDir, 'exit-zero-on-term.cjs')
  await fsp.writeFile(scriptPath, [
    "const fs = require('node:fs')",
    "process.on('SIGTERM', () => process.exit(0))",
    "fs.writeFileSync(process.argv[2], 'ready')",
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  try {
    const runners = [
      {
        name: 'file evaluator entrypoint',
        invoke: (markerPath: string, signal: AbortSignal) => runEntrypoint(
          { command: 'direct', entrypoint: process.execPath },
          [scriptPath, markerPath],
          { signal, killGraceMs: 100 },
        ),
      },
      {
        name: 'SWE-bench process runner',
        invoke: (markerPath: string, signal: AbortSignal) => runProcess(
          process.execPath,
          [scriptPath, markerPath],
          { signal, killGraceMs: 100 },
        ),
      },
    ]
    for (const [index, runner] of runners.entries()) {
      await t.test(runner.name, async () => {
        const markerPath = path.join(dataDir, `ready-${index}`)
        const abortController = new AbortController()
        const execution = runner.invoke(markerPath, abortController.signal)
        await waitFor(() => fs.existsSync(markerPath))
        abortController.abort()
        await assert.rejects(execution, (error: any) => {
          assert.equal(error.code, 'EVALUATION_TIMEOUT')
          assert.equal(error.status, 504)
          assert.equal(error.retryable, true)
          return true
        })
      })
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('evaluator service converts a late successful output into an EVALUATION_TIMEOUT completion', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-deadline-'))
  const completions: Array<Record<string, any>> = []
  const evaluator = {
    key: 'swe-bench',
    async checkReady() { return { ready: true } },
    validateJob() {},
    async evaluate(input: { workDir: string }) {
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      const evidence = path.join(input.workDir, 'late-report.json')
      await fsp.writeFile(evidence, '{"resolved":true}')
      return {
        completion: {
          status: 'completed',
          rawResult: { resolved: true },
          runtimeFacts: {},
          cleanup: { status: 'succeeded' },
        },
        evidenceFiles: [{
          name: 'late-report.json', kind: 'official-report', mediaType: 'application/json', path: evidence,
        }],
      }
    },
  }
  const platform = {
    async downloadArtifact() { return Buffer.from('patch') },
    async progress() { return { accepted: true } },
    async uploadEvidence(_request: unknown, evidence: { path: string }) {
      const bytes = fs.readFileSync(evidence.path)
      return {
        artifactId: 'beart_timeout',
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.length,
      }
    },
    async complete(_request: unknown, completion: Record<string, any>) {
      completions.push(completion)
      return { accepted: true }
    },
  }
  const service = new BenchmarkEvaluatorService({
    imagePoolConfig: { enabled: false },
    dataDir,
    platformClient: platform,
    registry: new EvaluatorRegistry([evaluator]),
    cleanupContainers: async () => ({ status: 'succeeded', removedContainerIds: [] }),
  })
  const listener = await listen(service.createServer())
  const request = requestFor(`veval_deadline_${Date.now()}`)
  request.timeoutSeconds = 1
  request.evaluationJob.limits.timeoutSeconds = 1
  request.requestDigest = evaluationDispatchDigest(request)
  try {
    assert.equal((await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST', headers: headers(request), body: JSON.stringify(request),
    })).status, 202)
    await waitFor(async () => (
      completions.length === 1
      && (await service.journal.state(request.runId))?.stage === 'failed'
    ))
    assert.equal(completions[0].status, 'failed')
    assert.equal(completions[0].error.code, 'EVALUATION_TIMEOUT')
    assert.equal(completions[0].error.retryable, true)
    assert.equal((await service.journal.state(request.runId))?.stage, 'failed')
  } finally {
    await listener.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('invalid successful completion acknowledgement keeps the local journal callback_pending', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-ack-journal-'))
  const callbackClient = new AgentInsightPlatformClient(async () => new Response('not-json', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  }))
  const evaluator = {
    key: 'swe-bench',
    async checkReady() { return { ready: true } },
    validateJob() {},
    async evaluate(input: { workDir: string }) {
      const evidence = path.join(input.workDir, 'report.json')
      await fsp.writeFile(evidence, '{"resolved":false}')
      return {
        completion: {
          status: 'completed', rawResult: { resolved: false }, runtimeFacts: {}, cleanup: {},
        },
        evidenceFiles: [{
          name: 'report.json', kind: 'official-report', mediaType: 'application/json', path: evidence,
        }],
      }
    },
  }
  const platform = {
    async downloadArtifact() { return Buffer.from('patch') },
    async progress() { return { accepted: true } },
    async uploadEvidence(_request: unknown, evidence: { path: string }) {
      const bytes = fs.readFileSync(evidence.path)
      return {
        artifactId: 'beart_invalid_ack',
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.length,
      }
    },
    complete: callbackClient.complete.bind(callbackClient),
  }
  const service = new BenchmarkEvaluatorService({
    imagePoolConfig: { enabled: false },
    dataDir,
    platformClient: platform,
    registry: new EvaluatorRegistry([evaluator]),
    cleanupContainers: async () => ({ status: 'succeeded', removedContainerIds: [] }),
  }) as any
  service.scheduleCallbackRetry = () => {}
  const listener = await listen(service.createServer())
  const request = requestFor(`veval_invalid_ack_${Date.now()}`)
  try {
    assert.equal((await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST', headers: headers(request), body: JSON.stringify(request),
    })).status, 202)
    await waitFor(async () => (
      (await service.journal.state(request.runId))?.callbackErrorCode
      === 'COMPLETION_CALLBACK_RESPONSE_INVALID'
    ))
    const state = await service.journal.state(request.runId)
    assert.equal(state.callbackErrorCode, 'COMPLETION_CALLBACK_RESPONSE_INVALID')
    assert.equal(state.callbackRetryable, true)
    assert.equal(state.completedAt, undefined)
  } finally {
    await listener.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

test('step 09 evaluator HTTP API journals, executes and replays idempotently without app authentication', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-api-'))
  const completions: Array<Record<string, unknown>> = []
  let failFirstCompletion = true
  let evaluatorRuns = 0
  let cleanupCalls = 0
  const evaluator = {
    key: 'swe-bench',
    async checkReady() { return { ready: true } },
    validateJob(job: { evaluator: { key: string } }) { assert.equal(job.evaluator.key, 'swe-bench') },
    async evaluate(input: { workDir: string }) {
      evaluatorRuns += 1
      const evidence = path.join(input.workDir, 'report.json')
      await fsp.writeFile(evidence, '{"resolved":false}\n')
      return {
        completion: {
          status: 'completed',
          rawResult: {
            instanceId: 'pallets__flask-5014',
            resolved: false,
            patchSuccessfullyApplied: true,
            failToPass: { passed: 0, total: 1 },
            passToPass: { passed: 1, total: 1 },
          },
          runtimeFacts: { caseImage: 'fixture@sha256:digest', formalEligible: false },
          cleanup: { status: 'succeeded' },
        },
        evidenceFiles: [{
          name: 'report.json',
          kind: 'official-report',
          mediaType: 'application/json',
          path: evidence,
        }],
      }
    },
  }
  const platform = {
    async downloadArtifact() { return Buffer.from('patch') },
    async progress() { return { accepted: true } },
    async uploadEvidence(_request: unknown, evidence: { path: string }) {
      assert.equal(fs.existsSync(evidence.path), true)
      return {
        artifactId: 'beart_report',
        sha256: `sha256:${createHash('sha256').update(fs.readFileSync(evidence.path)).digest('hex')}`,
        size: fs.statSync(evidence.path).size,
      }
    },
    async complete(_request: unknown, completion: Record<string, unknown>) {
      completions.push(completion)
      if (failFirstCompletion) {
        failFirstCompletion = false
        throw Object.assign(new Error('temporary callback disconnect'), {
          code: 'COMPLETION_CALLBACK_FAILED', status: 502, retryable: true,
        })
      }
      return { accepted: true }
    },
  }
  const service = new BenchmarkEvaluatorService({
    imagePoolConfig: { enabled: false },
    dataDir,
    platformClient: platform,
    registry: new EvaluatorRegistry([evaluator]),
    controllerProbe: async () => ({ dockerArch: 'x86_64', dockerOSType: 'linux' }),
    cleanupContainers: async () => {
      cleanupCalls += 1
      return { status: 'succeeded', removedContainerIds: [] }
    },
  })
  const listener = await listen(service.createServer())
  const request = requestFor(`veval_api_${Date.now()}`)
  try {
    const health = await fetch(`${listener.origin}/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).status, 'healthy')

    const accepted = await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST',
      headers: headers(request),
      body: JSON.stringify(request),
    })
    assert.equal(accepted.status, 202)
    assert.equal((await accepted.json()).requestDigest, request.requestDigest)
    await waitFor(async () => (
      completions.length === 2
      && (await service.journal.state(request.runId))?.stage === 'completed'
    ))
    assert.equal(evaluatorRuns, 1)
    assert.equal(completions[0].status, 'completed')
    assert.deepEqual(completions[0].evidenceArtifactIds, ['beart_report'])
    assert.deepEqual(completions[0].cleanup, {
      evaluator: { status: 'succeeded' },
      controller: { status: 'succeeded', removedContainerIds: [] },
    })
    assert.deepEqual(completions[1], completions[0])
    assert.equal(cleanupCalls, 2)
    assert.equal((await service.journal.state(request.runId))?.stage, 'completed')
    assert.ok((await service.journal.result(request.runId))?.completion)

    const replay = await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST',
      headers: headers(request),
      body: JSON.stringify(request),
    })
    assert.equal(replay.status, 202)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(evaluatorRuns, 1)

    const changed = requestFor(request.runId)
    changed.evaluationJob.payload.instance.eval_script = 'pytest tests -q'
    changed.requestDigest = evaluationDispatchDigest(changed)
    const conflict = await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST',
      headers: headers(changed),
      body: JSON.stringify(changed),
    })
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json()).error.code, 'RUN_ID_CONFLICT')
  } finally {
    await listener.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('step 11 non-retryable normalization rejection stops callback replay without rerunning Harness', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-nonretryable-'))
  let evaluatorRuns = 0
  let completionCalls = 0
  const evaluator = {
    key: 'swe-bench',
    async checkReady() { return { ready: true } },
    validateJob() {},
    async evaluate(input: { workDir: string }) {
      evaluatorRuns += 1
      const evidence = path.join(input.workDir, 'report.json')
      await fsp.writeFile(evidence, '{}')
      return {
        completion: {
          status: 'completed',
          rawResult: { malformed: true },
          runtimeFacts: {},
          cleanup: { status: 'succeeded' },
        },
        evidenceFiles: [{ name: 'report.json', kind: 'report', mediaType: 'application/json', path: evidence }],
      }
    },
  }
  const platform = {
    async downloadArtifact() { return Buffer.from('patch') },
    async progress() {},
    async uploadEvidence(_request: unknown, evidence: { path: string }) {
      const bytes = fs.readFileSync(evidence.path)
      return {
        artifactId: 'beart_nonretryable',
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.length,
      }
    },
    async complete() {
      completionCalls += 1
      throw new PlatformClientError(
        'RAW_RESULT_SCHEMA_INVALID',
        'raw result rejected after persistence',
        422,
        false,
      )
    },
  }
  const service = new BenchmarkEvaluatorService({
    imagePoolConfig: { enabled: false },
    dataDir,
    platformClient: platform,
    registry: new EvaluatorRegistry([evaluator]),
    cleanupContainers: async () => ({ status: 'succeeded', removedContainerIds: [] }),
  })
  const listener = await listen(service.createServer())
  const request = requestFor(`veval_nonretryable_${Date.now()}`)
  try {
    assert.equal((await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST', headers: headers(request), body: JSON.stringify(request),
    })).status, 202)
    await waitFor(async () => (await service.journal.state(request.runId))?.stage === 'failed')
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    const state = await service.journal.state(request.runId)
    assert.equal(evaluatorRuns, 1)
    assert.equal(completionCalls, 1)
    assert.equal(state?.callbackErrorCode, 'RAW_RESULT_SCHEMA_INVALID')
    assert.equal(state?.callbackRetryable, false)
  } finally {
    await listener.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('step 10 preserves a valid judgment and records Controller cleanup failure', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-cleanup-'))
  const completions: Array<Record<string, any>> = []
  let cleanupCalls = 0
  const evaluator = {
    key: 'swe-bench',
    async checkReady() { return { ready: true } },
    validateJob() {},
    async evaluate(input: { workDir: string }) {
      const evidence = path.join(input.workDir, 'report.json')
      await fsp.writeFile(evidence, '{}')
      return {
        completion: {
          status: 'completed',
          rawResult: { resolved: true },
          runtimeFacts: {},
          cleanup: { status: 'succeeded' },
        },
        evidenceFiles: [{ name: 'report.json', kind: 'report', mediaType: 'application/json', path: evidence }],
      }
    },
  }
  const platform = {
    async downloadArtifact() { return Buffer.from('patch') },
    async progress() {},
    async uploadEvidence(_request: unknown, evidence: { path: string }) {
      const bytes = fs.readFileSync(evidence.path)
      return {
        artifactId: 'beart_cleanup',
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.length,
      }
    },
    async complete(_request: unknown, completion: Record<string, unknown>) {
      completions.push(completion)
    },
  }
  const service = new BenchmarkEvaluatorService({
    imagePoolConfig: { enabled: false },
    dataDir,
    platformClient: platform,
    registry: new EvaluatorRegistry([evaluator]),
    cleanupContainers: async () => {
      cleanupCalls += 1
      return cleanupCalls === 1
        ? { status: 'succeeded', removedContainerIds: [] }
        : { status: 'failed', errors: ['daemon disconnected'] }
    },
  })
  const listener = await listen(service.createServer())
  const request = requestFor(`veval_cleanup_${Date.now()}`)
  try {
    assert.equal((await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST', headers: headers(request), body: JSON.stringify(request),
    })).status, 202)
    await waitFor(() => completions.length === 1)
    assert.equal(completions[0].status, 'completed')
    assert.equal(completions[0].error, undefined)
    assert.deepEqual(completions[0].cleanup.controller, {
      status: 'failed', errors: ['daemon disconnected'],
    })
  } finally {
    await listener.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('step 09 rejects a second evaluation while the single slot is busy', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-busy-'))
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const evaluator = {
    key: 'swe-bench',
    async checkReady() { return { ready: true } },
    validateJob() {},
    async evaluate(input: { workDir: string }) {
      await gate
      const evidence = path.join(input.workDir, 'report.json')
      await fsp.writeFile(evidence, '{}')
      return {
        completion: {
          status: 'failed', rawResult: { resolved: false }, runtimeFacts: {}, cleanup: {},
          error: { code: 'TEST_END', message: 'test ended', retryable: false },
        },
        evidenceFiles: [{ name: 'report.json', kind: 'report', mediaType: 'application/json', path: evidence }],
      }
    },
  }
  const platform = {
    async downloadArtifact() { return Buffer.from('patch') },
    async progress() {},
    async uploadEvidence(_request: unknown, evidence: { path: string }) {
      const bytes = fs.readFileSync(evidence.path)
      return { artifactId: 'beart_busy', sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length }
    },
    async complete() {},
  }
  const service = new BenchmarkEvaluatorService({
    imagePoolConfig: { enabled: false },
    dataDir,
    platformClient: platform,
    registry: new EvaluatorRegistry([evaluator]),
    cleanupContainers: async () => ({ status: 'succeeded', removedContainerIds: [] }),
  })
  const listener = await listen(service.createServer())
  const first = requestFor(`veval_busy_1_${Date.now()}`)
  const second = requestFor(`veval_busy_2_${Date.now()}`)
  try {
    assert.equal((await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST', headers: headers(first), body: JSON.stringify(first),
    })).status, 202)
    const busy = await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST', headers: headers(second), body: JSON.stringify(second),
    })
    assert.equal(busy.status, 409)
    const body = await busy.json()
    assert.equal(body.error.code, 'SERVICE_BUSY')
    assert.equal(body.error.retryable, true)
  } finally {
    release()
    await waitFor(async () => ['failed', 'completed'].includes(
      String((await service.journal.state(first.runId))?.stage || ''),
    ))
    await listener.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

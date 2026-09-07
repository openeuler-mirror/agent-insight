import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

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
const { PlatformClientError } = require('../services/evaluator/src/platform-client.cjs') as {
  PlatformClientError: new (code: string, message: string, status: number, retryable: boolean) => Error
}

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

function headers(token: string, request: ReturnType<typeof requestFor>) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'idempotency-key': request.runId,
    'x-agent-insight-request-digest': request.requestDigest,
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

test('step 09 evaluator HTTP API authenticates, journals, executes and replays idempotently', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-api-'))
  const token = 'evaluator-controller-api-token'
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
    dataDir,
    token,
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
    const unauthorized = await fetch(`${listener.origin}/health`)
    assert.equal(unauthorized.status, 401)

    const health = await fetch(`${listener.origin}/health`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(health.status, 200)
    assert.equal((await health.json()).status, 'healthy')

    const accepted = await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST',
      headers: headers(token, request),
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
      headers: headers(token, request),
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
      headers: headers(token, changed),
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
  const token = 'evaluator-controller-nonretryable-token'
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
    dataDir,
    token,
    platformClient: platform,
    registry: new EvaluatorRegistry([evaluator]),
    cleanupContainers: async () => ({ status: 'succeeded', removedContainerIds: [] }),
  })
  const listener = await listen(service.createServer())
  const request = requestFor(`veval_nonretryable_${Date.now()}`)
  try {
    assert.equal((await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST', headers: headers(token, request), body: JSON.stringify(request),
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
  const token = 'evaluator-controller-cleanup-token'
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
    dataDir,
    token,
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
      method: 'POST', headers: headers(token, request), body: JSON.stringify(request),
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
  const token = 'evaluator-controller-busy-token'
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
    dataDir,
    token,
    platformClient: platform,
    registry: new EvaluatorRegistry([evaluator]),
    cleanupContainers: async () => ({ status: 'succeeded', removedContainerIds: [] }),
  })
  const listener = await listen(service.createServer())
  const first = requestFor(`veval_busy_1_${Date.now()}`)
  const second = requestFor(`veval_busy_2_${Date.now()}`)
  try {
    assert.equal((await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST', headers: headers(token, first), body: JSON.stringify(first),
    })).status, 202)
    const busy = await fetch(`${listener.origin}/api/v1/evaluations`, {
      method: 'POST', headers: headers(token, second), body: JSON.stringify(second),
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

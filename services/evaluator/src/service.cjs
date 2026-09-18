'use strict'

const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')

const { generatedEvaluatorDescriptors } = require('../../../generated/benchmark-catalog/evaluators.cjs')
const {
  evaluationTimeoutError,
  EvaluatorProtocolError,
  EvaluatorRegistry,
  FileEvaluatorEntrypoint,
} = require('./evaluator-registry.cjs')
const { EvaluationJobJournal } = require('./job-journal.cjs')
const { AgentInsightPlatformClient, PlatformClientError, sha256 } = require('./platform-client.cjs')

const ACTIVE_STAGES = new Set([
  'accepted',
  'downloading_artifacts',
  'preparing_runtime',
  'resolving_image',
  'running_harness',
  'collecting_evidence',
  'uploading_evidence',
  'cleaning',
  'callback_pending',
])

function normalizedJson(value) {
  if (Array.isArray(value)) return value.map(normalizedJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizedJson(item)]),
    )
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(normalizedJson(value))
}

function evaluationDispatchDigest(request) {
  return sha256(Buffer.from(canonicalJson({
    runId: request.runId,
    evaluationJob: request.evaluationJob,
    platformBaseUrl: request.platformBaseUrl,
    callbackBaseUrl: request.callbackBaseUrl,
    timeoutSeconds: request.timeoutSeconds,
  })))
}

function evaluatorError(code, message, status = 422, retryable = false) {
  return new EvaluatorProtocolError(code, message, status, retryable)
}

function validateOriginUrl(value, code) {
  let url
  try { url = new URL(value) } catch { throw evaluatorError(code, 'URL 不合法', 422) }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw evaluatorError(code, 'URL 必须是无凭证、query 和 fragment 的 HTTP(S) 地址', 422)
  }
  return url
}

function validateRequest(request, headers) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw evaluatorError('EVALUATION_REQUEST_INVALID', '评测请求格式不合法', 400)
  }
  if (
    !/^[A-Za-z0-9_-]{1,160}$/.test(String(request.runId || ''))
    || request.evaluationJob?.evaluationId !== request.runId
    || request.evaluationJob?.limits?.timeoutSeconds !== request.timeoutSeconds
    || !Number.isInteger(request.timeoutSeconds)
    || request.timeoutSeconds < 1
    || request.timeoutSeconds > 86_400
    || !/^sha256:[0-9a-f]{64}$/i.test(String(request.requestDigest || ''))
  ) {
    throw evaluatorError('EVALUATION_REQUEST_INVALID', '评测请求字段不合法', 400)
  }
  const platform = validateOriginUrl(request.platformBaseUrl, 'PLATFORM_URL_INVALID')
  const callback = validateOriginUrl(request.callbackBaseUrl, 'CALLBACK_URL_INVALID')
  const expected = new URL(
    `${request.platformBaseUrl.replace(/\/$/, '')}/api/benchmark/v1/evaluations/${encodeURIComponent(request.runId)}`,
  )
  if (
    platform.origin !== callback.origin
    || callback.origin !== expected.origin
    || callback.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')
  ) {
    throw evaluatorError('CALLBACK_URL_FORBIDDEN', '回调地址与平台 evaluation 不匹配', 403)
  }
  const expectedDigest = evaluationDispatchDigest(request)
  if (
    request.requestDigest !== expectedDigest
    || headers['x-agent-insight-request-digest'] !== expectedDigest
    || headers['idempotency-key'] !== request.runId
  ) {
    throw evaluatorError('REQUEST_DIGEST_MISMATCH', '评测请求摘要或幂等键不匹配', 422)
  }
}

function readJson(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(evaluatorError('REQUEST_TOO_LARGE', '评测请求超过大小限制', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(evaluatorError('REQUEST_JSON_INVALID', '请求不是合法 JSON', 400)) }
    })
    req.on('error', reject)
  })
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function errorResponse(res, error) {
  const known = error instanceof EvaluatorProtocolError || error instanceof PlatformClientError
  if (!known) console.error('[benchmark/evaluator]', error)
  json(res, known ? error.status : 500, {
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : '评测服务内部错误',
      retryable: known ? error.retryable : false,
    },
  })
}

function removeLabeledContainers(evaluationId) {
  return new Promise((resolve) => {
    const query = spawn('docker', [
      'ps', '-aq', '--filter', `label=agent-insight.evaluation-id=${evaluationId}`,
    ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let errorOutput = ''
    query.stdout.on('data', (chunk) => { output += String(chunk) })
    query.stderr.on('data', (chunk) => { errorOutput += String(chunk) })
    query.on('error', (error) => resolve({ status: 'failed', errors: [error.message] }))
    query.on('close', (code) => {
      if (code !== 0) {
        return resolve({
          status: 'failed',
          errors: [(errorOutput || `docker ps exited with ${code}`).trim().slice(-2000)],
        })
      }
      const ids = output.split(/\s+/).filter(Boolean)
      if (!ids.length) return resolve({ status: 'succeeded', removedContainerIds: [] })
      const cleanup = spawn('docker', ['rm', '-f', ...ids], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let cleanupError = ''
      cleanup.stderr.on('data', (chunk) => { cleanupError += String(chunk) })
      cleanup.on('error', (error) => resolve({ status: 'failed', errors: [error.message] }))
      cleanup.on('close', (cleanupCode) => resolve(cleanupCode === 0
        ? { status: 'succeeded', removedContainerIds: ids }
        : {
            status: 'failed',
            errors: [(cleanupError || `docker rm exited with ${cleanupCode}`).trim().slice(-2000)],
          }))
    })
  })
}

function normalizeArchitecture(value) {
  const architecture = String(value || '').trim().toLowerCase()
  if (['amd64', 'x86_64'].includes(architecture)) return 'x86_64'
  if (['arm64', 'aarch64'].includes(architecture)) return 'arm64'
  return architecture || 'unknown'
}

function dockerInfo() {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['info', '--format', '{{json .}}'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error((stderr || `docker info exited with ${code}`).trim()))
      try {
        const info = JSON.parse(stdout.trim() || '{}')
        resolve({
          dockerArch: normalizeArchitecture(info.Architecture),
          dockerOSType: String(info.OSType || ''),
          dockerServerVersion: String(info.ServerVersion || ''),
        })
      } catch {
        reject(new Error('docker info 返回内容不合法'))
      }
    })
  })
}

async function defaultControllerProbe(dataDir) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const probePath = path.join(dataDir, `.controller-probe-${process.pid}-${Date.now()}`)
  await fs.writeFile(probePath, 'ok\n', { mode: 0o600 })
  await fs.rm(probePath, { force: true })
  return dockerInfo()
}

class BenchmarkEvaluatorService {
  constructor(options = {}) {
    this.dataDir = options.dataDir || process.env.EVALUATOR_DATA_DIR || '/data'
    this.platformBaseUrl = options.platformBaseUrl || process.env.EVALUATOR_AGENT_INSIGHT_BASE_URL || ''
    this.maxConcurrency = Number(options.maxConcurrency || process.env.EVALUATOR_MAX_CONCURRENCY || 1)
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency !== 1) {
      throw new Error('EVALUATOR_MAX_CONCURRENCY currently must be 1')
    }
    this.journal = options.journal || new EvaluationJobJournal(this.dataDir)
    this.platform = options.platformClient || new AgentInsightPlatformClient(
      fetch,
      this.platformBaseUrl,
    )
    this.registry = options.registry || new EvaluatorRegistry(
      generatedEvaluatorDescriptors.map((descriptor) => new FileEvaluatorEntrypoint(descriptor)),
    )
    this.cleanupContainers = options.cleanupContainers || removeLabeledContainers
    this.controllerProbe = options.controllerProbe || defaultControllerProbe
    this.active = new Map()
    this.retryAttempts = new Map()
    this.readiness = null
  }

  async evaluatorHealth() {
    if (this.readiness && this.readiness.expiresAt > Date.now()) return this.readiness.value
    const reports = await Promise.all(this.registry.values().map(async (evaluator) => ({
      key: evaluator.key,
      benchmarkKey: evaluator.descriptor?.benchmarkKey || '*',
      ...await evaluator.checkReady({
        dataDir: this.dataDir,
        hostOS: process.env.EVALUATOR_HOST_OS || process.platform,
        hostArch: process.env.EVALUATOR_HOST_ARCH || normalizeArchitecture(process.arch),
      }),
    })))
    const byKey = new Map()
    for (const report of reports) {
      const current = byKey.get(report.key) || {
        key: report.key,
        ready: true,
        formalEligible: true,
        bindings: [],
      }
      current.ready = current.ready && report.ready === true
      current.formalEligible = current.formalEligible && report.formalEligible !== false
      current.bindings.push({
        benchmarkKey: report.benchmarkKey,
        ready: report.ready === true,
        formalEligible: report.formalEligible !== false,
        ...(report.reason ? { reason: report.reason } : {}),
        ...(report.runtimeFacts ? { runtimeFacts: report.runtimeFacts } : {}),
      })
      byKey.set(report.key, current)
    }
    const value = [...byKey.values()].map((report) => {
      const failedBindings = report.bindings.filter((binding) => !binding.ready)
      const reason = failedBindings.length === 1 && failedBindings[0].benchmarkKey === '*'
        ? failedBindings[0].reason || 'not ready'
        : failedBindings.map((binding) => (
            `${binding.benchmarkKey}: ${binding.reason || 'not ready'}`
          )).join('; ')
      return {
        ...report,
        ...(report.ready ? {} : { reason }),
      }
    })
    this.readiness = { value, expiresAt: Date.now() + 10_000 }
    return value
  }

  runtimeFacts(extra = {}) {
    return {
      ...extra,
      hostOS: process.env.EVALUATOR_HOST_OS || process.platform,
      hostArch: process.env.EVALUATOR_HOST_ARCH || normalizeArchitecture(process.arch),
      sourceRevision: process.env.EVALUATOR_SOURCE_REVISION || 'unknown',
      sourceDirty: String(process.env.EVALUATOR_SOURCE_DIRTY || 'false').toLowerCase() === 'true',
      controllerImageId: process.env.EVALUATOR_CONTROLLER_IMAGE_ID || 'unknown',
      platformBaseUrlConfigured: Boolean(this.platformBaseUrl),
    }
  }

  async healthReport() {
    let controller
    try {
      const runtime = await this.controllerProbe(this.dataDir)
      controller = { ready: true, runtimeFacts: runtime || {} }
    } catch (error) {
      controller = {
        ready: false,
        reason: error instanceof Error ? error.message : String(error),
        runtimeFacts: {},
      }
    }
    return {
      status: controller.ready ? 'healthy' : 'degraded',
      busy: await this.hasBusyJob(),
      runtime: this.runtimeFacts(controller.runtimeFacts),
      controller: {
        ready: controller.ready,
        ...(controller.reason ? { reason: controller.reason } : {}),
      },
      evaluators: await this.evaluatorHealth(),
    }
  }

  async hasBusyJob(exceptRunId) {
    if ([...this.active.keys()].some((runId) => runId !== exceptRunId)) return true
    for (const runId of await this.journal.listRunIds()) {
      if (runId === exceptRunId) continue
      const state = await this.journal.state(runId)
      if (ACTIVE_STAGES.has(state?.stage)) return true
    }
    return false
  }

  async reportProgress(request, event) {
    await this.journal.writeState(request.runId, { stage: event.stage, progress: event })
    try { await this.platform.progress(request, event) }
    catch (error) {
      await this.journal.writeState(request.runId, {
        progressCallbackError: error.message,
      })
    }
  }

  async downloadArtifacts(request) {
    const local = new Map()
    for (const descriptor of request.evaluationJob.artifacts) {
      const bytes = await this.platform.downloadArtifact(request, descriptor)
      const artifactPath = await this.journal.writeArtifact(request.runId, descriptor.name, bytes)
      local.set(descriptor.name, {
        descriptor: {
          artifactId: descriptor.artifactId,
          evaluationId: request.runId,
          name: descriptor.name,
          kind: 'submission',
          mediaType: descriptor.mediaType,
          sha256: descriptor.sha256,
          sizeBytes: descriptor.sizeBytes,
        },
        path: artifactPath,
      })
    }
    return local
  }

  async fallbackResult(request, error) {
    const workDir = this.journal.jobDir(request.runId)
    const evidencePath = path.join(workDir, 'controller-error.json')
    await fs.writeFile(evidencePath, JSON.stringify({
      code: error.code || 'EVALUATOR_INTERNAL_ERROR',
      message: error.message,
    }, null, 2), { mode: 0o600 })
    return {
      completion: {
        status: 'failed',
        rawResult: {},
        runtimeFacts: this.runtimeFacts({ controllerArch: process.arch }),
        cleanup: { status: 'attempted' },
        error: {
          code: error.code || 'EVALUATOR_INTERNAL_ERROR',
          message: error.message || '评测服务内部错误',
          retryable: error.retryable !== false,
        },
      },
      evidenceFiles: [{
        name: 'controller-error.json',
        kind: 'controller-error',
        mediaType: 'application/json',
        path: evidencePath,
      }],
    }
  }

  async deliverResult(request, result) {
    await this.reportProgress(request, {
      kind: 'evaluation',
      stage: 'uploading_evidence',
      occurredAt: new Date().toISOString(),
    })
    const uploads = []
    for (const evidence of result.evidenceFiles) {
      uploads.push(await this.platform.uploadEvidence(request, evidence))
    }
    const completion = {
      ...result.completion,
      evidenceArtifactIds: uploads.map((item) => item.artifactId),
    }
    await this.journal.writeResult(request.runId, { completion })
    await this.journal.writeState(request.runId, { stage: 'callback_pending' })
    await this.platform.complete(request, completion)
    await this.journal.writeState(request.runId, {
      stage: completion.status === 'failed' ? 'failed' : 'completed',
      completedAt: new Date().toISOString(),
      callbackError: null,
      callbackErrorCode: null,
      callbackRetryable: null,
    })
    this.retryAttempts.delete(request.runId)
  }

  scheduleCallbackRetry(runId) {
    const attempt = (this.retryAttempts.get(runId) || 0) + 1
    this.retryAttempts.set(runId, attempt)
    const timer = setTimeout(() => {
      void this.start(runId).catch((error) => {
        console.error('[benchmark/evaluator] callback retry failed', error)
      })
    }, Math.min(60_000, 1_000 * (2 ** Math.min(attempt, 6))))
    timer.unref?.()
  }

  async handleDeliveryFailure(runId, error) {
    if (error instanceof PlatformClientError && error.retryable === false) {
      await this.journal.writeState(runId, {
        stage: 'failed',
        completedAt: new Date().toISOString(),
        callbackError: error.message,
        callbackErrorCode: error.code,
        callbackRetryable: false,
      })
      this.retryAttempts.delete(runId)
      return
    }
    await this.journal.writeState(runId, {
      stage: 'callback_pending',
      callbackError: error instanceof Error ? error.message : String(error),
      callbackErrorCode: error?.code || 'CALLBACK_DELIVERY_FAILED',
      callbackRetryable: true,
    })
    this.scheduleCallbackRetry(runId)
  }

  async execute(runId) {
    const request = await this.journal.request(runId)
    if (!request) return
    const existingResult = await this.journal.result(runId)
    if (existingResult) {
      try {
        if (existingResult.evaluatorOutput) {
          await this.deliverResult(request, existingResult.evaluatorOutput)
          return
        }
        const completion = existingResult.completion
        await this.platform.complete(request, completion)
        await this.journal.writeState(runId, {
          stage: completion.status === 'failed' ? 'failed' : 'completed',
          completedAt: new Date().toISOString(),
          callbackError: null,
          callbackErrorCode: null,
          callbackRetryable: null,
        })
        this.retryAttempts.delete(runId)
      } catch (error) {
        await this.handleDeliveryFailure(runId, error)
      }
      return
    }

    const evaluator = this.registry.get(
      request.evaluationJob.evaluator.key,
      request.evaluationJob.benchmark.key,
    )
    const abortController = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      abortController.abort()
    }, request.timeoutSeconds * 1000)
    const assertWithinDeadline = () => {
      if (timedOut) throw evaluationTimeoutError()
    }
    let result
    try {
      const staleCleanup = await this.cleanupContainers(runId)
      if (staleCleanup.status !== 'succeeded') {
        throw evaluatorError(
          'EVALUATION_STALE_CONTAINER_CLEANUP_FAILED',
          `无法清理上次运行残留的 Case 容器：${(staleCleanup.errors || []).join('; ')}`,
          500,
          true,
        )
      }
      await this.reportProgress(request, {
        kind: 'evaluation',
        stage: 'downloading_artifacts',
        occurredAt: new Date().toISOString(),
      })
      const artifacts = await this.downloadArtifacts(request)
      assertWithinDeadline()
      result = await evaluator.evaluate({
        job: request.evaluationJob,
        artifacts,
        workDir: this.journal.jobDir(runId),
        signal: abortController.signal,
        reportProgress: (event) => this.reportProgress(request, event),
      })
      assertWithinDeadline()
      await this.reportProgress(request, {
        kind: 'evaluation',
        stage: 'collecting_evidence',
        occurredAt: new Date().toISOString(),
      })
      assertWithinDeadline()
    } catch (error) {
      result = await this.fallbackResult(request, timedOut ? evaluationTimeoutError() : error)
    } finally {
      clearTimeout(timeout)
    }
    await this.reportProgress(request, {
      kind: 'evaluation',
      stage: 'cleaning',
      occurredAt: new Date().toISOString(),
    })
    let controllerCleanup
    try {
      controllerCleanup = await this.cleanupContainers(runId)
    } catch (error) {
      controllerCleanup = {
        status: 'failed',
        errors: [error instanceof Error ? error.message : 'Case 容器清理失败'],
      }
    }
    result.completion.cleanup = {
      evaluator: result.completion.cleanup,
      controller: controllerCleanup,
    }
    result.completion.runtimeFacts = this.runtimeFacts(result.completion.runtimeFacts)
    await this.journal.writeResult(runId, { evaluatorOutput: result })
    try {
      await this.deliverResult(request, result)
    } catch (error) {
      await this.handleDeliveryFailure(runId, error)
    }
  }

  async start(runId) {
    if (this.active.has(runId)) return this.active.get(runId)
    const task = this.execute(runId).finally(() => this.active.delete(runId))
    this.active.set(runId, task)
    return task
  }

  async recover() {
    const recoverable = []
    for (const runId of await this.journal.listRunIds()) {
      const state = await this.journal.state(runId)
      if (ACTIVE_STAGES.has(state?.stage)) recoverable.push(runId)
    }
    if (recoverable.length) void this.start(recoverable[0])
    return recoverable.length
  }

  async handle(req, res) {
    try {
      const url = new URL(req.url, 'http://evaluator.local')
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, await this.healthReport())
      }
      if (req.method !== 'POST' || url.pathname !== '/api/v1/evaluations') {
        return json(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在', retryable: false } })
      }
      const request = await readJson(req)
      validateRequest(request, req.headers)
      const existing = await this.journal.request(request.runId)
      if (existing) {
        if (existing.requestDigest !== request.requestDigest) {
          throw evaluatorError('RUN_ID_CONFLICT', '同一 runId 的任务摘要不同', 409)
        }
        const state = await this.journal.state(request.runId)
        if (ACTIVE_STAGES.has(state?.stage)) void this.start(request.runId)
        return json(res, 202, {
          runId: request.runId,
          requestDigest: request.requestDigest,
          status: 'accepted',
          state: state?.stage || 'accepted',
        })
      }
      if (await this.hasBusyJob()) {
        throw evaluatorError('SERVICE_BUSY', '评测服务当前忙', 409, true)
      }
      const evaluator = this.registry.get(
        request.evaluationJob.evaluator.key,
        request.evaluationJob.benchmark.key,
      )
      evaluator.validateJob(request.evaluationJob)
      await this.journal.accept(request)
      json(res, 202, {
        runId: request.runId,
        requestDigest: request.requestDigest,
        status: 'accepted',
      })
      setImmediate(() => void this.start(request.runId).catch((error) => {
        console.error('[benchmark/evaluator] evaluation failed', error)
      }))
    } catch (error) {
      if (!res.headersSent) errorResponse(res, error)
    }
  }

  createServer() {
    return http.createServer((req, res) => void this.handle(req, res))
  }
}

module.exports = {
  ACTIVE_STAGES,
  BenchmarkEvaluatorService,
  canonicalJson,
  defaultControllerProbe,
  evaluationDispatchDigest,
  normalizeArchitecture,
  validateRequest,
  removeLabeledContainers,
}

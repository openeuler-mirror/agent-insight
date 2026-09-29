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
const { EvaluationJobJournal, atomicWriteJson } = require('./job-journal.cjs')
const { BenchmarkImagePool, imagePoolConfig } = require('./image-pool.cjs')
const { ServiceControl } = require('./service-control.cjs')
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
  const imagePoolError = error instanceof Error && /^IMAGE_POOL_[A-Z_]+$/.test(error.code)
    && error.status === 503 && typeof error.retryable === 'boolean'
  const known = error instanceof EvaluatorProtocolError || error instanceof PlatformClientError || imagePoolError
  if (!known) console.error('[benchmark/evaluator]', error)
  json(res, imagePoolError && !error.retryable ? 422 : known ? error.status : 500, {
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
    this.maxConcurrency = Number(options.maxConcurrency ?? (process.env.EVALUATOR_MAX_CONCURRENCY || 1))
    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
      throw new Error('EVALUATOR_MAX_CONCURRENCY must be a positive integer')
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
    this.admission = Promise.resolve()
    this.imagePreparations = new Map()
    this.recoveryQueue = []
    this.active = new Map()
    this.controllers = new Map()
    this.control = new ServiceControl(this.dataDir)
    this.retryAttempts = new Map()
    this.readiness = null
    const poolConfig = options.imagePoolConfig || imagePoolConfig()
    this.imagePool = options.imagePool || (poolConfig.enabled ? new BenchmarkImagePool({ dataDir: this.dataDir, config: poolConfig }) : null)
  }

  async prepareImageWindow(request, headers) {
    await this.control.assertRunning()
    const { requestDigest, ...payload } = request
    if (requestDigest !== sha256(Buffer.from(canonicalJson(payload)))
      || headers['x-agent-insight-request-digest'] !== requestDigest
      || !Number.isSafeInteger(request.revision) || request.revision < 0) {
      throw evaluatorError('IMAGE_POOL_WINDOW_INVALID', '镜像准备消息不合法', 422)
    }
    if (Array.isArray(request.windows)) {
      if (!this.imagePool?.config.prefetch) return { enabled: false }
      const windows = []
      const ids = new Set()
      let count = 0
      for (const window of request.windows) {
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(String(window.experimentId || ''))
          || !Array.isArray(window.cases) || !Array.isArray(window.caseIds) || window.cases.length !== window.caseIds.length) {
          throw evaluatorError('IMAGE_POOL_WINDOW_INVALID', '镜像准备窗口不合法', 422)
        }
        count += window.cases.length
        for (const id of window.caseIds) {
          if (typeof id !== 'string' || ids.has(id)) throw evaluatorError('IMAGE_POOL_WINDOW_INVALID', '准备 Case 重复或不合法', 422)
          ids.add(id)
        }
        if (count > this.maxConcurrency + 1) throw evaluatorError('IMAGE_POOL_WINDOW_INVALID', '镜像准备窗口超过服务上限', 422)
        const evaluator = this.registry.get(window.evaluatorKey, window.benchmarkKey)
        await this.imagePool.initialize()
        const specs = []
        for (const item of window.cases) specs.push(...await evaluator.describeImages(item, this.imagePool.arch))
        windows.push({ ...window, specs })
      }
      return this.withAdmission(async () => {
        if ((this.imagePool.state.windowRevision ?? -1) >= request.revision) return { enabled: true, accepted: false }
        for (const [runId, entry] of this.imagePreparations) {
          if (ids.has(entry.executionRunId)) continue
          this.controllers.get(runId)?.abort()
          await entry.task
          const prior = await this.journal.request(runId)
          if (prior) await this.imagePool.release(this.imageOwner(prior))
          this.imagePreparations.delete(runId)
          this.controllers.delete(runId)
        }
        return this.imagePool.replaceWindows(request.revision, windows)
      })
    }
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(String(request.experimentId || ''))
      || !Array.isArray(request.cases) || request.cases.length > this.maxConcurrency + 1) {
      throw evaluatorError('IMAGE_POOL_WINDOW_INVALID', '镜像准备消息不合法', 422)
    }
    if (!this.imagePool?.config.prefetch) return { enabled: false }
    const evaluator = this.registry.get(request.evaluatorKey, request.benchmarkKey)
    await this.imagePool.initialize()
    const specs = []
    for (const item of request.cases) specs.push(...await evaluator.describeImages(item, this.imagePool.arch))
    return this.withAdmission(async () => {
      const key = JSON.stringify([request.benchmarkKey, request.experimentId])
      const reserved = Object.entries(this.imagePool.state?.windows || {}).filter(([other, window]) => other !== key && window.expiresAt > Date.now())
        .reduce((sum, [, window]) => sum + (window.caseCount ?? (window.specs.length ? 2 : 0)), 0)
      if (reserved + request.cases.length > this.maxConcurrency + 1) throw evaluatorError('SERVICE_BUSY', '镜像准备窗口已满', 409, true)
      return this.imagePool.updateWindow({ benchmarkKey: request.benchmarkKey, experimentId: request.experimentId, caseCount: request.cases.length }, request.revision, specs)
    })
  }

  async prepareBeforeAdmission(request, evaluator) {
    if (!this.imagePool || !evaluator.describeImages) return
    if (this.imagePool.state?.windowRevision !== undefined) {
      const selected = Object.values(this.imagePool.state.windows).some((window) => window.expiresAt > Date.now() && window.caseIds?.includes(request.evaluationJob.executionRunId))
      if (!selected) throw evaluatorError('IMAGE_POOL_PREPARING', '等待进入镜像准备窗口', 409, true)
    }
    let entry = this.imagePreparations.get(request.runId)
    if (entry?.error) {
      this.imagePreparations.delete(request.runId)
      throw entry.error
    }
    if (entry?.ready) return
    if (!entry) {
      if (this.imagePreparations.size >= this.maxConcurrency + 1) throw evaluatorError('SERVICE_BUSY', '镜像准备窗口已满', 409, true)
      await this.journal.accept(request)
      await this.journal.writeState(request.runId, { stage: 'waiting_images' })
      const controller = new AbortController()
      this.controllers.set(request.runId, controller)
      entry = { ready: false, error: null, executionRunId: request.evaluationJob.executionRunId }
      this.imagePreparations.set(request.runId, entry)
      entry.task = this.acquireJobImages(request, evaluator, controller.signal).then(async () => {
        await this.control.assertRunning(request.runId)
        await this.journal.writeState(request.runId, { stage: 'images_ready' })
        entry.ready = true
      }).catch(async (error) => {
        entry.error = error
        if (error.actualDiskFull) {
          const reclaimed = await this.imagePool.evictOne(true).catch(() => false)
          const others = Object.values(this.imagePool.state.images).some((image) => Object.values(image.users)
            .some((owner) => owner.runId !== request.runId))
          if (!reclaimed && !others && !Object.keys(this.imagePool.state.operations).length) {
            entry.error = evaluatorError('IMAGE_POOL_CASE_CAPACITY_EXCEEDED', '实际拉取已确认磁盘不足且无可回收资源，请扩容或调整镜像池预算后重试', 422)
          }
        }
        await this.imagePool.release(this.imageOwner(request)).catch(() => {})
      })
    }
    throw evaluatorError('IMAGE_POOL_PREPARING', '等待镜像准备或镜像空间', 409, true)
  }

  async acquireJobImages(request, evaluator, signal) {
    if (!this.imagePool || !evaluator.describeImages) return undefined
    await this.imagePool.initialize()
    let specs = await evaluator.describeImages(request.evaluationJob.payload, this.imagePool.arch)
    if (!specs.length) return undefined
    const frozenPath = path.join(this.journal.jobDir(request.runId), 'pool-images.json')
    const frozen = await this.journal.readJson(frozenPath)
    if (frozen) {
      specs = specs.map((spec) => {
        const prior = frozen.find((image) => image.key === spec.key)
        if (!prior) throw evaluatorError('IMAGE_POOL_FROZEN_MISMATCH', '冻结镜像与任务不一致', 500)
        const repository = (ref) => ref.split('@')[0].replace(/:[^/:]+$/, '')
        if (!prior.pinnedImage.includes('@sha256:')) {
          // Local-only IDs can be reused but never silently replaced with a moving tag.
          if (!/^sha256:[a-f0-9]{64}$/i.test(prior.pinnedImage)) throw evaluatorError('IMAGE_POOL_FROZEN_MISMATCH', '冻结镜像身份不合法', 500)
        } else if (!spec.references.some((ref) => repository(ref) === repository(prior.pinnedImage))) {
          throw evaluatorError('IMAGE_POOL_FROZEN_FORBIDDEN', '冻结镜像已不在接入包允许范围内', 403)
        }
        return { ...spec, references: [prior.pinnedImage] }
      })
    }
    const images = await this.imagePool.acquire(this.imageOwner(request), specs, { signal })
    await atomicWriteJson(frozenPath, images)
    return images
  }

  imageOwner(request) {
    return { benchmarkKey: request.evaluationJob.benchmark.key, experimentId: request.evaluationJob.context.experimentId, runId: request.runId }
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
      maxConcurrency: this.maxConcurrency,
      activeCount: await this.occupiedCount(),
      busy: await this.hasBusyJob(),
      imagePool: { enabled: Boolean(this.imagePool), prefetch: Boolean(this.imagePool?.config.prefetch),
        storage: this.imagePool?.store?.diskStatus || null,
        recoveryRequired: this.imagePool ? Object.values(this.imagePool.state.operations).some((op) => op.uncertain)
          || Object.values(this.imagePool.state.images).some((entry) => entry.uncertain) : false },
      runtime: this.runtimeFacts(controller.runtimeFacts),
      controller: {
        ready: controller.ready,
        ...(controller.reason ? { reason: controller.reason } : {}),
      },
      evaluators: await this.evaluatorHealth(),
    }
  }

  async occupiedCount(exceptRunId) {
    const occupied = new Set()
    for (const runId of await this.journal.listRunIds()) {
      if (runId === exceptRunId) continue
      const state = await this.journal.state(runId)
      if (ACTIVE_STAGES.has(state?.stage) && state?.stage !== 'callback_pending' || state?.resourcesUnreleased) occupied.add(runId)
    }
    return occupied.size
  }

  async hasBusyJob(exceptRunId) {
    return await this.occupiedCount(exceptRunId) >= this.maxConcurrency
  }

  async withAdmission(operation) {
    const previous = this.admission
    let release
    this.admission = new Promise((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  async reportProgress(request, event) {
    await this.control.assertRunning(request.runId)
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
    await this.control.assertRunning(request.runId)
    await this.reportProgress(request, {
      kind: 'evaluation',
      stage: 'uploading_evidence',
      occurredAt: new Date().toISOString(),
    })
    const uploads = []
    for (const evidence of result.evidenceFiles) {
      await this.control.assertRunning(request.runId)
      uploads.push(await this.platform.uploadEvidence(request, evidence))
    }
    const completion = {
      ...result.completion,
      evidenceArtifactIds: uploads.map((item) => item.artifactId),
    }
    await this.journal.writeResult(request.runId, { completion })
    await this.journal.writeState(request.runId, { stage: 'callback_pending' })
    await this.control.assertRunning(request.runId)
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
    await this.control.assertRunning(runId)
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
    this.controllers.set(runId, abortController)
    let timedOut = false
    let timeout
    const assertWithinDeadline = () => {
      if (timedOut) throw evaluationTimeoutError()
      if (abortController.signal.aborted) throw evaluatorError('EVALUATION_CANCELLED', '评测已取消', 409)
    }
    let result
    let imagePoolWaitMs = 0
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
      if (this.imagePool) await this.reportProgress(request, { kind: 'evaluation', stage: 'resolving_image', occurredAt: new Date().toISOString() })
      const imageWaitStarted = Date.now()
      let preparedImages
      try { preparedImages = await this.acquireJobImages(request, evaluator, abortController.signal) }
      finally { imagePoolWaitMs = Date.now() - imageWaitStarted }
      assertWithinDeadline()
      timeout = setTimeout(() => { timedOut = true; abortController.abort() }, request.timeoutSeconds * 1000)
      result = await evaluator.evaluate({
        job: request.evaluationJob,
        preparedImages,
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
    if (await this.control.stopped() || await this.control.cancelled(runId)) {
      await this.cleanupCancelled(runId)
      return
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
    if (this.imagePool && controllerCleanup.status === 'succeeded') {
      try { await this.imagePool.release(this.imageOwner(request)) }
      catch (error) { console.error('[benchmark/image-pool] release failed; protection retained', error.message) }
    }
    result.completion.runtimeFacts = this.runtimeFacts(result.completion.runtimeFacts)
    if (this.imagePool) result.completion.runtimeFacts.imagePoolWaitMs = imagePoolWaitMs
    await this.journal.writeState(runId, { resourcesUnreleased: controllerCleanup.status !== 'succeeded' })
    await this.journal.writeResult(runId, { evaluatorOutput: result })
    try {
      await this.deliverResult(request, result)
    } catch (error) {
      await this.handleDeliveryFailure(runId, error)
    }
  }

  async cleanupCancelled(runId) {
    const cleanup = await this.cleanupContainers(runId)
    const request = await this.journal.request(runId)
    if (cleanup.status === 'succeeded' && this.imagePool && request) {
      await this.imagePool.release(this.imageOwner(request))
    }
    const intent = await this.control.cancelled(runId) || await this.control.stopped()
    await this.journal.writeState(runId, {
      stage: cleanup.status === 'succeeded' ? 'cancelled' : 'cancelling',
      cancellationReason: intent?.reason || 'EVALUATION_CANCELLED',
      resourcesUnreleased: cleanup.status !== 'succeeded',
      cancellationCleanup: cleanup,
      cancellationCallbackPending: true,
    })
    return cleanup
  }

  async cancel(runId, reason = 'EVALUATION_CANCELLED') {
    await this.control.cancel(runId, reason)
    this.controllers.get(runId)?.abort()
    await this.imagePreparations.get(runId)?.task
    this.imagePreparations.delete(runId)
    // An active run may still be unwinding; its final cleanup confirms termination.
    if (this.active.has(runId)) return { runId, status: 'cancelling' }
    if (!await this.journal.request(runId)) return { runId, status: 'cancelled' }
    const cleanup = await this.cleanupCancelled(runId)
    return { runId, status: cleanup.status === 'succeeded' ? 'cancelled' : 'cancelling' }
  }

  async shutdown() {
    await this.control.stop()
    for (const controller of this.controllers.values()) controller.abort()
    for (const runId of await this.journal.listRunIds()) {
      if (ACTIVE_STAGES.has((await this.journal.state(runId))?.stage)) {
        await this.control.cancel(runId, 'SERVICE_STOPPED')
        await this.journal.writeState(runId, { stage: 'cancelling', cancellationReason: 'SERVICE_STOPPED' })
      }
    }
    await this.imagePool?.close()
  }

  async flushStopNotifications() {
    if (this.flushingStopNotifications) return
    this.flushingStopNotifications = true
    try {
    for (const runId of await this.journal.listRunIds()) {
      const state = await this.journal.state(runId)
      const intent = await this.control.cancelled(runId)
      if (!state?.cancellationCallbackPending || intent?.reason !== 'SERVICE_STOPPED' || state.stage !== 'cancelled') continue
      const request = await this.journal.request(runId)
      try {
        await this.platform.complete(request, { status: 'failed', rawResult: {}, evidenceArtifactIds: [],
          runtimeFacts: this.runtimeFacts(), cleanup: state.cancellationCleanup || { status: 'succeeded' },
          error: { code: 'SERVICE_STOPPED', message: '评测服务被管理员主动停止', retryable: false } })
        await this.journal.writeState(runId, { cancellationCallbackPending: false })
      } catch (error) {
        await this.journal.writeState(runId, { cancellationCallbackError: error.message })
      }
    }
    } finally { this.flushingStopNotifications = false }
  }

  async start(runId) {
    if (this.active.has(runId)) return this.active.get(runId)
    await this.control.assertRunning(runId)
    if (this.active.has(runId)) return this.active.get(runId)
    const task = Promise.resolve().then(async () => {
      await this.control.assertRunning(runId)
      return this.execute(runId)
    }).catch(async (error) => {
      if (await this.control.cancelled(runId) || await this.control.stopped()) await this.cleanupCancelled(runId)
      else throw error
    }).finally(async () => {
      this.active.delete(runId); this.controllers.delete(runId)
      if ((await this.journal.state(runId))?.resourcesUnreleased) return
      const next = this.recoveryQueue.shift()
      if (next) void this.start(next).catch((error) => console.error('[evaluator/recover]', error))
    })
    this.active.set(runId, task)
    return task
  }

  async recover() {
    await this.control.assertRunning()
    if (this.imagePool) {
      await this.imagePool.initialize()
      const owners = Object.values(this.imagePool.state.images).flatMap((entry) => Object.values(entry.users))
      for (const owner of owners) {
        const request = await this.journal.request(owner.runId)
        if (!request) continue
        const cleanup = await this.cleanupContainers(owner.runId)
        if (cleanup.status === 'succeeded') await this.imagePool.release(owner)
      }
    }
    const recoverable = []
    for (const runId of await this.journal.listRunIds()) {
      if (await this.control.cancelled(runId)) {
        if ((await this.journal.state(runId))?.stage !== 'cancelled') await this.cleanupCancelled(runId)
        continue
      }
      const state = await this.journal.state(runId)
      if (state?.resourcesUnreleased) {
        const cleanup = await this.cleanupContainers(runId)
        if (cleanup.status === 'succeeded') await this.journal.writeState(runId, { resourcesUnreleased: false })
        else continue
      }
      if (ACTIVE_STAGES.has(state?.stage)) recoverable.push(runId)
    }
    void this.flushStopNotifications().catch((error) => console.error('[evaluator/stop-notifications]', error))
    let blocked = 0
    for (const runId of await this.journal.listRunIds()) if ((await this.journal.state(runId))?.resourcesUnreleased) blocked++
    const available = Math.max(0, this.maxConcurrency - blocked)
    this.recoveryQueue = recoverable.slice(available)
    for (const runId of recoverable.slice(0, available)) void this.start(runId).catch((error) => console.error('[evaluator/recover]', error))
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
      if (request?.operation === 'cancel') {
        this.journal.jobDir(request.runId)
        const existing = await this.journal.request(request.runId)
        if (existing && existing.requestDigest !== request.requestDigest) {
          throw evaluatorError('RUN_ID_CONFLICT', '取消请求摘要与原任务不一致', 409)
        }
        if (typeof request.requestDigest !== 'string' || !request.requestDigest) {
          throw evaluatorError('CANCEL_INVALID', '取消请求缺少原任务摘要', 422)
        }
        return json(res, 202, await this.cancel(request.runId))
      }
      if (request?.operation === 'prepare-images') {
        return json(res, 202, await this.prepareImageWindow(request, req.headers))
      }
      validateRequest(request, req.headers)
      await this.control.assertRunning(request.runId)
      const state = await this.withAdmission(async () => {
        await this.control.assertRunning(request.runId)
        const existing = await this.journal.request(request.runId)
        if (existing && existing.requestDigest !== request.requestDigest) throw evaluatorError('RUN_ID_CONFLICT', '同一 runId 的任务摘要不同', 409)
        const state = existing ? await this.journal.state(request.runId) : null
        if (state && !['waiting_images', 'images_ready'].includes(state.stage)) return state
        if (await this.hasBusyJob(request.runId)) throw evaluatorError('SERVICE_BUSY', '评测服务当前忙', 409, true)
        const evaluator = this.registry.get(request.evaluationJob.evaluator.key, request.evaluationJob.benchmark.key)
        evaluator.validateJob(request.evaluationJob)
        await this.prepareBeforeAdmission(request, evaluator)
        await this.journal.accept(request)
        await this.journal.writeState(request.runId, { stage: 'accepted' })
        this.imagePreparations.delete(request.runId)
        return { stage: 'accepted' }
      })
      json(res, 202, { runId: request.runId, requestDigest: request.requestDigest, status: 'accepted', state: state?.stage || 'accepted' })
      if (!ACTIVE_STAGES.has(state?.stage)) return
      setImmediate(() => void this.start(request.runId).catch((error) => {
        console.error('[benchmark/evaluator] evaluation failed', error)
      }))
    } catch (error) {
      if (!res.headersSent) errorResponse(res, error)
    }
  }

  createServer() {
    const server = http.createServer((req, res) => void this.handle(req, res))
    server.once('close', () => { void this.imagePool?.close() })
    return server
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

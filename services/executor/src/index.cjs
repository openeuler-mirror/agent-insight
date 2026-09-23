'use strict'

const { createHash, createHmac, timingSafeEqual } = require('node:crypto')
const fsp = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const DELIVERY_RETRY_STAGES = new Set(['complete_pending', 'upload_pending'])
const DELIVERY_RETRY_BASE_MS = 5_000
const DELIVERY_RETRY_MAX_MS = 5 * 60_000
const GIT_FETCH_ATTEMPTS = 3
const GIT_FETCH_TIMEOUT_MS = 2 * 60_000
const GIT_FETCH_RETRY_BASE_MS = 1_000
const GIT_FETCH_RETRY_JITTER_MS = 250
const TRANSIENT_GIT_FETCH_ERROR = /(?:could not resolve host|failed to connect|couldn['’]?t connect|connection (?:timed out|reset|closed|refused)|operation timed out|failure when receiving data from the peer|recv failure|send failure|remote end hung up unexpectedly|unexpected disconnect|early eof|partial file|http\/2 (?:stream|protocol_error)|rpc failed;\s*curl\s+(?:6|7|18|28|35|52|55|56|92)\b|the requested url returned error:\s*(?:408|429|500|502|503|504)\b|tls connection was non-properly terminated|network is unreachable|temporary failure)/i

class BenchmarkExecutorError extends Error {
  constructor(code, message, status = 422, retryable = false) {
    super(message)
    this.name = 'BenchmarkExecutorError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

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

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function deviceCredentialHash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function dispatchDigest(request) {
  return sha256(canonicalJson({
    runId: request.runId,
    task: request.task,
    callbackBaseUrl: request.callbackBaseUrl,
    timeoutSeconds: request.timeoutSeconds,
  }))
}

function verifySignature(token, credentialHash) {
  const [encoded, signature, extra] = String(token || '').split('.')
  if (!encoded || !signature || extra || !/^[0-9a-f]{64}$/i.test(credentialHash)) {
    throw new BenchmarkExecutorError('DISPATCH_UNAUTHORIZED', '下发 token 不合法', 401)
  }
  const expected = createHmac('sha256', Buffer.from(credentialHash, 'hex')).update(encoded).digest()
  let actual
  let payload
  try {
    actual = Buffer.from(signature, 'base64url')
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new BenchmarkExecutorError('DISPATCH_UNAUTHORIZED', '下发 token 不合法', 401)
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new BenchmarkExecutorError('DISPATCH_UNAUTHORIZED', '下发 token 签名无效', 401)
  }
  const now = Math.floor(Date.now() / 1000)
  if (
    payload.aud !== 'benchmark-executor'
    || !Number.isInteger(payload.expiresAt)
    || payload.expiresAt < now
    || payload.expiresAt > now + 600
  ) {
    throw new BenchmarkExecutorError('DISPATCH_FORBIDDEN', '下发 token 已过期或用途不匹配', 403)
  }
  return payload
}

function bearerToken(headers) {
  const match = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || '').trim())
  if (!match) throw new BenchmarkExecutorError('DISPATCH_UNAUTHORIZED', '缺少下发 token', 401)
  return match[1]
}

function assertCallbackUrl(callbackBaseUrl, insightBaseUrl, runId, allowAlternateOrigin = false) {
  let actual
  let expected
  try {
    actual = new URL(callbackBaseUrl)
    expected = new URL(
      `${String(insightBaseUrl).replace(/\/$/, '')}/api/benchmark/v1/runs/${encodeURIComponent(runId)}`,
    )
  } catch {
    throw new BenchmarkExecutorError('CALLBACK_URL_INVALID', '回调地址不合法', 403)
  }
  if (
    !['http:', 'https:'].includes(actual.protocol)
    || actual.username
    || actual.password
    || (!allowAlternateOrigin && actual.origin !== expected.origin)
    || actual.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')
    || actual.search
    || actual.hash
  ) {
    throw new BenchmarkExecutorError('CALLBACK_URL_FORBIDDEN', '回调地址与当前平台 Run 不匹配', 403)
  }
}

const FORBIDDEN_KEYS = new Set([
  'command',
  'shell',
  'args',
  'executable',
  'token',
  'credential',
  'privatepayload',
])

function scanForbidden(value, currentPath = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbidden(item, `${currentPath}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new BenchmarkExecutorError('TASK_FORBIDDEN_FIELD', `任务包含禁止字段 ${currentPath}.${key}`)
    }
    scanForbidden(item, `${currentPath}.${key}`)
  }
}

function validateTaskEnvelope(task, runId) {
  if (!task || task.schemaVersion !== 'agent-task/v1') {
    throw new BenchmarkExecutorError('TASK_SCHEMA_INVALID', '任务协议标识不受支持')
  }
  if (!task.context || task.context.runId !== runId) {
    throw new BenchmarkExecutorError('TASK_CONTEXT_MISMATCH', '任务上下文与 runId 不一致')
  }
  if (!task.benchmark?.key || !task.task?.instruction || !task.task?.benchmarkPayload) {
    throw new BenchmarkExecutorError('TASK_SCHEMA_INVALID', '任务缺少 Benchmark 公开输入')
  }
  if (
    task.workspace?.provider !== 'git'
    || !/^[0-9a-f]{40}$/i.test(String(task.workspace?.revision || ''))
  ) {
    throw new BenchmarkExecutorError('TASK_WORKSPACE_INVALID', 'Git 工作区契约不合法')
  }
  let repository
  try {
    repository = new URL(task.workspace.repository)
  } catch {
    throw new BenchmarkExecutorError('TASK_REPOSITORY_INVALID', '仓库地址不合法')
  }
  if (
    repository.protocol !== 'https:'
    || repository.hostname !== 'github.com'
    || repository.username
    || repository.password
    || repository.search
    || repository.hash
  ) {
    throw new BenchmarkExecutorError('TASK_REPOSITORY_INVALID', '仓库必须是 GitHub HTTPS 地址')
  }
  if (
    task.policy?.workspaceWrite !== 'allow'
    || task.policy?.hiddenDataAccess !== 'deny'
    || task.policy?.network !== 'client-default'
  ) {
    throw new BenchmarkExecutorError('POLICY_UNSUPPORTED', '当前执行器只支持 client-default 网络策略')
  }
  if (
    !Array.isArray(task.submission?.requiredArtifacts)
    || !task.submission.requiredArtifacts.length
    || !String(task.agentConfig?.platform || '').trim()
    || !String(task.agentConfig?.agent || '').trim()
    || !Number.isInteger(task.agentConfig?.timeoutSeconds)
    || task.agentConfig.timeoutSeconds < 1
    || task.agentConfig.timeoutSeconds > 86_400
  ) {
    throw new BenchmarkExecutorError('TASK_SCHEMA_INVALID', '提交物或 Agent 配置不合法')
  }
  const artifactNames = new Set()
  for (const artifact of task.submission.requiredArtifacts) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(artifact?.name || ''))
      || artifactNames.has(artifact.name)
      || !String(artifact.mediaType || '').trim()
      || !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(String(artifact.collector || ''))
      || !Number.isInteger(artifact.maxBytes)
      || artifact.maxBytes < 1
    ) {
      throw new BenchmarkExecutorError('ARTIFACT_CONTRACT_INVALID', '提交物契约不合法')
    }
    artifactNames.add(artifact.name)
  }
  scanForbidden(task)
}

class CapabilityRegistry {
  constructor(kind, entries = []) {
    this.kind = kind
    this.capabilities = new Map()
    for (const [key, capability] of entries) this.register(key, capability)
  }

  register(key, capability) {
    if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(String(key || ''))) {
      throw new TypeError(`${this.kind} capability key is invalid`)
    }
    if (this.capabilities.has(key)) throw new TypeError(`duplicate ${this.kind} capability: ${key}`)
    this.capabilities.set(key, capability)
    return this
  }

  replace(entries = []) {
    const capabilities = new Map()
    for (const [key, capability] of entries) {
      if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(String(key || ''))) {
        throw new TypeError(`${this.kind} capability key is invalid`)
      }
      if (capabilities.has(key)) throw new TypeError(`duplicate ${this.kind} capability: ${key}`)
      capabilities.set(key, capability)
    }
    this.capabilities = capabilities
    return this
  }

  get(key) {
    const capability = this.capabilities.get(key)
    if (!capability) {
      throw new BenchmarkExecutorError('EXECUTOR_CAPABILITY_MISSING', `执行器未注册 ${this.kind} 能力：${key}`)
    }
    return capability
  }

  keys() {
    return [...this.capabilities.keys()]
  }
}

class WorkspaceProviderRegistry extends CapabilityRegistry {
  constructor(entries = []) { super('workspace', entries) }
}

class AgentRuntimeRegistry extends CapabilityRegistry {
  constructor(entries = []) { super('agent-runtime', entries) }
}

class ArtifactCollectorRegistry extends CapabilityRegistry {
  constructor(entries = []) { super('artifact-collector', entries) }
}

function buildExecutionPlan(task, registries) {
  return {
    workspace: task.workspace,
    workspaceProvider: registries.workspaceProviders.get(task.workspace.provider),
    policy: task.policy,
    agentRuntime: registries.agentRuntimes.get(task.agentConfig.platform),
    agent: {
      ...task.agentConfig,
      input: task.task.instruction,
      correlation: {
        experimentId: task.context.experimentId,
        caseRunId: task.context.runId,
      },
    },
    artifacts: task.submission.requiredArtifacts.map((contract) => ({
      contract,
      collector: registries.collectors.get(contract.collector),
    })),
  }
}

async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 })
  const handle = await fsp.open(tempPath, 'r')
  await handle.sync()
  await handle.close()
  await fsp.rename(tempPath, filePath)
}

class FileRunStore {
  constructor(rootDir) {
    this.rootDir = rootDir
  }

  runDir(runId) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(runId)) {
      throw new BenchmarkExecutorError('RUN_ID_INVALID', 'runId 不合法', 400)
    }
    return path.join(this.rootDir, runId)
  }

  async readJson(filePath) {
    try {
      return JSON.parse(await fsp.readFile(filePath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async accept(request) {
    const runDir = this.runDir(request.runId)
    const requestPath = path.join(runDir, 'request.json')
    const existing = await this.readJson(requestPath)
    if (existing) {
      if (existing.requestDigest !== request.requestDigest) {
        throw new BenchmarkExecutorError('RUN_ID_CONFLICT', '同一 runId 的任务摘要不同', 409)
      }
      return { created: false, state: await this.state(request.runId) }
    }
    await fsp.mkdir(runDir, { recursive: true, mode: 0o700 })
    await atomicWriteJson(requestPath, request)
    await this.writeState(request.runId, { stage: 'accepted', updatedAt: new Date().toISOString() })
    return { created: true, state: await this.state(request.runId) }
  }

  state(runId) {
    return this.readJson(path.join(this.runDir(runId), 'state.json'))
  }

  request(runId) {
    return this.readJson(path.join(this.runDir(runId), 'request.json'))
  }

  writeState(runId, patch) {
    return this.state(runId).then((current) => atomicWriteJson(
      path.join(this.runDir(runId), 'state.json'),
      { ...(current || {}), ...patch, updatedAt: new Date().toISOString() },
    ))
  }

  async writeArtifact(runId, name, bytes) {
    const artifactDir = path.join(this.runDir(runId), 'artifacts')
    await fsp.mkdir(artifactDir, { recursive: true, mode: 0o700 })
    const target = path.join(artifactDir, name)
    const temp = `${target}.${process.pid}.tmp`
    await fsp.writeFile(temp, bytes, { mode: 0o600 })
    await fsp.rename(temp, target)
    return target
  }

  async listRunIds() {
    try {
      const entries = await fsp.readdir(this.rootDir, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const useProcessGroup = Boolean(options.killProcessGroup) && process.platform !== 'win32'
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useProcessGroup,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timeoutTimer = null
    let forceKillTimer = null
    let hardStopTimer = null
    const timeoutMs = Number(options.timeoutMs)
    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (hardStopTimer) clearTimeout(hardStopTimer)
    }
    const settle = (callback) => {
      if (settled) return
      settled = true
      clearTimers()
      callback()
    }
    const terminate = (signal) => {
      try {
        if (useProcessGroup && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {}
    }
    const processError = (code, signal) => {
      const error = timedOut
        ? new BenchmarkExecutorError(
          options.timeoutErrorCode || 'PROCESS_TIMEOUT',
          `${command} ${args[0] || ''} 超过 ${timeoutMs}ms 未结束`,
          503,
          true,
        )
        : new BenchmarkExecutorError(
          options.errorCode || 'PROCESS_FAILED',
          `${command} ${args[0] || ''} 失败: ${stderr.slice(-2000) || `exit ${code}`}`,
        )
      error.timedOut = timedOut
      error.exitCode = code
      error.signal = signal
      error.stderr = stderr.slice(-2000)
      return error
    }
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      settle(() => reject(error))
    })
    child.on('close', (code, signal) => {
      if (!timedOut && code === 0) settle(() => resolve({ stdout, stderr }))
      else settle(() => reject(processError(code, signal)))
    })
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        terminate('SIGTERM')
        forceKillTimer = setTimeout(() => terminate('SIGKILL'), 2_000)
        forceKillTimer.unref?.()
        hardStopTimer = setTimeout(() => {
          settle(() => reject(processError(null, 'SIGKILL')))
        }, 5_000)
        hardStopTimer.unref?.()
      }, timeoutMs)
      timeoutTimer.unref?.()
    }
  })
}

function isTransientGitFetchError(error) {
  if (error?.timedOut === true || error?.code === 'PROCESS_TIMEOUT') return true
  return TRANSIENT_GIT_FETCH_ERROR.test(
    `${error?.stderr || ''}\n${error?.message || error || ''}`,
  )
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

class GitWorkspaceProvider {
  constructor(rootDir, processRunner = runProcess, options = {}) {
    this.rootDir = rootDir
    this.processRunner = processRunner
    const fetchAttempts = Number(options.fetchAttempts ?? GIT_FETCH_ATTEMPTS)
    const fetchTimeoutMs = Number(options.fetchTimeoutMs ?? GIT_FETCH_TIMEOUT_MS)
    const retryBaseMs = Number(options.retryBaseMs ?? GIT_FETCH_RETRY_BASE_MS)
    const retryJitterMs = Number(options.retryJitterMs ?? GIT_FETCH_RETRY_JITTER_MS)
    this.fetchAttempts = Number.isInteger(fetchAttempts)
      ? Math.min(10, Math.max(1, fetchAttempts))
      : GIT_FETCH_ATTEMPTS
    this.fetchTimeoutMs = Number.isFinite(fetchTimeoutMs)
      ? Math.max(1_000, fetchTimeoutMs)
      : GIT_FETCH_TIMEOUT_MS
    this.retryBaseMs = Number.isFinite(retryBaseMs) ? Math.max(0, retryBaseMs) : GIT_FETCH_RETRY_BASE_MS
    this.retryJitterMs = Number.isFinite(retryJitterMs)
      ? Math.max(0, retryJitterMs)
      : GIT_FETCH_RETRY_JITTER_MS
    this.random = options.random || Math.random
    this.sleep = options.sleep || wait
  }

  async initializeWorkspace(workspace, repository) {
    await fsp.rm(workspace, { recursive: true, force: true })
    await fsp.mkdir(workspace, { recursive: true, mode: 0o700 })
    await this.processRunner('git', ['init', '--quiet'], { cwd: workspace, errorCode: 'WORKSPACE_PREPARE_FAILED' })
    await this.processRunner('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: workspace, errorCode: 'WORKSPACE_PREPARE_FAILED' })
    await this.processRunner('git', ['remote', 'add', 'origin', repository], { cwd: workspace, errorCode: 'WORKSPACE_PREPARE_FAILED' })
  }

  async fetchRevision(workspace, spec) {
    const failures = []
    for (let attempt = 1; attempt <= this.fetchAttempts; attempt += 1) {
      await this.initializeWorkspace(workspace, spec.repository)
      const args = attempt === this.fetchAttempts && attempt > 1
        ? ['-c', 'http.version=HTTP/1.1', 'fetch', '--quiet', '--depth=1', 'origin', spec.revision]
        : ['fetch', '--quiet', '--depth=1', 'origin', spec.revision]
      try {
        await this.processRunner('git', args, {
          cwd: workspace,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            LANG: 'C',
            LC_ALL: 'C',
          },
          errorCode: 'WORKSPACE_PREPARE_FAILED',
          timeoutErrorCode: 'PROCESS_TIMEOUT',
          timeoutMs: this.fetchTimeoutMs,
          killProcessGroup: true,
        })
        return
      } catch (error) {
        const transient = isTransientGitFetchError(error)
        failures.push(`第 ${attempt} 次: ${String(error?.message || error).slice(-600)}`)
        if (!transient) throw error
        if (attempt >= this.fetchAttempts) {
          throw new BenchmarkExecutorError(
            'WORKSPACE_PREPARE_FAILED',
            `Git fetch 瞬时网络错误，${attempt} 次尝试均失败：${failures.join('；')}`,
            503,
            true,
          )
        }
        const backoff = this.retryBaseMs * (2 ** (attempt - 1))
        const jitter = Math.floor(this.random() * this.retryJitterMs)
        await this.sleep(backoff + jitter)
      }
    }
  }

  async prepare(spec, context) {
    const workspace = path.join(this.rootDir, context.runId)
    await this.fetchRevision(workspace, spec)
    await this.processRunner('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: workspace, errorCode: 'WORKSPACE_PREPARE_FAILED' })
    const head = await this.processRunner('git', ['rev-parse', 'HEAD'], { cwd: workspace, errorCode: 'WORKSPACE_PREPARE_FAILED' })
    if (head.stdout.trim().toLowerCase() !== spec.revision.toLowerCase()) {
      throw new BenchmarkExecutorError('WORKSPACE_REVISION_MISMATCH', 'Git HEAD 与 baseCommit 不一致')
    }
    return { path: workspace, baseCommit: spec.revision }
  }
}

class LocalPolicyEnforcer {
  async apply(spec) {
    if (spec.network !== 'client-default') {
      throw new BenchmarkExecutorError('POLICY_UNSUPPORTED', '本地执行器尚未提供网络沙箱')
    }
    return { network: 'client-default' }
  }

  async release() {}
}

class GitPatchCollector {
  constructor(processRunner = runProcess) {
    this.processRunner = processRunner
  }

  async collect(contract, context) {
    const reservedArtifact = `:(top,exclude,literal)${contract.name}`
    await this.processRunner(
      'git',
      ['add', '-A', '--', '.', reservedArtifact],
      { cwd: context.workspace.path, errorCode: 'ARTIFACT_COLLECT_FAILED' },
    )
    const diff = await this.processRunner(
      'git',
      [
        'diff', '--cached', '--binary', '--full-index', context.workspace.baseCommit,
        '--', '.', reservedArtifact,
      ],
      { cwd: context.workspace.path, errorCode: 'ARTIFACT_COLLECT_FAILED' },
    )
    const bytes = Buffer.from(diff.stdout, 'utf8')
    if (!bytes.length) {
      throw new BenchmarkExecutorError('AGENT_NO_OUTPUT', `Agent 正常结束，但未生成必需的 ${contract.name}`)
    }
    if (bytes.length > contract.maxBytes) {
      throw new BenchmarkExecutorError('ARTIFACT_SIZE_INVALID', `${contract.name} 超过大小上限`)
    }
    for (const line of diff.stdout.split(/\r?\n/)) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      if (match && [match[1], match[2]].some((item) => path.isAbsolute(item) || item.split('/').includes('..'))) {
        throw new BenchmarkExecutorError('ARTIFACT_PATH_INVALID', `${contract.name} 包含越界路径`)
      }
    }
    return {
      name: contract.name,
      mediaType: contract.mediaType,
      bytes,
      sha256: sha256(bytes),
    }
  }
}

class WorkspaceCleanupManager {
  async cleanup(context) {
    if (context.workspace?.path) {
      await fsp.rm(context.workspace.path, { recursive: true, force: true })
    }
    return { status: 'succeeded', finishedAt: new Date().toISOString() }
  }
}

class AgentInsightCallbackClient {
  constructor(options) {
    this.fetch = options.fetchImpl || fetch
    this.clientId = options.clientId
    this.deviceCredential = options.deviceCredential
    this.insightBaseUrl = String(options.insightBaseUrl).replace(/\/$/, '')
    this.timeoutMs = Math.max(1_000, Number(options.callbackTimeoutMs) || 30_000)
  }

  headers(extra = {}) {
    return {
      authorization: `Bearer ${this.deviceCredential}`,
      'x-agent-insight-client-id': this.clientId,
      ...extra,
    }
  }

  runCallbackBaseUrl(request) {
    return `${this.insightBaseUrl}/api/benchmark/v1/runs/${encodeURIComponent(request.runId)}`
  }

  async checkedFetch(url, init) {
    let response
    try {
      response = await this.fetch(url, {
        ...init,
        redirect: 'error',
        signal: init?.signal || AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new BenchmarkExecutorError(
        'CALLBACK_UNAVAILABLE',
        `Agent Insight 回调不可达: ${error?.message || String(error)}`,
        503,
        true,
      )
    }
    const text = await response.text()
    if (!response.ok) {
      let code = 'CALLBACK_REJECTED'
      try { code = JSON.parse(text)?.error?.code || code } catch {}
      throw new BenchmarkExecutorError(
        code,
        `Agent Insight 回调失败（HTTP ${response.status}）`,
        response.status,
        response.status === 429 || response.status >= 500,
      )
    }
    try { return text ? JSON.parse(text) : {} } catch { return {} }
  }

  progress(request, stage, progress = {}) {
    return this.checkedFetch(`${this.runCallbackBaseUrl(request)}/progress`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ kind: 'execution', stage, progress, occurredAt: new Date().toISOString() }),
    })
  }

  async uploadArtifact(request, artifact) {
    const form = new FormData()
    form.set('metadata', JSON.stringify({
      runId: request.runId,
      name: artifact.name,
      mediaType: artifact.mediaType,
      sha256: artifact.sha256,
    }))
    form.set('file', new Blob([artifact.bytes], { type: artifact.mediaType }), artifact.name)
    return this.checkedFetch(`${this.insightBaseUrl}/api/benchmark/v1/artifacts`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    })
  }

  complete(request, body) {
    return this.checkedFetch(`${this.runCallbackBaseUrl(request)}/complete`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
  }
}

class BenchmarkExecutionRunner {
  constructor(options) {
    this.store = options.store
    this.workspaceProviders = options.workspaceProviders
    this.agentRuntimes = options.agentRuntimes
    this.policyEnforcer = options.policyEnforcer
    this.collectors = options.collectors
    this.cleanupManager = options.cleanupManager
    this.callback = options.callback
    this.logError = options.logError
  }

  async progress(request, stage, message) {
    await this.store.writeState(request.runId, { stage })
    await this.callback.progress(request, stage, { message }).catch(() => undefined)
  }

  async execute(request) {
    const plan = buildExecutionPlan(request.task, this)
    let workspace = null
    let appliedPolicy = null
    let cleanup = null
    let runFacts = null
    const localArtifacts = []
    const uploadedArtifacts = []
    let pendingCompletion = null
    try {
      await this.progress(request, 'preparing', '正在准备 Git 工作区')
      workspace = await plan.workspaceProvider.prepare(plan.workspace, { runId: request.runId })
      appliedPolicy = await this.policyEnforcer.apply(plan.policy, { runId: request.runId })
      await this.progress(request, 'agent_running', '正在运行 Agent')
      const agentResult = await plan.agentRuntime.run({
        ...plan.agent,
        cwd: workspace.path,
        timeoutSeconds: Math.min(plan.agent.timeoutSeconds, request.timeoutSeconds),
      })
      runFacts = {
        ...agentResult,
        platform: plan.agent.platform,
        agent: plan.agent.agent,
        ...(plan.agent.model ? { model: plan.agent.model } : {}),
      }
      if (agentResult?.timedOut === true) {
        throw new BenchmarkExecutorError('AGENT_TIMEOUT', 'Agent 执行超过任务上限并已被终止')
      }
      if (
        (agentResult?.exitCode !== undefined && agentResult?.exitCode !== null && agentResult.exitCode !== 0)
        || (agentResult?.exitCode === null && agentResult?.signal)
      ) {
        throw new BenchmarkExecutorError(
          'AGENT_EXIT_NONZERO',
          `Agent 异常退出（${agentResult.exitCode === null ? `signal ${agentResult.signal}` : `exit ${agentResult.exitCode}`}）`,
        )
      }
      await this.progress(request, 'collecting', '正在收集提交物')
      for (const artifactPlan of plan.artifacts) {
        const artifact = await artifactPlan.collector.collect(artifactPlan.contract, { workspace, runFacts })
        if (
          artifact.name !== artifactPlan.contract.name
          || artifact.mediaType !== artifactPlan.contract.mediaType
          || !Buffer.isBuffer(artifact.bytes)
          || artifact.bytes.length < 1
          || artifact.bytes.length > artifactPlan.contract.maxBytes
          || artifact.sha256 !== sha256(artifact.bytes)
        ) {
          throw new BenchmarkExecutorError('ARTIFACT_COLLECTOR_OUTPUT_INVALID', '提交物收集器返回了错误的契约')
        }
        artifact.path = await this.store.writeArtifact(request.runId, artifact.name, artifact.bytes)
        localArtifacts.push(artifact)
      }
      await this.store.writeState(request.runId, {
        stage: 'uploading',
        runFacts,
        localArtifacts: localArtifacts.map(({ name, mediaType, sha256, path: artifactPath }) => ({
          name, mediaType, sha256, path: artifactPath,
        })),
      })
      await this.callback.progress(request, 'uploading', { message: '正在上传 Artifact' }).catch(() => undefined)
      for (const artifact of localArtifacts) {
        const uploaded = await this.callback.uploadArtifact(request, artifact)
        uploadedArtifacts.push({
          artifactId: uploaded.artifactId,
          name: artifact.name,
          sha256: artifact.sha256,
        })
        await this.store.writeState(request.runId, { uploadedArtifacts })
      }
      await this.callback.progress(request, 'cleaning', { message: '正在清理工作区' }).catch(() => undefined)
      cleanup = await this.cleanupManager.cleanup({ workspace, appliedPolicy })
      await this.policyEnforcer.release(appliedPolicy).catch(() => undefined)
      appliedPolicy = null
      workspace = null
      pendingCompletion = {
        kind: 'execution',
        status: 'succeeded',
        artifacts: uploadedArtifacts,
        runFacts,
        cleanup,
      }
      await this.store.writeState(request.runId, { stage: 'complete_pending', completion: pendingCompletion })
      await this.callback.complete(request, pendingCompletion)
      await this.store.writeState(request.runId, { stage: 'terminal', terminalStatus: 'succeeded' })
    } catch (error) {
      const errorRunFacts = error?.runFacts
      if (!runFacts && errorRunFacts && typeof errorRunFacts === 'object' && !Array.isArray(errorRunFacts)) {
        runFacts = {
          ...errorRunFacts,
          platform: plan.agent.platform,
          agent: plan.agent.agent,
          ...(plan.agent.model ? { model: plan.agent.model } : {}),
        }
      }
      const normalized = error instanceof BenchmarkExecutorError
        ? error
        : new BenchmarkExecutorError(error?.code || 'EXECUTION_FAILED', error?.message || '执行器运行失败')
      if (pendingCompletion) {
        this.logError?.(`benchmark completion ${request.runId} pending delivery`, normalized)
        await this.store.writeState(request.runId, {
          stage: 'complete_pending',
          completion: pendingCompletion,
          callbackError: normalized.message,
        })
        return
      }
      if (workspace) {
        cleanup = await this.cleanupManager.cleanup({ workspace, appliedPolicy }).catch((cleanupError) => ({
          status: 'failed',
          message: cleanupError?.message || String(cleanupError),
        }))
      } else {
        cleanup = cleanup || { status: 'succeeded', finishedAt: new Date().toISOString() }
      }
      if (appliedPolicy) await this.policyEnforcer.release(appliedPolicy).catch(() => undefined)
      if (localArtifacts.length && uploadedArtifacts.length < localArtifacts.length && normalized.retryable) {
        await this.store.writeState(request.runId, {
          stage: 'upload_pending',
          runFacts,
          cleanup,
          localArtifacts: localArtifacts.map(({ name, mediaType, sha256, path: artifactPath }) => ({
            name, mediaType, sha256, path: artifactPath,
          })),
          uploadedArtifacts,
          error: { code: normalized.code, message: normalized.message },
        })
        return
      }
      const completion = {
        kind: 'execution',
        status: 'failed',
        artifacts: [],
        runFacts: runFacts || { finishedAt: new Date().toISOString() },
        cleanup,
        error: { code: normalized.code, message: normalized.message },
      }
      await this.store.writeState(request.runId, { stage: 'complete_pending', completion })
      try {
        await this.callback.complete(request, completion)
        await this.store.writeState(request.runId, { stage: 'terminal', terminalStatus: 'failed' })
      } catch (callbackError) {
        await this.store.writeState(request.runId, {
          stage: 'complete_pending',
          callbackError: callbackError?.message || String(callbackError),
        })
      }
    }
  }

  async resume(request, state) {
    if (state.stage === 'complete_pending' && state.completion) {
      await this.callback.complete(request, state.completion)
      await this.store.writeState(request.runId, {
        stage: 'terminal',
        terminalStatus: state.completion.status,
      })
      return
    }
    if (state.stage === 'upload_pending' && Array.isArray(state.localArtifacts)) {
      const uploadedArtifacts = Array.isArray(state.uploadedArtifacts) ? [...state.uploadedArtifacts] : []
      const uploadedNames = new Set(uploadedArtifacts.map((artifact) => artifact.name))
      for (const artifact of state.localArtifacts) {
        if (uploadedNames.has(artifact.name)) continue
        const bytes = await fsp.readFile(artifact.path)
        const uploaded = await this.callback.uploadArtifact(request, { ...artifact, bytes })
        uploadedArtifacts.push({
          artifactId: uploaded.artifactId,
          name: artifact.name,
          sha256: artifact.sha256,
        })
        await this.store.writeState(request.runId, { uploadedArtifacts })
      }
      const completion = {
        kind: 'execution',
        status: 'succeeded',
        artifacts: uploadedArtifacts,
        runFacts: state.runFacts || {},
        cleanup: state.cleanup || { status: 'succeeded' },
      }
      await this.store.writeState(request.runId, { stage: 'complete_pending', completion })
      await this.callback.complete(request, completion)
      await this.store.writeState(request.runId, { stage: 'terminal', terminalStatus: 'succeeded' })
      return
    }
    if (state.stage === 'accepted') {
      await this.execute(request)
      return
    }
    if (['preparing', 'agent_running', 'collecting', 'uploading', 'cleaning'].includes(state.stage)) {
      const provider = this.workspaceProviders.get(request.task.workspace.provider)
      const workspace = { path: path.join(provider.rootDir, request.runId) }
      const cleanup = await this.cleanupManager.cleanup({ workspace }).catch(() => ({ status: 'failed' }))
      const completion = {
        kind: 'execution',
        status: 'failed',
        artifacts: [],
        runFacts: { finishedAt: new Date().toISOString() },
        cleanup,
        error: { code: 'EXECUTOR_RESTARTED', message: '执行器重启，未自动重跑 Agent' },
      }
      await this.store.writeState(request.runId, { stage: 'complete_pending', completion })
      await this.callback.complete(request, completion)
      await this.store.writeState(request.runId, { stage: 'terminal', terminalStatus: 'failed' })
    }
  }
}

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new BenchmarkExecutorError('REQUEST_TOO_LARGE', '请求体超过上限', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const encoded = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(encoded.length),
    'cache-control': 'no-store',
  })
  res.end(encoded)
}

function createBenchmarkExecutor(options) {
  if (!options.clientId || !options.deviceCredential || !options.insightBaseUrl) {
    throw new Error('clientId, deviceCredential and insightBaseUrl are required')
  }
  const baseDir = options.baseDir || path.join(os.homedir(), '.agent-insight', 'client')
  const store = options.store || new FileRunStore(path.join(baseDir, 'benchmark-runs'))
  const workspaceProvider = options.workspaceProvider
    || new GitWorkspaceProvider(path.join(baseDir, 'workspaces', 'benchmark'))
  const workspaceProviders = options.workspaceProviders
    || new WorkspaceProviderRegistry([['git', workspaceProvider]])
  const configuredAgentPlatforms = options.agentPlatforms === undefined
    ? ['opencode']
    : Array.isArray(options.agentPlatforms) ? options.agentPlatforms : []
  const agentPlatforms = [
    ...new Set(configuredAgentPlatforms.map((platform) => String(platform || '').trim()).filter(Boolean)),
  ]
  const managesAgentRuntimes = !options.agentRuntimes
  const agentRuntimes = options.agentRuntimes || new AgentRuntimeRegistry()
  const runtimeCapability = { run: options.runAgent }
  const setAgentPlatforms = (platforms) => {
    if (!managesAgentRuntimes) {
      throw new Error('agent runtime registry is managed externally')
    }
    const normalized = [
      ...new Set((Array.isArray(platforms) ? platforms : [])
        .map((platform) => String(platform || '').trim())
        .filter(Boolean)),
    ]
    agentRuntimes.replace(normalized.map((platform) => [platform, runtimeCapability]))
    return normalized
  }
  if (managesAgentRuntimes) setAgentPlatforms(agentPlatforms)
  const collectors = options.collectors instanceof ArtifactCollectorRegistry
    ? options.collectors
    : new ArtifactCollectorRegistry(options.collectors || [['git-patch/v1', new GitPatchCollector()]])
  const callback = options.callback || new AgentInsightCallbackClient(options)
  const runner = options.runner || new BenchmarkExecutionRunner({
    store,
    workspaceProviders,
    agentRuntimes,
    policyEnforcer: options.policyEnforcer || new LocalPolicyEnforcer(),
    collectors,
    cleanupManager: options.cleanupManager || new WorkspaceCleanupManager(),
    callback,
    logError: options.logError,
  })
  if (typeof options.runAgent !== 'function' && !options.runner) {
    throw new Error('runAgent is required')
  }
  const credentialHash = deviceCredentialHash(options.deviceCredential)
  let activeRunId = null
  let deliveryRetryRunId = null
  let recoveryTimer = null
  let recoveryTimerDueAt = 0
  let closed = false

  function deliveryRetryDelay(attempt) {
    return Math.min(
      DELIVERY_RETRY_MAX_MS,
      DELIVERY_RETRY_BASE_MS * (2 ** Math.min(10, Math.max(0, attempt - 1))),
    )
  }

  function scheduleRecovery(delayMs = DELIVERY_RETRY_BASE_MS) {
    if (closed) return
    const delay = Math.max(0, delayMs)
    const dueAt = Date.now() + delay
    if (recoveryTimer && recoveryTimerDueAt <= dueAt) return
    if (recoveryTimer) clearTimeout(recoveryTimer)
    recoveryTimerDueAt = dueAt
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null
      recoveryTimerDueAt = 0
      recover().catch((error) => options.logError?.('executor recovery failed', error))
    }, delay)
    recoveryTimer.unref?.()
  }

  function tryAcquire(runId) {
    if (activeRunId) return false
    if (options.tryAcquireSlot && !options.tryAcquireSlot('benchmark')) return false
    activeRunId = runId
    return true
  }

  function release(runId) {
    if (activeRunId !== runId) return
    activeRunId = null
    options.releaseSlot?.('benchmark')
    scheduleRecovery()
  }

  function runInBackground(request, state) {
    queueMicrotask(async () => {
      try {
        if (state?.stage && state.stage !== 'accepted') await runner.resume(request, state)
        else await runner.execute(request)
      } catch (error) {
        options.logError?.(`benchmark run ${request.runId} failed`, error)
      } finally {
        release(request.runId)
      }
    })
  }

  function retryDeliveryInBackground(request, state) {
    if (closed || deliveryRetryRunId) return false
    deliveryRetryRunId = request.runId
    queueMicrotask(async () => {
      try {
        await runner.resume(request, state)
      } catch (error) {
        if (error?.retryable === false && Number(error?.status) >= 400 && Number(error?.status) < 500) {
          await store.writeState(request.runId, {
            stage: 'terminal',
            terminalStatus: state.completion?.status || 'failed',
            callbackError: error?.message || String(error),
          })
        } else {
          const latest = await store.state(request.runId)
          const retryCount = Math.max(0, Number(latest?.deliveryRetryCount) || 0) + 1
          const delayMs = deliveryRetryDelay(retryCount)
          await store.writeState(request.runId, {
            deliveryRetryCount: retryCount,
            nextDeliveryRetryAt: new Date(Date.now() + delayMs).toISOString(),
            callbackError: error?.message || String(error),
          })
          options.logError?.(`benchmark delivery retry ${request.runId} failed`, error)
        }
      } finally {
        deliveryRetryRunId = null
        scheduleRecovery(0)
      }
    })
    return true
  }

  function validateRequest(request, allowAlternateCallbackOrigin = false) {
    if (!request || typeof request !== 'object') {
      throw new BenchmarkExecutorError('TASK_SCHEMA_INVALID', '请求体不合法', 400)
    }
    const runId = String(request.runId || '')
    const digest = String(request.requestDigest || '')
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(runId)) {
      throw new BenchmarkExecutorError('RUN_ID_INVALID', 'runId 不合法', 400)
    }
    if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) {
      throw new BenchmarkExecutorError('REQUEST_DIGEST_INVALID', '请求摘要格式不合法', 400)
    }
    if (
      !Number.isInteger(request.timeoutSeconds)
      || request.timeoutSeconds < 1
      || request.timeoutSeconds > 86_400
    ) {
      throw new BenchmarkExecutorError('EXECUTION_TIMEOUT_INVALID', '执行超时必须在 1～86400 秒之间', 400)
    }
    if (dispatchDigest(request) !== digest) {
      throw new BenchmarkExecutorError('REQUEST_DIGEST_MISMATCH', '任务摘要不匹配', 403)
    }
    validateTaskEnvelope(request.task, runId)
    assertCallbackUrl(
      request.callbackBaseUrl,
      options.insightBaseUrl,
      runId,
      allowAlternateCallbackOrigin,
    )
    buildExecutionPlan(request.task, { workspaceProviders, agentRuntimes, collectors })
    return { runId, digest }
  }

  function authenticateHttpRequest(req, request, validated) {
    const { runId, digest } = validated
    if (req.headers['idempotency-key'] !== runId || req.headers['x-agent-insight-request-digest'] !== digest) {
      throw new BenchmarkExecutorError('DISPATCH_HEADER_MISMATCH', '幂等键或摘要 Header 不匹配', 400)
    }
    const payload = verifySignature(bearerToken(req.headers), credentialHash)
    if (
      payload.purpose !== 'execute'
      || payload.clientId !== options.clientId
      || payload.runId !== runId
      || payload.requestDigest !== digest
    ) {
      throw new BenchmarkExecutorError('DISPATCH_FORBIDDEN', '下发 token 与任务不匹配', 403)
    }
  }

  async function acceptValidatedRequest(request, { runId }) {
    const existing = await store.request(runId)
    if (existing) {
      const accepted = await store.accept(request)
      if (DELIVERY_RETRY_STAGES.has(accepted.state?.stage)) {
        scheduleRecovery(0)
      } else if (!activeRunId && accepted.state?.stage !== 'terminal' && tryAcquire(runId)) {
        runInBackground(request, accepted.state)
      }
      return
    }
    if (!tryAcquire(runId)) {
      throw new BenchmarkExecutorError('SERVICE_BUSY', '执行器当前有其他任务', 409, true)
    }
    try {
      await store.accept(request)
    } catch (error) {
      release(runId)
      throw error
    }
    runInBackground(request, { stage: 'accepted' })
  }

  async function acceptHttpRequest(req, request) {
    const validated = validateRequest(request)
    authenticateHttpRequest(req, request, validated)
    await acceptValidatedRequest(request, validated)
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://executor.local')
      if (req.method === 'GET' && url.pathname === '/health') {
        const payload = verifySignature(bearerToken(req.headers), credentialHash)
        if (payload.purpose !== 'health' || payload.clientId !== options.clientId) {
          throw new BenchmarkExecutorError('DISPATCH_FORBIDDEN', 'health token 不匹配', 403)
        }
        sendJson(res, 200, {
          serviceId: options.clientId,
          status: 'healthy',
          busy: Boolean(activeRunId),
          capabilities: options.capabilities || [
            ...workspaceProviders.keys().map((key) => `${key}-workspace/v1`),
            ...agentRuntimes.keys().map((key) => `agent-runtime/${key}/v1`),
            ...collectors.keys(),
          ],
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/benchmark-executions') {
        let request
        try {
          request = JSON.parse(await readRequestBody(req))
        } catch (error) {
          if (error instanceof BenchmarkExecutorError) throw error
          throw new BenchmarkExecutorError('REQUEST_JSON_INVALID', '请求体不是合法 JSON', 400)
        }
        await acceptHttpRequest(req, request)
        sendJson(res, 202, {
          runId: request.runId,
          status: 'accepted',
          requestDigest: request.requestDigest,
        })
        return
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '路由不存在', retryable: false } })
    } catch (error) {
      const normalized = error instanceof BenchmarkExecutorError
        ? error
        : new BenchmarkExecutorError('INTERNAL_ERROR', '执行器内部错误', 500)
      if (!res.headersSent) {
        sendJson(res, normalized.status, {
          error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable },
        })
      }
      options.logError?.('benchmark executor request failed', error)
    }
  })

  async function recover() {
    const runIds = await store.listRunIds()
    const now = Date.now()
    let executionCandidate = null
    let deliveryCandidate = null
    let nextDeliveryDelay = null
    for (const runId of runIds) {
      if (closed) break
      const [request, state] = await Promise.all([store.request(runId), store.state(runId)])
      if (!request || !state || state.stage === 'terminal') continue
      if (DELIVERY_RETRY_STAGES.has(state.stage)) {
        const retryAt = Date.parse(state.nextDeliveryRetryAt || '')
        const delay = Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 0
        if (delay === 0 && !deliveryCandidate) deliveryCandidate = { request, state }
        else if (delay > 0 && (nextDeliveryDelay === null || delay < nextDeliveryDelay)) {
          nextDeliveryDelay = delay
        }
        continue
      }
      if (!executionCandidate) executionCandidate = { runId, request, state }
    }
    if (!deliveryRetryRunId && deliveryCandidate) {
      retryDeliveryInBackground(deliveryCandidate.request, deliveryCandidate.state)
    } else if (!deliveryCandidate && nextDeliveryDelay !== null) {
      scheduleRecovery(nextDeliveryDelay)
    }
    if (!activeRunId && executionCandidate && tryAcquire(executionCandidate.runId)) {
      runInBackground(executionCandidate.request, executionCandidate.state)
    }
  }

  return {
    server,
    store,
    runner,
    get activeRunId() { return activeRunId },
    get agentPlatforms() { return agentRuntimes.keys() },
    setAgentPlatforms,
    async accept(request) {
      const validated = validateRequest(request, true)
      await acceptValidatedRequest(request, validated)
      return {
        runId: request.runId,
        status: 'accepted',
        requestDigest: request.requestDigest,
      }
    },
    async listen(host = '127.0.0.1', port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      await recover()
      return server.address()
    },
    async close() {
      closed = true
      if (recoveryTimer) clearTimeout(recoveryTimer)
      recoveryTimer = null
      recoveryTimerDueAt = 0
      if (!server.listening) return
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
    recover,
  }
}

module.exports = {
  AgentRuntimeRegistry,
  AgentInsightCallbackClient,
  ArtifactCollectorRegistry,
  BenchmarkExecutionRunner,
  BenchmarkExecutorError,
  FileRunStore,
  GitPatchCollector,
  GitWorkspaceProvider,
  LocalPolicyEnforcer,
  WorkspaceProviderRegistry,
  WorkspaceCleanupManager,
  buildExecutionPlan,
  canonicalJson,
  createBenchmarkExecutor,
  deviceCredentialHash,
  dispatchDigest,
  runProcess,
}

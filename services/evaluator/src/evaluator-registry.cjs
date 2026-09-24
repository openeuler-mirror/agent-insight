'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')

class EvaluatorProtocolError extends Error {
  constructor(code, message, status = 422, retryable = false) {
    super(message)
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

class AbstractBenchmarkEvaluator {
  constructor(key) {
    if (new.target === AbstractBenchmarkEvaluator) {
      throw new TypeError('AbstractBenchmarkEvaluator cannot be instantiated directly')
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) throw new TypeError('evaluator key is invalid')
    this.key = key
  }

  validateJob(job) {
    if (
      !job
      || job.protocolVersion !== 'benchmark-evaluation/v1'
      || !job.evaluationId
      || !job.executionRunId
      || job.evaluator?.key !== this.key
      || !job.benchmark?.key
      || !Array.isArray(job.artifacts)
      || !job.limits
      || !Number.isInteger(job.limits.timeoutSeconds)
      || job.limits.timeoutSeconds < 1
      || !Number.isFinite(job.limits.cpu)
      || job.limits.cpu <= 0
      || !Number.isInteger(job.limits.memoryMiB)
      || job.limits.memoryMiB < 1
    ) {
      throw new EvaluatorProtocolError('EVALUATION_JOB_INVALID', 'EvaluationJob 通用字段不合法')
    }
    const names = new Set()
    for (const artifact of job.artifacts) {
      if (
        artifact.executionRunId !== job.executionRunId
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(artifact.name || ''))
        || names.has(artifact.name)
        || !/^sha256:[0-9a-f]{64}$/i.test(String(artifact.sha256 || ''))
        || !Number.isInteger(artifact.sizeBytes)
        || artifact.sizeBytes < 1
        || artifact.sizeBytes > 64 * 1024 * 1024
      ) {
        throw new EvaluatorProtocolError('EVALUATION_ARTIFACT_INVALID', 'EvaluationJob Artifact 契约不合法')
      }
      names.add(artifact.name)
    }
    this.validateBenchmarkJob(job)
  }

  validateBenchmarkJob() {
    throw new Error('validateBenchmarkJob must be implemented')
  }

  assertEvaluationOutput(output, workDir) {
    if (
      !output
      || !['completed', 'submission_invalid', 'failed'].includes(output.completion?.status)
      || !output.completion.rawResult
      || typeof output.completion.rawResult !== 'object'
      || Array.isArray(output.completion.rawResult)
      || !Array.isArray(output.evidenceFiles)
    ) {
      throw new EvaluatorProtocolError('EVALUATION_OUTPUT_INVALID', 'Evaluator 输出不合法', 500)
    }
    const root = path.resolve(workDir)
    const names = new Set()
    for (const evidence of output.evidenceFiles) {
      const resolved = path.resolve(evidence.path)
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(evidence.name || ''))
        || names.has(evidence.name)
        || !resolved.startsWith(`${root}${path.sep}`)
        || !fs.statSync(resolved).isFile()
      ) {
        throw new EvaluatorProtocolError('EVALUATION_EVIDENCE_INVALID', 'Evaluator 证据文件不合法', 500)
      }
      names.add(evidence.name)
    }
    return output
  }
}

function schemaIssue(value, schema, currentPath = '$') {
  if (schema === true) return null
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return `${currentPath} Schema 不合法`
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const matchesType = (type) => {
    if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    if (type === 'array') return Array.isArray(value)
    if (type === 'integer') return Number.isInteger(value)
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
    if (type === 'null') return value === null
    return typeof value === type
  }
  if (types.length && !types.some(matchesType)) return `${currentPath} 类型不合法`
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return `${currentPath} 字符串过短`
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${currentPath} 格式不合法`
  }
  if (typeof value === 'number' && Number.isFinite(schema.minimum) && value < schema.minimum) {
    return `${currentPath} 小于最小值`
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = schemaIssue(value[index], schema.items, `${currentPath}[${index}]`)
      if (issue) return issue
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {}
    for (const key of schema.required || []) if (!(key in value)) return `${currentPath}.${key} 为必填字段`
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) {
        const issue = schemaIssue(item, properties[key], `${currentPath}.${key}`)
        if (issue) return issue
      } else if (schema.additionalProperties === false) return `${currentPath}.${key} 是未知字段`
    }
  }
  return null
}

function evaluationTimeoutError() {
  return new EvaluatorProtocolError(
    'EVALUATION_TIMEOUT',
    '评测执行超过 EvaluationJob 规定的时限',
    504,
    true,
  )
}

function signalProcessTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error?.code === 'ESRCH') return
    }
  }
  try { child.kill(signal) } catch {}
}

function runEntrypoint(descriptor, args, options = {}) {
  const direct = descriptor.command === 'direct'
  const command = direct
    ? descriptor.entrypoint
    : descriptor.command === 'node'
      ? process.execPath
      : process.env.EVALUATOR_PYTHON || 'python3'
  const commandArgs = direct ? args : [descriptor.entrypoint, ...args]
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let killTimer
    let aborted = false
    let settled = false
    const killGraceMs = Number.isFinite(options.killGraceMs)
      ? Math.max(0, options.killGraceMs)
      : 5_000
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const abort = () => {
      if (aborted || settled) return
      aborted = true
      signalProcessTree(child, 'SIGTERM')
      killTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), killGraceMs)
      killTimer.unref?.()
    }
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      callback()
    }
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => {
      if (aborted) signalProcessTree(child, 'SIGKILL')
      finish(() => reject(aborted ? evaluationTimeoutError() : error))
    })
    child.on('close', (code, signal) => {
      if (aborted) {
        signalProcessTree(child, 'SIGKILL')
        return finish(() => reject(evaluationTimeoutError()))
      }
      if (code === 0) return finish(() => resolve({ stdout, stderr }))
      let detail = (stderr || stdout).trim().slice(-4000)
      try { detail = JSON.parse(detail).message || detail } catch {}
      finish(() => reject(new EvaluatorProtocolError(
        options.errorCode || 'EVALUATOR_ENTRYPOINT_FAILED',
        `Evaluator Entrypoint 执行失败 (${signal || code})：${detail}`,
        500,
        options.retryable !== false,
      )))
    })
  })
}

async function inspectOciRuntime(descriptor, options = {}) {
  const commandRunner = options.commandRunner || runEntrypoint
  try {
    const result = await commandRunner({ command: 'direct', entrypoint: 'docker' }, [
      'image', 'inspect', descriptor.image,
      '--format', '{{index .Config.Labels "agent-insight.evaluator.artifact-digest"}}',
    ], { ...options, errorCode: 'EVALUATOR_RUNTIME_IMAGE_NOT_FOUND', retryable: false })
    return result.stdout.trim() === descriptor.artifactDigest
  } catch {
    return false
  }
}

async function ensureOciRuntime(descriptor, options = {}) {
  const commandRunner = options.commandRunner || runEntrypoint
  if (!descriptor.image || !/^sha256:[0-9a-f]{64}$/i.test(String(descriptor.artifactDigest || ''))) {
    throw new EvaluatorProtocolError('EVALUATOR_RUNTIME_INVALID', 'Evaluator OCI Runtime 描述不合法', 500)
  }
  if (await inspectOciRuntime(descriptor, options)) return
  const { recordManagedImage } = require('./service-control.cjs')
  const dataDir = process.env.EVALUATOR_DATA_DIR
  let ownership
  if (dataDir && !options.commandRunner) {
    const daemon = await commandRunner({ command: 'direct', entrypoint: 'docker' }, ['info', '--format', '{{.ID}}'], options)
    ownership = { reference: descriptor.image, daemonId: daemon.stdout.trim(), role: 'runtime', uncertain: true }
    await recordManagedImage(dataDir, ownership)
  }
  try {
    await commandRunner({ command: 'direct', entrypoint: 'docker' }, [
      'pull', descriptor.image,
    ], { ...options, errorCode: 'EVALUATOR_RUNTIME_IMAGE_UNAVAILABLE' })
  } catch (pullError) {
    if (!descriptor.dockerfile || !fs.existsSync(descriptor.dockerfile)) throw pullError
    await commandRunner({ command: 'direct', entrypoint: 'docker' }, [
      'build', '--file', descriptor.dockerfile,
      '--build-arg', `EVALUATOR_SOURCE_REVISION=${process.env.EVALUATOR_SOURCE_REVISION || 'unknown'}`,
      '--build-arg', `EVALUATOR_SOURCE_DIRTY=${process.env.EVALUATOR_SOURCE_DIRTY || 'false'}`,
      '--build-arg', `EVALUATOR_ARTIFACT_DIGEST=${descriptor.artifactDigest}`,
      '--tag', descriptor.image,
      path.resolve(__dirname, '../../..'),
    ], { ...options, errorCode: 'EVALUATOR_RUNTIME_BUILD_FAILED' })
  }
  if (!await inspectOciRuntime(descriptor, options)) {
    throw new EvaluatorProtocolError(
      'EVALUATOR_RUNTIME_IMAGE_MISMATCH',
      'Evaluator Runtime 镜像与 Catalog artifact digest 不一致',
      500,
      false,
    )
  }
  if (ownership) {
    const inspected = await commandRunner({ command: 'direct', entrypoint: 'docker' }, ['image', 'inspect', descriptor.image, '--format', '{{.Id}}'], options)
    await recordManagedImage(dataDir, { ...ownership, id: inspected.stdout.trim(), uncertain: false })
  }
}

async function runOciEntrypoint(descriptor, args, options = {}) {
  await ensureOciRuntime(descriptor, options)
  const controllerContainer = String(process.env.EVALUATOR_CONTROLLER_CONTAINER_ID || process.env.HOSTNAME || '').trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(controllerContainer)) {
    throw new EvaluatorProtocolError('EVALUATOR_CONTROLLER_ID_MISSING', '无法识别 Controller 容器', 500)
  }
  const resources = options.resources || descriptor.resources
  const dockerArgs = [
    'run', '--rm', '--init', '--volumes-from', controllerContainer,
    '--workdir', options.cwd || '/data',
    '--network', descriptor.network === 'allow' ? 'bridge' : 'none',
    '--cpus', String(resources.cpu),
    '--memory', `${resources.memoryMiB}m`,
    '--label', `agent-insight.benchmark-key=${descriptor.benchmarkKey}`,
    '--label', `agent-insight.evaluator-key=${descriptor.key}`,
    '--label', 'agent-insight.role=evaluator-runtime',
    '--label', `agent-insight.evaluator-instance=${controllerContainer}`,
  ]
  const runtimeEnv = { ...(options.env || {}) }
  runtimeEnv.EVALUATOR_INSTANCE_ID = controllerContainer
  if (options.evaluationId) dockerArgs.push('--label', `agent-insight.evaluation-id=${options.evaluationId}`)
  const forbiddenRuntimeEnv = new Set([
    'EVALUATOR_AGENT_INSIGHT_BASE_URL',
    'EVALUATOR_RUNTIME_ENV_NAMES',
  ])
  for (const name of String(process.env.EVALUATOR_RUNTIME_ENV_NAMES || '').split(',').filter(Boolean)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !name.startsWith('IMAGE_POOL_') && !forbiddenRuntimeEnv.has(name) && process.env[name] != null) {
      runtimeEnv[name] = process.env[name]
    }
  }
  for (const [name, value] of Object.entries(runtimeEnv)) {
    dockerArgs.push('--env', `${name}=${value}`)
  }
  dockerArgs.push(descriptor.image)
  if (descriptor.command !== 'direct') dockerArgs.push(descriptor.command)
  dockerArgs.push(descriptor.entrypoint, ...args)
  return runEntrypoint({ command: 'direct', entrypoint: 'docker' }, dockerArgs, options)
}

const RUNTIME_STRATEGIES = new Map([
  ['oci-container', runOciEntrypoint],
  ['controller-container', runEntrypoint],
  ['script-package', runEntrypoint],
  ['builtin', runEntrypoint],
])

function runtimeEnvironment(descriptor, limits) {
  const resources = limits || descriptor.resources
  return {
    EVALUATOR_RUNTIME: descriptor.runtime,
    EVALUATOR_NETWORK_POLICY: descriptor.network,
    EVALUATOR_CPU_LIMIT: String(resources.cpu),
    EVALUATOR_MEMORY_MIB_LIMIT: String(resources.memoryMiB),
    EVALUATOR_TIMEOUT_SECONDS: String(resources.timeoutSeconds),
  }
}

class FileEvaluatorEntrypoint extends AbstractBenchmarkEvaluator {
  constructor(descriptor, processRunner) {
    super(descriptor.key)
    const runtimeStrategy = RUNTIME_STRATEGIES.get(descriptor.runtime)
    if (!runtimeStrategy) throw new TypeError(`unsupported evaluator runtime: ${descriptor.runtime}`)
    this.descriptor = descriptor
    this.processRunner = processRunner || runtimeStrategy
  }

  async describeImages(payload, arch) {
    if (!this.descriptor.imageProvider) return []
    return require(this.descriptor.imageProvider).describeImages(payload, arch)
  }

  validateBenchmarkJob(job) {
    if (job.benchmark.key !== this.descriptor.benchmarkKey) {
      throw new EvaluatorProtocolError('EVALUATOR_BENCHMARK_MISMATCH', 'Evaluator 与 Benchmark 不匹配')
    }
    const expected = new Map(this.descriptor.requiredArtifacts.map((item) => [item.name, item]))
    if (job.artifacts.length !== expected.size) {
      throw new EvaluatorProtocolError('EVALUATION_ARTIFACT_INVALID', 'EvaluationJob Artifact 数量不符合 Manifest')
    }
    for (const artifact of job.artifacts) {
      const contract = expected.get(artifact.name)
      if (!contract || contract.mediaType !== artifact.mediaType || artifact.sizeBytes > contract.maxBytes) {
        throw new EvaluatorProtocolError('EVALUATION_ARTIFACT_INVALID', `Artifact 不符合 Manifest：${artifact.name}`)
      }
    }
    const resources = this.descriptor.resources
    if (
      !resources
      || job.limits.cpu > resources.cpu
      || job.limits.memoryMiB > resources.memoryMiB
      || job.limits.timeoutSeconds > resources.timeoutSeconds
    ) {
      throw new EvaluatorProtocolError('EVALUATION_RESOURCE_LIMIT_INVALID', 'EvaluationJob 超出 Evaluator 声明的资源上限')
    }
  }

  async checkReady(runtime) {
    if (this.descriptor.runtime === 'oci-container' && !await inspectOciRuntime(this.descriptor)) {
      return {
        ready: true,
        formalEligible: true,
        runtimeFacts: {
          runtime: this.descriptor.runtime,
          artifactDigest: this.descriptor.artifactDigest,
          image: this.descriptor.image,
          cached: false,
        },
      }
    }
    try {
      const result = await this.processRunner(this.descriptor, ['doctor'], {
        env: {
          EVALUATOR_DATA_DIR: runtime.dataDir,
          EVALUATOR_HOST_OS: runtime.hostOS,
          EVALUATOR_HOST_ARCH: runtime.hostArch,
          ...runtimeEnvironment(this.descriptor),
        },
        errorCode: 'EVALUATOR_DOCTOR_FAILED',
      })
      const output = JSON.parse(result.stdout.trim() || '{}')
      return {
        ready: output.ready === true,
        formalEligible: output.formalEligible === true,
        ...(output.reason ? { reason: output.reason } : {}),
        runtimeFacts: {
          runtime: this.descriptor.runtime,
          artifactDigest: this.descriptor.artifactDigest,
          ...(output.runtimeFacts || {}),
        },
      }
    } catch (error) {
      return { ready: false, formalEligible: false, reason: error.message }
    }
  }

  async smoke(runtime) {
    if (!this.descriptor.smokeEntrypoint) {
      return { supported: false, evaluatorKey: this.key, reason: '该 Evaluator 未提供部署 Smoke' }
    }
    const descriptor = {
      ...this.descriptor,
      entrypoint: this.descriptor.runtimeSmokeEntrypoint || this.descriptor.smokeEntrypoint,
    }
    const result = await this.processRunner(descriptor, [], {
      env: {
        EVALUATOR_DATA_DIR: runtime.dataDir,
        EVALUATOR_HOST_OS: runtime.hostOS,
        EVALUATOR_HOST_ARCH: runtime.hostArch,
        ...runtimeEnvironment(this.descriptor),
      },
      errorCode: 'EVALUATOR_SMOKE_FAILED',
      retryable: false,
    })
    const output = JSON.parse(result.stdout.trim() || '{}')
    if (output.purpose !== 'deployment_smoke' || output.evaluatorKey !== this.key) {
      throw new EvaluatorProtocolError('EVALUATOR_SMOKE_OUTPUT_INVALID', 'Evaluator Smoke 输出不合法', 500)
    }
    return { supported: true, ...output }
  }

  async evaluate(input) {
    const contractDir = path.join(input.workDir, 'entrypoint')
    const inputDir = path.join(contractDir, 'input')
    const outputDir = path.join(contractDir, 'output')
    const artifactDir = path.join(inputDir, 'artifacts')
    await fsp.rm(contractDir, { recursive: true, force: true })
    await fsp.mkdir(artifactDir, { recursive: true, mode: 0o700 })
    await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 })
    const artifacts = []
    for (const local of input.artifacts.values()) {
      const artifactPath = path.join(artifactDir, local.descriptor.name)
      await fsp.copyFile(local.path, artifactPath)
      await fsp.chmod(artifactPath, 0o400)
      artifacts.push({ descriptor: local.descriptor, path: `artifacts/${local.descriptor.name}` })
    }
    const requestPath = path.join(inputDir, 'request.json')
    const casePath = path.join(inputDir, 'case.json')
    const outputPath = path.join(outputDir, 'result.json')
    await fsp.writeFile(requestPath, `${JSON.stringify({
      schemaVersion: 'evaluator-entrypoint/v1',
      evaluationJob: input.job,
      ...(input.preparedImages ? { preparedImages: input.preparedImages } : {}),
      artifacts,
    }, null, 2)}\n`, { mode: 0o400 })
    await fsp.writeFile(casePath, `${JSON.stringify(input.job.payload, null, 2)}\n`, { mode: 0o400 })
    if (this.descriptor.runtime === 'oci-container') {
      await input.reportProgress({
        kind: 'evaluation',
        stage: 'preparing_runtime',
        occurredAt: new Date().toISOString(),
      })
    }
    await this.processRunner(this.descriptor, [
      'evaluate', '--request', requestPath, '--output', outputPath,
    ], {
      cwd: contractDir,
      signal: input.signal,
      env: runtimeEnvironment(this.descriptor, input.job.limits),
      resources: input.job.limits,
      evaluationId: input.job.evaluationId,
    })
    let rawOutput
    try { rawOutput = JSON.parse(await fsp.readFile(outputPath, 'utf8')) }
    catch { throw new EvaluatorProtocolError('EVALUATION_OUTPUT_MISSING', 'Evaluator 未生成 result.json', 500, true) }
    if (rawOutput.protocolVersion !== 'evaluator-output/v1') {
      throw new EvaluatorProtocolError('EVALUATION_OUTPUT_INVALID', 'Evaluator 输出协议不兼容', 500)
    }
    if (rawOutput.completion?.status !== 'failed') {
      const issue = schemaIssue(rawOutput.completion?.rawResult, this.descriptor.rawResultSchema)
      if (issue) throw new EvaluatorProtocolError('RAW_RESULT_SCHEMA_INVALID', `Evaluator 原生结果不合法：${issue}`, 500)
    }
    const result = {
      completion: rawOutput.completion,
      evidenceFiles: (rawOutput.evidenceFiles || []).map((evidence) => ({
        ...evidence,
        path: path.resolve(outputDir, evidence.path),
      })),
    }
    return this.assertEvaluationOutput(result, outputDir)
  }
}

class EvaluatorRegistry {
  constructor(evaluators = []) {
    this.evaluators = new Map()
    for (const evaluator of evaluators) this.register(evaluator)
  }

  register(evaluator) {
    const benchmarkKey = evaluator.descriptor?.benchmarkKey || '*'
    const registryKey = `${evaluator.key}\n${benchmarkKey}`
    if (this.evaluators.has(registryKey)) {
      throw new TypeError(`duplicate evaluator binding: ${evaluator.key}/${benchmarkKey}`)
    }
    this.evaluators.set(registryKey, evaluator)
  }

  get(key, benchmarkKey) {
    const evaluator = this.evaluators.get(`${key}\n${benchmarkKey}`)
      || this.evaluators.get(`${key}\n*`)
    if (!evaluator) throw new EvaluatorProtocolError('EVALUATOR_NOT_FOUND', `未注册 Evaluator：${key}`, 422)
    return evaluator
  }

  values() {
    return [...this.evaluators.values()]
  }
}

module.exports = {
  AbstractBenchmarkEvaluator,
  EvaluatorProtocolError,
  EvaluatorRegistry,
  FileEvaluatorEntrypoint,
  ensureOciRuntime,
  evaluationTimeoutError,
  runEntrypoint,
  runOciEntrypoint,
  schemaIssue,
  signalProcessTree,
}

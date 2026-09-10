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
    if (output.evidenceFiles.length < 1) {
      throw new EvaluatorProtocolError('EVALUATION_EVIDENCE_MISSING', 'Evaluator 未生成证据文件', 500)
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

class FileEvaluatorEntrypoint extends AbstractBenchmarkEvaluator {
  constructor(descriptor, processRunner = runEntrypoint) {
    super(descriptor.key)
    this.descriptor = descriptor
    this.processRunner = processRunner
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
  }

  async checkReady(runtime) {
    try {
      const result = await this.processRunner(this.descriptor, ['doctor'], {
        env: {
          EVALUATOR_DATA_DIR: runtime.dataDir,
          EVALUATOR_HOST_OS: runtime.hostOS,
          EVALUATOR_HOST_ARCH: runtime.hostArch,
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
    const descriptor = { ...this.descriptor, entrypoint: this.descriptor.smokeEntrypoint }
    const result = await this.processRunner(descriptor, [], {
      env: {
        EVALUATOR_DATA_DIR: runtime.dataDir,
        EVALUATOR_HOST_OS: runtime.hostOS,
        EVALUATOR_HOST_ARCH: runtime.hostArch,
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
      artifacts,
    }, null, 2)}\n`, { mode: 0o400 })
    await fsp.writeFile(casePath, `${JSON.stringify(input.job.payload, null, 2)}\n`, { mode: 0o400 })
    await this.processRunner(this.descriptor, [
      'evaluate', '--request', requestPath, '--output', outputPath,
    ], { cwd: contractDir, signal: input.signal })
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
    if (this.evaluators.has(evaluator.key)) {
      throw new TypeError(`duplicate evaluator key: ${evaluator.key}`)
    }
    this.evaluators.set(evaluator.key, evaluator)
  }

  get(key) {
    const evaluator = this.evaluators.get(key)
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
  evaluationTimeoutError,
  runEntrypoint,
  schemaIssue,
  signalProcessTree,
}

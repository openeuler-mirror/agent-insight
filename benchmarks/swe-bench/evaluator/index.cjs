'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const {
  AbstractBenchmarkEvaluator,
  EvaluatorProtocolError,
} = require('../../../services/evaluator/src/evaluator-registry.cjs')

const OFFICIAL_COMMIT = '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e'

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let killTimer
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const abort = () => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      killTimer.unref?.()
    }
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => {
      clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      if (code === 0) return resolve({ stdout, stderr })
      reject(new EvaluatorProtocolError(
        options.errorCode || 'PROCESS_FAILED',
        `${command} 执行失败 (${signal || code}): ${(stderr || stdout).slice(-4000)}`,
        500,
        options.retryable !== false,
      ))
    })
  })
}

function imageRepository(image) {
  const withoutDigest = image.split('@')[0]
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest
}

class SweBenchImageResolver {
  constructor(processRunner = runProcess) {
    this.processRunner = processRunner
  }

  async dockerArchitecture(signal) {
    const result = await this.processRunner(
      'docker',
      ['info', '--format', '{{.Architecture}}'],
      { signal, errorCode: 'DOCKER_UNAVAILABLE' },
    )
    const value = result.stdout.trim().toLowerCase()
    if (['amd64', 'x86_64'].includes(value)) return 'x86_64'
    if (['arm64', 'aarch64'].includes(value)) return 'arm64'
    throw new EvaluatorProtocolError('SWE_ARCH_UNSUPPORTED', `不支持 Docker 架构：${value}`, 422)
  }

  imageFor(jobImage, instanceId, arch) {
    const source = String(process.env.SWE_BENCH_IMAGE_SOURCE || 'official').trim()
    const configuredArch = String(process.env.SWE_BENCH_IMAGE_ARCH || 'auto').trim()
    const allowNonOfficial = process.env.SWE_BENCH_ALLOW_NON_OFFICIAL === 'true'
    if (!['official', 'epoch'].includes(source) || !['auto', 'x86_64', 'arm64'].includes(configuredArch)) {
      throw new EvaluatorProtocolError('SWE_IMAGE_CONFIGURATION_INVALID', 'SWE-bench 镜像配置不合法', 500)
    }
    const selectedArch = configuredArch === 'auto' ? arch : configuredArch
    if (selectedArch !== arch) {
      throw new EvaluatorProtocolError('SWE_IMAGE_ARCH_MISMATCH', '配置的镜像架构与 Docker daemon 不一致', 422)
    }
    if (source === 'epoch') {
      if (!allowNonOfficial || selectedArch !== 'arm64') {
        throw new EvaluatorProtocolError(
          'SWE_NON_OFFICIAL_IMAGE_FORBIDDEN',
          'Epoch 镜像只允许在显式开启的 ARM64 smoke 中使用',
          422,
        )
      }
      return {
        image: `ghcr.io/epoch-research/swe-bench.eval.arm64.${instanceId}:latest`,
        source,
        arch: selectedArch,
        formalEligible: false,
      }
    }
    const image = selectedArch === 'arm64'
      ? jobImage.replace('.x86_64.', '.arm64.')
      : jobImage.replace('.arm64.', '.x86_64.')
    if (!/^swebench\/sweb\.eval\.(x86_64|arm64)\.[a-z0-9_.-]+:[a-z0-9_.-]+$/i.test(image)) {
      throw new EvaluatorProtocolError('SWE_IMAGE_FORBIDDEN', 'EvaluationJob 镜像不在官方白名单', 422)
    }
    return {
      image,
      source,
      arch: selectedArch,
      formalEligible: selectedArch === 'x86_64',
    }
  }

  async resolve(jobImage, instanceId, workDir, signal) {
    const frozenPath = path.join(workDir, 'resolved-image.json')
    try {
      return JSON.parse(await fs.readFile(frozenPath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const daemonArch = await this.dockerArchitecture(signal)
    const selected = this.imageFor(jobImage, instanceId, daemonArch)
    const inspectArgs = ['image', 'inspect', selected.image, '--format', '{{json .RepoDigests}}']
    let inspected
    try {
      inspected = await this.processRunner('docker', inspectArgs, {
        signal,
        errorCode: 'SWE_IMAGE_NOT_LOCAL',
        retryable: false,
      })
    } catch {
      await this.processRunner('docker', ['pull', selected.image], {
        signal,
        errorCode: 'SWE_IMAGE_UNAVAILABLE',
      })
      inspected = await this.processRunner('docker', inspectArgs, {
        signal,
        errorCode: 'SWE_IMAGE_INSPECT_FAILED',
      })
    }
    let digests
    try { digests = JSON.parse(inspected.stdout.trim()) } catch {}
    const repository = imageRepository(selected.image)
    const pinnedImage = Array.isArray(digests)
      ? digests.find((value) => String(value).startsWith(`${repository}@sha256:`))
      : null
    if (!pinnedImage) {
      throw new EvaluatorProtocolError('SWE_IMAGE_DIGEST_MISSING', '无法固定 Case 镜像 digest', 500)
    }
    const frozen = { ...selected, daemonArch, pinnedImage }
    const temporary = `${frozenPath}.${process.pid}.tmp`
    await fs.writeFile(temporary, JSON.stringify(frozen, null, 2), { mode: 0o600 })
    await fs.rename(temporary, frozenPath)
    return frozen
  }
}

class SweBenchEvaluator extends AbstractBenchmarkEvaluator {
  constructor(options = {}) {
    super('swe-bench')
    this.processRunner = options.processRunner || runProcess
    this.imageResolver = options.imageResolver || new SweBenchImageResolver(this.processRunner)
    this.python = options.python || process.env.SWE_BENCH_PYTHON || 'python3'
    this.entrypoint = options.entrypoint || path.join(__dirname, 'run.py')
  }

  validateBenchmarkJob(job) {
    if (job.benchmark.key !== 'swe-bench') {
      throw new EvaluatorProtocolError('SWE_BENCHMARK_MISMATCH', 'SWE-bench Evaluator 收到其他 Benchmark')
    }
    const payload = job.payload
    const instance = payload?.instance
    const prediction = payload?.prediction
    const instanceKeys = [
      'instance_id', 'repo', 'base_commit', 'version', 'image', 'eval_script',
      'eval_type', 'log_parser', 'FAIL_TO_PASS', 'PASS_TO_PASS',
    ]
    const predictionKeys = ['instance_id', 'model_name_or_path', 'model_patch_artifact_id']
    if (
      !instance || typeof instance !== 'object' || Array.isArray(instance)
      || !prediction || typeof prediction !== 'object' || Array.isArray(prediction)
      || Object.keys(instance).some((key) => !instanceKeys.includes(key))
      || Object.keys(prediction).some((key) => !predictionKeys.includes(key))
      || !String(instance.instance_id || '').trim()
      || !/^[A-Za-z0-9_.-]+$/.test(String(instance.instance_id || ''))
      || prediction.instance_id !== instance.instance_id
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(instance.repo || ''))
      || !/^[0-9a-f]{40}$/i.test(String(instance.base_commit || ''))
      || !String(instance.eval_script || '').trim()
      || !String(instance.eval_type || '').trim()
      || !String(instance.log_parser || '').trim()
      || !/^[A-Za-z0-9._/-]{1,256}$/.test(String(prediction.model_name_or_path || ''))
      || String(prediction.model_name_or_path).includes('..')
      || !Array.isArray(instance.FAIL_TO_PASS)
      || !Array.isArray(instance.PASS_TO_PASS)
    ) {
      throw new EvaluatorProtocolError('SWE_EVALUATION_JOB_INVALID', 'SWE-bench EvaluationJob 不合法')
    }
    if (!/^swebench\/sweb\.eval\.(x86_64|arm64)\.[a-z0-9_.-]+:[a-z0-9_.-]+$/i.test(String(instance.image))) {
      throw new EvaluatorProtocolError('SWE_IMAGE_FORBIDDEN', 'EvaluationJob 镜像不在官方白名单')
    }
    const patch = job.artifacts.find((artifact) => artifact.name === 'model.patch')
    if (!patch || patch.artifactId !== prediction.model_patch_artifact_id || job.artifacts.length !== 1) {
      throw new EvaluatorProtocolError('SWE_PATCH_ARTIFACT_INVALID', 'SWE-bench 必须且只能引用 model.patch')
    }
  }

  async checkReady(runtime) {
    try {
      const [python, arch] = await Promise.all([
        this.processRunner(this.python, ['-c', 'import docker, swebench'], {
          errorCode: 'SWE_BENCH_PYTHON_NOT_READY',
        }),
        this.imageResolver.dockerArchitecture(),
      ])
      const hostOS = process.env.EVALUATOR_HOST_OS || runtime.hostOS || os.platform()
      const hostArch = process.env.EVALUATOR_HOST_ARCH || runtime.hostArch || os.arch()
      const imageSource = String(process.env.SWE_BENCH_IMAGE_SOURCE || 'official').trim()
      const formalEligible = hostOS === 'linux' && arch === 'x86_64' && imageSource === 'official'
      return {
        ready: true,
        formalEligible,
        runtimeFacts: {
          hostOS,
          hostArch,
          dockerArch: arch,
          harnessSourceCommit: OFFICIAL_COMMIT,
          python: python.stdout.trim() || this.python,
          dataDir: runtime.dataDir,
          imageSource,
        },
      }
    } catch (error) {
      return { ready: false, reason: error.message }
    }
  }

  async evaluate(input) {
    const instance = input.job.payload.instance
    const patchArtifact = input.artifacts.get('model.patch')
    if (!patchArtifact) {
      throw new EvaluatorProtocolError('SWE_PATCH_ARTIFACT_MISSING', '本地缺少 model.patch', 500)
    }
    await input.reportProgress({
      kind: 'evaluation',
      stage: 'resolving_image',
      occurredAt: new Date().toISOString(),
    })
    const image = await this.imageResolver.resolve(
      instance.image,
      instance.instance_id,
      input.workDir,
      input.signal,
    )
    const runnerInputPath = path.join(input.workDir, 'harness-input.json')
    const runnerOutputPath = path.join(input.workDir, 'harness-output.json')
    await fs.writeFile(runnerInputPath, JSON.stringify({
      evaluationId: input.job.evaluationId,
      instance: { ...instance, image: image.pinnedImage },
      prediction: {
        instance_id: input.job.payload.prediction.instance_id,
        model_name_or_path: input.job.payload.prediction.model_name_or_path,
        model_patch_path: patchArtifact.path,
      },
      limits: input.job.limits,
      runtimeFacts: {
        harnessSourceCommit: OFFICIAL_COMMIT,
        caseImage: image.pinnedImage,
        imageSource: image.source,
        dockerArch: image.daemonArch,
        formalEligible: image.formalEligible,
      },
    }, null, 2), { mode: 0o600 })
    await input.reportProgress({
      kind: 'evaluation',
      stage: 'running_harness',
      occurredAt: new Date().toISOString(),
    })
    await this.processRunner(this.python, [this.entrypoint, runnerInputPath, runnerOutputPath], {
      cwd: input.workDir,
      signal: input.signal,
      errorCode: 'SWE_HARNESS_ENTRYPOINT_FAILED',
    })
    let result
    try { result = JSON.parse(await fs.readFile(runnerOutputPath, 'utf8')) } catch {
      throw new EvaluatorProtocolError('SWE_HARNESS_RESULT_MISSING', 'SWE-bench Harness 未生成结果', 500, true)
    }
    const output = {
      completion: {
        status: result.status,
        rawResult: result.rawResult,
        runtimeFacts: result.runtimeFacts,
        cleanup: result.cleanup,
        ...(result.error ? { error: result.error } : {}),
      },
      evidenceFiles: result.evidenceFiles.map((evidence) => ({
        ...evidence,
        path: path.resolve(input.workDir, evidence.path),
      })),
    }
    return this.assertEvaluationOutput(output, input.workDir)
  }
}

module.exports = {
  OFFICIAL_COMMIT,
  EvaluatorProtocolError,
  SweBenchEvaluator,
  SweBenchImageResolver,
  runProcess,
}

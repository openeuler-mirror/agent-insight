'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const {
  AbstractBenchmarkEvaluator,
  EvaluatorProtocolError,
  evaluationTimeoutError,
  signalProcessTree,
} = require('../../../services/evaluator/src/evaluator-registry.cjs')

const OFFICIAL_COMMIT = '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e'
const DEFAULT_VERIFIED_IMAGE_MIRROR_REPOSITORIES = [
  'swr.cn-east-3.myhuaweicloud.com/agent-insight/swebench-verified-x86-64-a',
  'swr.cn-east-3.myhuaweicloud.com/agent-insight/swebench-verified-x86-64-b',
]

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
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
      finish(() => reject(new EvaluatorProtocolError(
        options.errorCode || 'PROCESS_FAILED',
        `${command} 执行失败 (${signal || code}): ${(stderr || stdout).slice(-4000)}`,
        500,
        options.retryable !== false,
      )))
    })
  })
}

function imageRepository(image) {
  const withoutDigest = image.split('@')[0]
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest
}

function imageProxyPrefix() {
  const configured = process.env.SWE_BENCH_IMAGE_PROXY_PREFIX
  const prefix = String(configured === undefined ? '' : configured)
    .trim()
    .replace(/\/+$/, '')
  if (prefix && !/^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)*$/i.test(prefix)) {
    throw new EvaluatorProtocolError('SWE_IMAGE_CONFIGURATION_INVALID', 'SWE-bench 镜像代理前缀不合法', 500)
  }
  return prefix
}

function verifiedImageMirrorRepositories() {
  const configured = process.env.SWE_BENCH_VERIFIED_MIRROR_REPOS === undefined
    ? DEFAULT_VERIFIED_IMAGE_MIRROR_REPOSITORIES.join(',')
    : String(process.env.SWE_BENCH_VERIFIED_MIRROR_REPOS).trim()
  if (!configured) return []
  const repositories = configured.split(',').map((value) => value.trim())
  if (
    repositories.length > 8
    || repositories.some((repository) => (
      !repository
      || !/^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+$/.test(repository)
    ))
  ) {
    throw new EvaluatorProtocolError(
      'SWE_IMAGE_CONFIGURATION_INVALID',
      'SWE-bench Verified 镜像仓库配置不合法',
      500,
    )
  }
  return [...new Set(repositories)]
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
    const proxyPrefix = imageProxyPrefix()
    const proxyImage = proxyPrefix ? `${proxyPrefix}/${selected.image}` : null
    const mirrorRepositories = selected.source === 'official' && selected.arch === 'x86_64'
      ? verifiedImageMirrorRepositories()
      : []
    const mirrorImages = mirrorRepositories.map((repository) => `${repository}:${instanceId}`)
    const inspectArgs = [
      'image', 'inspect', selected.image,
      '--format', '{{json .RepoDigests}}|{{.Id}}',
    ]
    let inspected
    let resolvedImageReference = selected.image
    try {
      inspected = await this.processRunner('docker', inspectArgs, {
        signal,
        errorCode: 'SWE_IMAGE_NOT_LOCAL',
        retryable: false,
      })
    } catch {
      let pulled = false
      for (const mirrorImage of mirrorImages) {
        try {
          await this.processRunner('docker', ['pull', mirrorImage], {
            signal,
            errorCode: 'SWE_IMAGE_MIRROR_UNAVAILABLE',
          })
          await this.processRunner('docker', ['tag', mirrorImage, selected.image], {
            signal,
            errorCode: 'SWE_IMAGE_TAG_FAILED',
          })
          resolvedImageReference = mirrorImage
          pulled = true
          break
        } catch (error) {
          if (signal?.aborted) throw error
        }
      }
      if (!pulled && proxyImage) {
        try {
          await this.processRunner('docker', ['pull', proxyImage], {
            signal,
            errorCode: 'SWE_IMAGE_PROXY_UNAVAILABLE',
          })
          await this.processRunner('docker', ['tag', proxyImage, selected.image], {
            signal,
            errorCode: 'SWE_IMAGE_TAG_FAILED',
          })
          resolvedImageReference = proxyImage
          pulled = true
        } catch (error) {
          if (signal?.aborted) throw error
        }
      }
      if (!pulled) {
        await this.processRunner('docker', ['pull', selected.image], {
          signal,
          errorCode: 'SWE_IMAGE_UNAVAILABLE',
        })
      }
      inspected = await this.processRunner('docker', inspectArgs, {
        signal,
        errorCode: 'SWE_IMAGE_INSPECT_FAILED',
      })
    }
    const separator = inspected.stdout.lastIndexOf('|')
    const digestsJson = separator >= 0 ? inspected.stdout.slice(0, separator) : inspected.stdout
    const localImageId = separator >= 0 ? inspected.stdout.slice(separator + 1).trim() : ''
    let digests
    try { digests = JSON.parse(digestsJson.trim()) } catch {}
    const repositories = [imageRepository(selected.image)]
    repositories.push(...mirrorImages.map(imageRepository))
    if (proxyImage) repositories.push(imageRepository(proxyImage))
    const repositoryDigest = Array.isArray(digests)
      ? digests.find((value) => repositories.some((repository) => (
          String(value).startsWith(`${repository}@sha256:`)
        )))
      : null
    const pinnedImage = repositoryDigest
      || (/^sha256:[0-9a-f]{64}$/i.test(localImageId) ? localImageId : null)
    if (!pinnedImage) {
      throw new EvaluatorProtocolError('SWE_IMAGE_DIGEST_MISSING', '无法固定 Case 镜像 digest', 500)
    }
    const frozen = {
      ...selected,
      daemonArch,
      pinnedImage,
      resolvedImageReference,
      imageMirrorRepositories: mirrorRepositories,
      imageProxyPrefix: proxyPrefix || null,
    }
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
      const proxyPrefix = imageProxyPrefix()
      const mirrorRepositories = arch === 'x86_64' && imageSource === 'official'
        ? verifiedImageMirrorRepositories()
        : []
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
          imageMirrorRepositories: mirrorRepositories,
          imageProxyPrefix: proxyPrefix || null,
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
    const prepared = input.preparedImages?.[0]
    const image = prepared || await this.imageResolver.resolve(
      instance.image,
      instance.instance_id,
      input.workDir,
      input.signal,
    )
    if (prepared) {
      const selected = this.imageResolver.imageFor(instance.image, instance.instance_id, prepared.daemonArch)
      if (prepared.image !== selected.image || !/^sha256:[a-f0-9]{64}$/i.test(prepared.imageId)) {
        throw new EvaluatorProtocolError('SWE_PREPARED_IMAGE_INVALID', '公共池镜像与评测实例不匹配', 500)
      }
      await this.processRunner('docker', ['image', 'inspect', prepared.imageId], { signal: input.signal, errorCode: 'SWE_PREPARED_IMAGE_MISSING' })
    }
    const runnerInputPath = path.join(input.workDir, 'harness-input.json')
    const runnerOutputPath = path.join(input.workDir, 'harness-output.json')
    await fs.writeFile(runnerInputPath, JSON.stringify({
      evaluationId: input.job.evaluationId,
      managedImage: Boolean(prepared),
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
        resolvedImageReference: image.resolvedImageReference,
        imageMirrorRepositories: image.imageMirrorRepositories,
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
  imageProxyPrefix,
  verifiedImageMirrorRepositories,
}

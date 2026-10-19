'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')

class EvaluatorAssetError extends Error {
  constructor(code, message, retryable = false) {
    super(message)
    this.code = code
    this.status = retryable ? 409 : 422
    this.retryable = retryable
  }
}

const assetError = (code, message, retryable) => new EvaluatorAssetError(code, message, retryable)

class EvaluatorAssets {
  constructor(descriptor, runner, options = {}) {
    this.descriptor = descriptor
    this.runner = runner
    this.dataDir = options.dataDir || process.env.EVALUATOR_DATA_DIR || '/data'
    this.environment = options.environment || process.env
    this.retryDelayMs = options.retryDelayMs ?? 2000
    this.stage = 'pending'
    this.controller = new AbortController()
  }

  start() {
    if (!this.task) {
      this.task = this.prepare().catch(error => {
        this.error = error.code?.startsWith('EVALUATOR_ASSETS_') ? error
          : assetError('EVALUATOR_ASSETS_INSTALL_FAILED', `评测资产安装失败：${error.message}`)
        this.stage = 'failed'
        console.error(`[evaluator/assets] ${this.descriptor.benchmarkKey}: ${this.error.message}`)
      })
    }
    return this.task
  }

  assertReady() {
    this.start()
    if (this.error) throw this.error
    if (this.stage !== 'ready') {
      const code = this.stage === 'downloading' ? 'EVALUATOR_ASSETS_DOWNLOADING'
        : this.stage === 'verifying' ? 'EVALUATOR_ASSETS_VERIFYING' : 'EVALUATOR_ASSETS_PREPARING'
      throw assetError(code, this.stage === 'downloading' ? '正在下载评测资产'
        : this.stage === 'verifying' ? '正在校验评测资产' : '正在准备评测资产', true)
    }
    return this.root
  }

  async ensure() {
    await this.start()
    return this.assertReady()
  }

  async command(command, args) {
    return this.runner({ command: 'direct', entrypoint: command }, args, {
      env: { PYTHONDONTWRITEBYTECODE: '1' },
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10 * 60_000)]),
    })
  }

  async verify(root) {
    this.stage = 'verifying'
    try {
      await this.command(this.descriptor.assets.verifyCommand, [
        this.descriptor.assets.verifyEntrypoint, root,
        this.descriptor.assets.releaseId, this.descriptor.assets.bundleDigest,
      ])
    } catch (error) {
      throw assetError('EVALUATOR_ASSETS_INVALID', `评测资产校验失败：${error.message}`)
    }
  }

  async prepare() {
    const spec = this.descriptor.assets
    const base = this.environment[spec.directoryEnv] || path.join(this.dataDir, 'benchmark-assets', this.descriptor.benchmarkKey)
    if (!path.isAbsolute(base)) throw assetError('EVALUATOR_ASSETS_DIRECTORY_INVALID', '评测资产根目录必须为绝对路径')
    this.root = path.join(base, spec.image.split('@sha256:')[1])
    this.stage = 'preparing'
    await fs.mkdir(base, { recursive: true })
    if (this.descriptor.runtime === 'oci-container') {
      const instance = this.environment.EVALUATOR_CONTROLLER_CONTAINER_ID || this.environment.HOSTNAME
      const inspected = await this.command('docker', ['inspect', instance || ''])
      const mounts = JSON.parse(inspected.stdout)[0]?.Mounts || []
      const realBase = await fs.realpath(base)
      if (!mounts.some(mount => ['bind', 'volume'].includes(mount.Type)
        && (realBase === mount.Destination || realBase.startsWith(`${mount.Destination.replace(/\/$/, '')}/`)))) {
        throw assetError('EVALUATOR_ASSETS_DIRECTORY_NOT_SHARED', '评测资产目录必须位于 Controller 与 Runtime 共享的数据卷内，请调整目录或挂载')
      }
    }
    try {
      const stat = await fs.lstat(this.root)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw assetError('EVALUATOR_ASSETS_INVALID', '评测资产版本目录无效')
      await this.verify(this.root)
      this.stage = 'ready'
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    this.stage = 'downloading'
    for (let attempt = 0; ; attempt++) {
      try { await this.command('docker', ['pull', spec.image]); break }
      catch (error) {
        if (attempt >= 2 || this.controller.signal.aborted) {
          throw assetError('EVALUATOR_ASSETS_DOWNLOAD_FAILED', `评测资产下载失败（已尝试 ${attempt + 1} 次）：${error.message}`)
        }
        await delay(this.retryDelayMs * (attempt + 1), undefined, { signal: this.controller.signal })
      }
    }
    const staging = await fs.mkdtemp(path.join(base, '.install-'))
    const container = `agent-insight-assets-${randomUUID()}`
    let created = false
    try {
      await this.command('docker', ['create', '--name', container,
        '--label', 'agent-insight.role=asset-installer', spec.image, '/bin/true'])
      created = true
      await this.command('docker', ['cp', `${container}:${spec.sourcePath}/.`, staging])
      await this.verify(staging)
      try { await fs.rename(staging, this.root) }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
        await this.verify(this.root)
      }
      this.stage = 'ready'
    } finally {
      if (created) {
        await this.runner({ command: 'direct', entrypoint: 'docker' }, ['rm', '-f', container], {
          signal: AbortSignal.timeout(30_000),
        }).catch(error => console.error(`[evaluator/assets] installer cleanup: ${error.message}`))
      }
      await fs.rm(staging, { recursive: true, force: true })
    }
  }

  async close() {
    this.controller.abort()
    await this.task
  }
}

module.exports = { EvaluatorAssets, EvaluatorAssetError }

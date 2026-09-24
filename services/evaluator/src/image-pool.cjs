'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const { createHash } = require('node:crypto')
const { atomicWriteJson } = require('./job-journal.cjs')
const { DockerImageStore, poolError } = require('./image-pool-docker.cjs')
const { ImageSizeEstimator, FALLBACK_BYTES } = require('./image-size-estimator.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const imagePattern = /^(?:[a-z0-9][a-z0-9._:/-]*)(?:@sha256:[a-f0-9]{64})?$/i
const normalizeArch = (arch) => ({ amd64: 'x86_64', x86_64: 'x86_64', aarch64: 'arm64', arm64: 'arm64' })[arch]

function waitForImage(work, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(poolError('IMAGE_POOL_CANCELLED', '镜像请求已取消')))
    const timer = setTimeout(() => finish(() => reject(poolError('IMAGE_POOL_WAIT_TIMEOUT', '镜像准备等待超时'))), timeoutMs)
    const finish = (callback) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); callback() }
    work.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)))
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function imagePoolConfig(env = process.env) {
  const setting = env.IMAGE_POOL_ENABLED || 'true'
  if (!['true', 'false'].includes(setting)) throw poolError('IMAGE_POOL_CONFIG_INVALID', 'IMAGE_POOL_ENABLED 必须为 true 或 false', false)
  const enabled = setting === 'true'
  const config = {
    enabled,
    prefetch: enabled && env.IMAGE_POOL_PREFETCH_ENABLED === 'true',
    reserveRatio: Number(env.IMAGE_POOL_RESERVE_RATIO || 0.3),
    highWatermark: Number(env.IMAGE_POOL_HIGH_WATERMARK || 0.9),
    maxPulls: Number(env.IMAGE_POOL_MAX_PULLS || 2),
    waitMs: Number(env.IMAGE_POOL_WAIT_SECONDS || 600) * 1000,
  }
  if (enabled && (
    !(config.reserveRatio > 0 && config.reserveRatio < 1)
    || !(config.highWatermark > 0 && config.highWatermark < 1)
    || !Number.isInteger(config.maxPulls) || config.maxPulls < 1 || config.maxPulls > 8
    || (config.prefetch && config.maxPulls < 2)
    || !Number.isFinite(config.waitMs) || config.waitMs <= 0 || config.waitMs > 86_400_000
  )) throw poolError('IMAGE_POOL_CONFIG_INVALID', '镜像池比例、并发或等待期限配置不合法', false)
  return config
}

function validateImageSpec(spec, arch) {
  if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string' || !spec.key.length || spec.key.length > 512
    || !Array.isArray(spec.references) || !spec.references.length || spec.references.length > 12
    || spec.references.some((ref) => typeof ref !== 'string' || ref.length > 512 || !imagePattern.test(ref))
    || normalizeArch(spec.arch) !== normalizeArch(arch) || !normalizeArch(arch)) {
    throw poolError('IMAGE_POOL_SPEC_INVALID', '接入包镜像声明或架构不合法', false)
  }
  if (spec.estimatedBytes != null && (!Number.isSafeInteger(spec.estimatedBytes) || spec.estimatedBytes <= 0)) {
    throw poolError('IMAGE_POOL_SPEC_INVALID', '镜像大小估值不合法', false)
  }
  return spec
}

class BenchmarkImagePool {
  constructor(options = {}) {
    this.config = options.config || imagePoolConfig()
    this.store = options.store || new DockerImageStore()
    this.estimator = options.estimator || new ImageSizeEstimator()
    this.directory = path.join(options.dataDir || '/data', 'image-pool')
    this.state = { version: 1, daemonId: null, images: {}, operations: {}, windows: {} }
    this.tail = Promise.resolve()
    this.inflight = new Map()
    this.demandKeys = new Map()
    this.activePulls = 0
    this.prefetchPulls = 0
    this.demandWaiting = 0
    this.gcRunning = null
    this.initializing = null
    this.now = options.now || Date.now
    this.log = options.log || ((event) => console.info('[benchmark/image-pool]', JSON.stringify(event)))
    this.lock = options.lock !== false
    this.closed = false
  }

  atomic(fn) {
    const result = this.tail.then(fn)
    this.tail = result.catch(() => {})
    return result
  }

  save() { return atomicWriteJson(path.join(this.directory, 'state.json'), this.state) }

  async initialize() {
    if (!this.config.enabled) return
    if (this.initializing) return this.initializing
    this.initializing = this.initializeOnce().catch(async (error) => { await this.close(); throw error })
    return this.initializing
  }

  async initializeOnce() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (this.lock) {
      const socket = path.join(this.directory, 'manager.sock')
      const live = await new Promise((resolve) => {
        const probe = net.connect(socket)
        probe.once('connect', () => { probe.destroy(); resolve(true) })
        probe.once('error', (error) => resolve(!['ENOENT', 'ECONNREFUSED'].includes(error.code)))
      })
      if (live) throw poolError('IMAGE_POOL_ALREADY_RUNNING', '同一数据目录已有镜像池管理入口', false)
      await fs.unlink(socket).catch((error) => { if (error.code !== 'ENOENT') throw error })
      this.lockServer = net.createServer((connection) => connection.destroy())
      await new Promise((resolve, reject) => { this.lockServer.once('error', reject); this.lockServer.listen(socket, resolve) })
      this.lockServer.unref()
    }
    const info = await this.store.initialize()
    this.arch = info.arch
    try { this.state = JSON.parse(await fs.readFile(path.join(this.directory, 'state.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (this.state.version !== 1 || (this.state.daemonId && this.state.daemonId !== info.daemonId)) {
      throw poolError('IMAGE_POOL_STATE_INVALID', '镜像池状态版本或 Docker daemon 不匹配', false)
    }
    this.state.daemonId = info.daemonId
    for (const entry of Object.values(this.state.images)) {
      if (!await this.store.inspect(entry.id)) delete this.state.images[entry.id]
      else if (entry.deleting) {
        entry.uncertain = true
        this.log({ event: 'recovery_required', imageId: entry.id, message: '未确认完成的删除保持隔离' })
      }
    }
    // A disconnected daemon operation may outlive the Controller; do not guess it stopped.
    for (const [key, operation] of Object.entries(this.state.operations)) {
      if (operation.completed) delete this.state.operations[key]
      else operation.uncertain = true
    }
    if (Object.values(this.state.operations).some((op) => op.uncertain)) {
      this.log({ event: 'recovery_required', message: '未确认结束的 Docker 拉取仍占用预算；暂停新拉取，已有镜像仍可使用' })
    }
    await this.save()
    this.timer = setInterval(() => { void this.maintain().catch((error) => this.log({ event: 'maintenance_failed', code: error.code, message: error.message })) }, 30_000)
    this.timer.unref()
  }

  async close() {
    this.closed = true
    clearInterval(this.timer)
    if (this.lockServer) await new Promise((resolve) => this.lockServer.close(resolve))
  }

  key(spec) { return createHash('sha256').update(JSON.stringify([normalizeArch(spec.arch), spec.references])).digest('hex') }

  async budget(extraBytes = 0) {
    const free = await this.store.freeSpace()
    const occupied = Object.values(this.state.images).reduce((sum, entry) => sum + ((entry.ownedReferences.length || entry.ownedDigests.length) ? entry.bytes : 0), 0)
    const reserved = Object.values(this.state.operations).reduce((sum, op) => sum + op.bytes, 0)
    const reserve = (free + occupied) * this.config.reserveRatio
    const capacity = Math.max(0, free + occupied - reserve)
    return { free, occupied, reserved, reserve, capacity, high: occupied + reserved >= capacity * this.config.highWatermark,
      enough: free >= reserve + reserved + extraBytes }
  }

  protectedKeys() {
    const keys = new Set()
    for (const window of Object.values(this.state.windows)) {
      if (window.expiresAt > this.now()) for (const spec of window.specs) keys.add(this.key(spec))
    }
    return keys
  }

  async evictOne(allowPrepared) {
    if (this.gcRunning) { await this.gcRunning; return true }
    this.gcRunning = this.evictCandidate(allowPrepared)
    try { return await this.gcRunning } finally { this.gcRunning = null }
  }

  async evictCandidate(allowPrepared) {
    const entry = await this.atomic(async () => {
      const protectedKeys = this.protectedKeys()
      const candidates = Object.values(this.state.images).filter((item) => (item.ownedReferences.length || item.ownedDigests.length)
        && !item.deleting && !Object.keys(item.users).length
        && !item.keys.some((key) => this.demandKeys.has(key) || this.inflight.has(key))
        && !(item.retryAfter > this.now())
        && (allowPrepared || !item.keys.some((key) => protectedKeys.has(key))))
      candidates.sort((a, b) => Number(a.keys.some((key) => protectedKeys.has(key))) - Number(b.keys.some((key) => protectedKeys.has(key))) || a.lastUsedAt - b.lastUsedAt)
      const selected = candidates[0]
      if (!selected) return null
      selected.deleting = true
      await this.save()
      return selected
    })
    if (!entry) return false
    const started = this.now()
    try {
      const actual = await this.store.inspect(entry.id)
      if (actual) {
        if (await this.store.referenced(entry.id)) throw poolError('IMAGE_POOL_IMAGE_REFERENCED', '镜像仍被容器引用')
        if (actual.references.some((ref) => ref !== '<none>:<none>' && !entry.ownedReferences.includes(ref))
          || actual.digests.some((ref) => !entry.ownedDigests.includes(ref))) {
          throw poolError('IMAGE_POOL_EXTERNAL_REFERENCE', '镜像存在池外引用')
        }
        for (const ref of [...entry.ownedReferences, ...entry.ownedDigests]) {
          const target = await this.store.inspect(ref)
          if (target?.id === entry.id) await this.store.remove(ref)
        }
        const remaining = await this.store.inspect(entry.id)
        if (remaining && remaining.references.every((ref) => ref === '<none>:<none>') && !remaining.digests.length) await this.store.remove(entry.id)
        if (await this.store.inspect(entry.id)) throw poolError('IMAGE_POOL_NOT_REMOVED', '镜像尚未释放')
      }
      await this.atomic(async () => { delete this.state.images[entry.id]; await this.save() })
      this.log({ event: 'evicted', imageId: entry.id, elapsedMs: this.now() - started })
    } catch (error) {
      await this.atomic(async () => {
        entry.deleting = error.code === 'IMAGE_POOL_DOCKER_UNCERTAIN'
        entry.uncertain = entry.deleting
        entry.retryAfter = this.now() + 30_000
        await this.save()
      })
      this.log({ event: 'eviction_skipped', imageId: entry.id, code: error.code })
    }
    return true
  }

  async reserve(key, bytes, prefetch, alive, deadline) {
    while (this.now() < deadline && alive() && !this.closed) {
      if (prefetch && this.demandWaiting && !this.demandKeys.has(key)) { await sleep(100); continue }
      const granted = await this.atomic(async () => {
        if (Object.values(this.state.operations).some((op) => op.uncertain)) {
          throw poolError('IMAGE_POOL_RECOVERY_REQUIRED', 'Docker 拉取状态不确定，暂停新拉取，需运维对账')
        }
        if (this.activePulls >= this.config.maxPulls || (prefetch && !this.demandKeys.has(key) && this.prefetchPulls >= 1)) return false
        const budget = await this.budget(bytes)
        if (!budget.enough) return false
        this.state.operations[key] = { bytes, startedAt: this.now(), uncertain: false }
        await this.save()
        this.activePulls++
        if (prefetch) this.prefetchPulls++
        return true
      })
      if (granted) return
      const budget = await this.budget(bytes)
      if (!budget.enough) {
        if (await this.evictOne(!prefetch)) continue
        throw poolError('IMAGE_POOL_SPACE_LOW', '镜像准备空间不足，已无可安全回收的镜像', false)
      }
      await sleep(100)
    }
    throw poolError('IMAGE_POOL_SPACE_TIMEOUT', '镜像空间/拉取槽位等待超时或请求已取消')
  }

  async prepare(spec, options = {}) {
    await this.initialize()
    validateImageSpec(spec, this.arch)
    const key = this.key(spec)
    let work = this.inflight.get(key)
    if (!work) {
      work = this.prepareOnce(spec, key, options)
      this.inflight.set(key, work)
      work.finally(() => { if (this.inflight.get(key) === work) this.inflight.delete(key) }).catch(() => {})
    }
    const result = await work
    return { ...spec.context, ...result, key: spec.key }
  }

  async prepareOnce(spec, key, options) {
    const prefetch = options.prefetch === true
    const deadline = this.now() + this.config.waitMs
    const alive = () => this.protectedKeys().has(key) || this.demandKeys.has(key)
    let actual
    let source
    for (const ref of spec.references) {
      actual = await this.store.inspect(ref)
      if (actual) { source = ref; break }
    }
    let reserved = false
    let pulled = false
    const started = this.now()
    try {
      if (!actual) {
        if (spec.references.every((ref) => /^sha256:[a-f0-9]{64}$/i.test(ref))) {
          throw poolError('IMAGE_POOL_FROZEN_UNAVAILABLE', '冻结的本地镜像已不存在，无法重拉')
        }
        const estimate = await this.estimator.estimate(spec)
        this.log({ event: 'size_estimated', key: spec.key, ...estimate })
        await this.reserve(key, estimate.bytes, prefetch, alive, deadline)
        reserved = true
        let lastError
        for (const ref of spec.references) {
          if (!alive() || this.closed) throw poolError('IMAGE_POOL_CANCELLED', '镜像准备窗口或使用请求已取消')
          while (!(await this.budget()).enough && await this.evictOne(!prefetch)) {}
          if (!(await this.budget()).enough) throw poolError('IMAGE_POOL_SPACE_LOW', '镜像源回退前安全余量不足', false)
          try {
            await this.atomic(async () => { this.state.operations[key].reference = ref; await this.save() })
            await this.store.pull(ref)
            actual = await this.store.inspect(ref)
            if (!actual) throw poolError('IMAGE_POOL_PULL_FAILED', '拉取完成后镜像不存在')
            source = ref
            pulled = true
            break
          } catch (error) {
            lastError = error
            if (error.code === 'IMAGE_POOL_SPACE_LOW') throw error
            if (error.code !== 'IMAGE_POOL_PULL_FAILED') {
              await this.atomic(async () => { this.state.operations[key].uncertain = true; await this.save() })
              throw error
            }
          }
        }
        if (!actual) throw lastError
      }
      if (normalizeArch(actual.arch) !== normalizeArch(spec.arch)) throw poolError('IMAGE_POOL_ARCH_MISMATCH', '镜像架构与接入包声明不一致', false)
      const resolved = await this.atomic(async () => {
        const entry = this.state.images[actual.id]
        if (entry?.deleting) throw poolError('IMAGE_POOL_RETRY', '镜像正在回收，请重试')
        const fresh = await this.store.inspect(actual.id)
        if (!fresh) throw poolError('IMAGE_POOL_RETRY', '镜像已被回收，请重试')
        const record = entry || { id: actual.id, bytes: actual.size || spec.estimatedBytes || FALLBACK_BYTES,
          estimateQuality: 'logical-upper-bound', ownedReferences: [], ownedDigests: [], keys: [], users: {}, lastUsedAt: 0 }
        if (!record.keys.includes(key)) record.keys.push(key)
        if (pulled) {
          if (source.includes('@')) record.ownedDigests = [...new Set([...record.ownedDigests, source])]
          else record.ownedReferences = [...new Set([...record.ownedReferences, source])]
          const repository = source.split('@')[0].replace(/:[^/:]+$/, '')
          record.ownedDigests = [...new Set([...record.ownedDigests, ...actual.digests.filter((ref) => ref.startsWith(`${repository}@`))])]
        }
        this.state.images[actual.id] = record
        if (reserved) this.state.operations[key].completed = true
        await this.save()
        const repo = source.split('@')[0].replace(/:[^/:]+$/, '')
        const pinnedImage = actual.digests.find((digest) => digest.startsWith(`${repo}@`)) || actual.id
        return { key: spec.key, imageId: actual.id, pinnedImage, resolvedImageReference: source, references: spec.references, arch: spec.arch }
      })
      this.log({ event: pulled ? 'pulled' : 'hit', imageId: actual.id, prefetch, elapsedMs: this.now() - started })
      return resolved
    } finally {
      if (reserved) await this.atomic(async () => {
        if (!this.state.operations[key]?.uncertain) delete this.state.operations[key]
        this.activePulls--
        if (prefetch) this.prefetchPulls--
        await this.save()
      })
    }
  }

  async acquire(owner, specs, options = {}) {
    await this.initialize()
    if (!owner?.benchmarkKey || !owner?.runId || !owner?.experimentId || !Array.isArray(specs) || specs.length > 16) {
      throw poolError('IMAGE_POOL_OWNER_INVALID', '镜像使用者不合法', false)
    }
    const ownerKey = JSON.stringify([owner.benchmarkKey, owner.experimentId, owner.runId])
    const started = this.now()
    const remainingWait = () => Math.max(1, this.config.waitMs - (this.now() - started))
    const results = []
    for (const spec of specs) validateImageSpec(spec, this.arch)
    for (const spec of specs) this.demandKeys.set(this.key(spec), (this.demandKeys.get(this.key(spec)) || 0) + 1)
    this.demandWaiting++
    try {
      for (const spec of specs) {
        if (options.signal?.aborted) throw poolError('IMAGE_POOL_CANCELLED', '镜像请求已取消')
        let result
        try { result = await waitForImage(this.prepare(spec), options.signal, remainingWait()) }
        catch (error) {
          if (error.code !== 'IMAGE_POOL_RETRY') throw error
          if (this.gcRunning) await waitForImage(this.gcRunning, options.signal, remainingWait())
          result = await waitForImage(this.prepare(spec), options.signal, remainingWait())
        }
        await this.atomic(async () => {
          if (options.signal?.aborted) throw poolError('IMAGE_POOL_CANCELLED', '镜像请求已取消')
          const entry = this.state.images[result.imageId]
          entry.users[ownerKey] = owner
          entry.lastUsedAt = this.now()
          await this.save()
        })
        results.push(result)
      }
      while (!(await this.budget()).enough) {
        if (options.signal?.aborted) throw poolError('IMAGE_POOL_CANCELLED', '镜像请求已取消')
        if (!await waitForImage(this.evictOne(true), options.signal, remainingWait())) break
      }
      if (!(await this.budget()).enough) throw poolError('IMAGE_POOL_SPACE_LOW', '镜像就绪后安全余量不足', false)
      this.log({ event: 'acquired', ...owner, waitMs: this.now() - started })
      return results
    } catch (error) {
      await this.release(owner)
      throw error
    } finally {
      this.demandWaiting--
      for (const spec of specs) {
        const key = this.key(spec)
        const count = this.demandKeys.get(key) - 1
        if (count) this.demandKeys.set(key, count)
        else this.demandKeys.delete(key)
      }
    }
  }

  async release(owner) {
    await this.initialize()
    const ownerKey = JSON.stringify([owner.benchmarkKey, owner.experimentId, owner.runId])
    await this.atomic(async () => {
      for (const entry of Object.values(this.state.images)) {
        if (entry.users[ownerKey]) { delete entry.users[ownerKey]; entry.lastUsedAt = this.now() }
      }
      await this.save()
    })
  }

  async updateWindow(scope, revision, specs) {
    await this.initialize()
    if (!this.config.prefetch) return { enabled: false }
    if (!scope.benchmarkKey || !scope.experimentId || !Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(specs) || specs.length > 16) {
      throw poolError('IMAGE_POOL_WINDOW_INVALID', '准备窗口不合法', false)
    }
    for (const spec of specs) validateImageSpec(spec, this.arch)
    const key = JSON.stringify([scope.benchmarkKey, scope.experimentId])
    const accepted = await this.atomic(async () => {
      if ((this.state.windows[key]?.revision ?? -1) >= revision) return false
      this.state.windows[key] = { revision, specs, expiresAt: this.now() + 30 * 60_000 }
      await this.save()
      return true
    })
    if (accepted) void this.prefetch(specs).catch((error) => this.log({ event: 'prefetch_failed', code: error.code, message: error.message }))
    return { enabled: true, accepted }
  }

  async prefetch(specs) {
    for (const spec of specs) {
      if (!this.protectedKeys().has(this.key(spec)) || this.closed) return
      await this.prepare(spec, { prefetch: true })
    }
  }

  async maintain() {
    if (this.closed || this.maintaining) return
    this.maintaining = true
    try {
      if (!this.refreshAt || this.now() - this.refreshAt >= 60_000) {
        const stats = await this.store.refresh()
        await this.atomic(async () => {
          for (const entry of Object.values(this.state.images)) {
            const item = stats.get(entry.id)
            if (item && Number.isSafeInteger(item.Size) && item.Size >= 0 && this.store.containerd) {
              entry.bytes = item.Size
              entry.estimateQuality = 'containerd-logical-estimate'
            } else if (item && item.Size >= 0 && item.SharedSize >= 0) {
              entry.bytes = Math.max(0, item.Size - item.SharedSize)
              entry.estimateQuality = 'exclusive-layers-lower-bound'
            }
          }
          for (const window of Object.values(this.state.windows)) if (window.expiresAt <= this.now()) window.specs = []
          await this.save()
        })
        this.refreshAt = this.now()
      }
      const budget = await this.budget()
      if (budget.high) {
        this.log({ event: 'high_watermark', ...budget })
        if (!Object.values(this.state.operations).some((op) => op.uncertain)) {
          const specs = Object.values(this.state.windows).filter((window) => window.expiresAt > this.now()).flatMap((window) => window.specs)
            .filter((spec) => !Object.values(this.state.images).some((entry) => entry.keys.includes(this.key(spec))))
          if (specs.length) void this.prefetch(specs).catch((error) => this.log({ event: 'prefetch_failed', code: error.code }))
        }
      }
      if (!budget.enough) {
        while (!(await this.budget()).enough && !this.closed && await this.evictOne(true)) {}
      }
    } finally { this.maintaining = false }
  }
}

module.exports = { BenchmarkImagePool, imagePoolConfig, validateImageSpec, normalizeArch }

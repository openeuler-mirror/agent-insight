'use strict'

const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const executeFile = promisify(execFile)
const FALLBACK_BYTES = 8 * 1024 ** 3
const ESTIMATE_TIMEOUT_MS = 2000
const architecture = (value) => ({ amd64: 'amd64', x86_64: 'amd64', arm64: 'arm64', aarch64: 'arm64' })[value]

function manifestBytes(value, arch) {
  const candidates = (Array.isArray(value) ? value : [value]).filter((item) => {
    const platform = item?.Descriptor?.platform || item?.Platform
    return platform?.os === 'linux' && architecture(platform.architecture) === architecture(arch)
  })
  const sizes = candidates.map((item) => {
    const manifest = item.SchemaV2Manifest || item.OCIManifest
    if (!Array.isArray(manifest?.layers) || !manifest.layers.length) return null
    const layers = new Map()
    for (const layer of manifest.layers) {
      if (!Number.isSafeInteger(layer.size) || layer.size < 0 || typeof layer.digest !== 'string') return null
      layers.set(layer.digest, Math.max(layers.get(layer.digest) || 0, layer.size))
    }
    const bytes = [...layers.values()].reduce((sum, size) => sum + size, 0)
    return Number.isSafeInteger(bytes * 4) && bytes > 0 ? Math.max(256 * 1024 ** 2, bytes * 4) : null
  }).filter((size) => size !== null)
  return sizes.length ? Math.max(...sizes) : null
}

class ImageSizeEstimator {
  constructor(options = {}) {
    this.execute = options.execute || executeFile
    this.now = options.now || Date.now
    this.cache = new Map()
    this.inflight = new Map()
  }

  async estimate(spec) {
    if (Number.isSafeInteger(spec.estimatedBytes) && spec.estimatedBytes > 0) {
      return { bytes: spec.estimatedBytes, source: 'provider' }
    }
    const key = JSON.stringify([architecture(spec.arch), spec.references])
    const cached = this.cache.get(key)
    if (cached?.expiresAt > this.now()) return { ...cached.value, cached: true }
    if (this.inflight.has(key)) return this.inflight.get(key)
    const work = this.lookup(spec).then((value) => {
      if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value)
      this.cache.set(key, { value, expiresAt: this.now() + (value.source === 'fallback' ? 60_000 : 15 * 60_000) })
      return value
    }).finally(() => this.inflight.delete(key))
    this.inflight.set(key, work)
    return work
  }

  async lookup(spec) {
    const deadline = this.now() + ESTIMATE_TIMEOUT_MS
    for (const reference of spec.references) {
      const remaining = deadline - this.now()
      if (remaining <= 0) break
      try {
        const { stdout } = await this.execute('docker', ['manifest', 'inspect', '--verbose', reference], {
          timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 ** 2,
        })
        const bytes = manifestBytes(JSON.parse(stdout), spec.arch)
        if (bytes) return { bytes, source: 'manifest' }
      } catch {}
    }
    return { bytes: FALLBACK_BYTES, source: 'fallback' }
  }
}

module.exports = { ImageSizeEstimator, manifestBytes, FALLBACK_BYTES, ESTIMATE_TIMEOUT_MS }

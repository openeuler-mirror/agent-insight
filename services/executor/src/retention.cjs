'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { installationRoot, readState, repository } = require('./xgovernor/installation.cjs')
const { transport, hasActiveUpload } = require('./xgovernor/trace.cjs')

const RUN_ID = /^[A-Za-z0-9_-]{1,160}$/
const RELEASE_ID = /^[a-f0-9]{40}-[a-f0-9]{16}$/
const DAY = 86400000
const SWEEP_INTERVAL = 3600000

async function stat(file) {
  try { return await fsp.lstat(file) } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause }
}
async function directories(root) {
  const info = await stat(root)
  if (!info) return []
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`清理目录不是独立目录：${root}`)
  return fsp.readdir(root, { withFileTypes: true })
}
async function json(file) {
  const info = await stat(file)
  if (!info) return null
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`清理记录不是普通文件：${file}`)
  return JSON.parse(await fsp.readFile(file, 'utf8'))
}
function artifactsDelivered(state) {
  return (state.localArtifacts || []).every(local => (state.uploadedArtifacts || []).some(uploaded =>
    uploaded.name === local.name && uploaded.sha256 === local.sha256 && uploaded.artifactId))
}

class LocalRetention {
  constructor(options) {
    Object.assign(this, options)
    this.runRoot = path.join(this.baseDir, 'benchmark-runs')
    this.sandboxRoot = path.join(this.baseDir, 'xgovernor-runs')
    this.trashRoot = path.join(this.baseDir, 'retention-trash')
    this.installRoot = options.installRoot || installationRoot()
    this.lastSweep = -Infinity
  }
  sweep(force = false) {
    if (this.pending) return this.pending
    if (!force && Date.now() - this.lastSweep < SWEEP_INTERVAL) return Promise.resolve()
    this.lastSweep = Date.now()
    this.pending = this.collect().catch(cause => this.logError?.('本地历史清理失败，保留未确认的数据', cause)).finally(() => { this.pending = null })
    return this.pending
  }
  async withUploadedTrace(directory, action) {
    if (hasActiveUpload(directory)) return false
    const spool = path.join(directory, 'trace-spool')
    const info = await stat(spool)
    if (!info) { await action(); return true }
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    const { acquireProcessLock, releaseProcessLock } = transport()
    const lock = await acquireProcessLock(path.join(spool, 'uploader.lock'))
    if (!lock) return false
    try {
      const checkpoint = await json(path.join(spool, 'uploader-checkpoint.json'))
      if (checkpoint && checkpoint.version !== 1) return false
      for (const entry of await fsp.readdir(spool, { withFileTypes: true })) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
        if (!entry.isDirectory() || entry.isSymbolicLink()) return false
        const file = path.join(spool, entry.name, 'events.jsonl')
        const fileStat = await stat(file)
        if (!fileStat) continue
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) return false
        const bytes = checkpoint?.files?.[`${entry.name}/events.jsonl`]?.bytes || 0
        if (!Number.isSafeInteger(bytes) || bytes !== fileStat.size) return false
      }
      await action()
      return true
    } finally { await releaseProcessLock(lock) }
  }
  async collect() {
    const days = this.getDays()
    if (!Number.isSafeInteger(days) || days < 1) throw new Error('retention.days 必须是正整数')
    const cutoff = (this.now?.() ?? Date.now()) - days * DAY
    const { acquireProcessLock, releaseProcessLock } = transport()
    await fsp.mkdir(this.baseDir, { recursive: true, mode: 0o700 })
    const lock = await acquireProcessLock(path.join(this.baseDir, 'retention.lock'))
    if (!lock) return
    try {
      await this.deleteRetiredRuns()
      await directories(this.sandboxRoot)
      for (const entry of await directories(this.runRoot)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_ID.test(entry.name) || this.isActive(entry.name)) continue
        try {
          const directory = path.join(this.runRoot, entry.name)
          const state = await json(path.join(directory, 'state.json'))
          if (state?.stage !== 'terminal' || !artifactsDelivered(state)) continue
          if (!state.completionDeliveredAt && state.terminalStatus !== 'cancelled') continue
          const finished = Date.parse(state.terminalAt || '')
          if (!Number.isFinite(finished) || finished > cutoff) continue
          const sandbox = path.join(this.sandboxRoot, entry.name)
          const sandboxInfo = await stat(sandbox)
          if (sandboxInfo && (!sandboxInfo.isDirectory() || sandboxInfo.isSymbolicLink())) continue
          const cleanup = state.cleanup || state.completion?.cleanup
          if (cleanup?.status !== 'succeeded' && (state.executionHandle || sandboxInfo)) continue
          if (sandboxInfo) {
            const lease = await json(path.join(sandbox, 'lease.json'))
            if (!lease?.closed || lease.directory !== sandbox) continue
          }
          await this.withUploadedTrace(sandbox, async () => {
            const moved = await this.retire(entry.name, [
              ...(sandboxInfo ? [{ source: sandbox, name: 'sandbox' }] : []), { source: directory, name: 'record' },
            ], () => !this.isActive(entry.name))
            if (moved) this.log?.(`已清理过期本地 Case：${entry.name}`)
          })
        } catch (cause) { this.logError?.(`保留无法确认的 Case：${entry.name}`, cause) }
      }
      await this.collectReleases(cutoff)
    } finally { await releaseProcessLock(lock) }
  }
  async retire(entryId, items, canRetire) {
    await fsp.mkdir(this.trashRoot, { recursive: true, mode: 0o700 })
    await directories(this.trashRoot)
    const token = randomBytes(16).toString('hex')
    const retired = path.join(this.trashRoot, token)
    await fsp.mkdir(retired, { mode: 0o700 })
    const approval = path.join(this.trashRoot, `${token}.json`)
    // 确认记录留在删除目录外，部分删除或掉电后仍能继续回收。
    const marker = await fsp.open(approval, 'wx', 0o600)
    try { await marker.writeFile(JSON.stringify({ schemaVersion: 1, entryId })); await marker.sync() } finally { await marker.close() }
    if (!canRetire()) return false
    for (const item of items) fs.renameSync(item.source, path.join(retired, item.name))
    await fsp.rm(retired, { recursive: true, force: true })
    await fsp.unlink(approval)
    return true
  }
  async deleteRetiredRuns() {
    for (const entry of await directories(this.trashRoot)) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{32}\.json$/.test(entry.name)) continue
      try {
        const approval = path.join(this.trashRoot, entry.name)
        const marker = await json(approval)
        if (marker?.schemaVersion !== 1 || !RUN_ID.test(marker.entryId)) continue
        const directory = path.join(this.trashRoot, entry.name.slice(0, -5))
        const info = await stat(directory)
        if (info && (!info.isDirectory() || info.isSymbolicLink())) continue
        await fsp.rm(directory, { recursive: true, force: true })
        await fsp.unlink(approval)
      } catch (cause) { this.logError?.(`已确认历史的删除尚未完成：${entry.name}`, cause) }
    }
  }
  async collectReleases(cutoff) {
    if (this.hasActiveRuns() || !await stat(this.installRoot) || await stat(path.join(this.installRoot, 'setup.lock'))) return
    const rootInfo = await stat(this.installRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return
    const lockPath = path.join(this.installRoot, 'update.lock')
    let lock
    try { lock = await fsp.open(lockPath, 'wx', 0o600) } catch (cause) { if (cause.code === 'EEXIST') return; throw cause }
    try {
      await lock.writeFile(String(process.pid))
      const state = readState(this.installRoot)
      if (!state) return
      const protectedIds = new Set([state.current, state.previous])
      const releases = path.join(this.installRoot, 'releases')
      const protect = value => {
        if (typeof value === 'string' && path.isAbsolute(value)) {
          const relative = path.relative(releases, value).split(path.sep)[0]
          if (RELEASE_ID.test(relative)) protectedIds.add(relative)
          else {
            try {
              const resolved = path.relative(releases, fs.realpathSync(value)).split(path.sep)[0]
              if (RELEASE_ID.test(resolved)) protectedIds.add(resolved)
            } catch {}
          }
        } else if (value && typeof value === 'object') Object.values(value).forEach(protect)
      }
      for (const entry of await directories(this.sandboxRoot)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_ID.test(entry.name)) return
        const lease = await json(path.join(this.sandboxRoot, entry.name, 'lease.json'))
        if (!lease || lease.closed !== true) { if (!lease) return; protect(lease) }
      }
      for (const entry of await directories(this.runRoot)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_ID.test(entry.name)) return
        const run = await json(path.join(this.runRoot, entry.name, 'state.json'))
        if (!run) return
        if (run.stage !== 'terminal' || (run.cleanup || run.completion?.cleanup)?.status !== 'succeeded') protect(run.executionHandle)
      }
      for (const entry of await directories(releases)) {
        const id = entry.name
        if (!entry.isDirectory() || entry.isSymbolicLink() || !RELEASE_ID.test(id) || protectedIds.has(id)) continue
        const directory = path.join(releases, entry.name)
        const manifest = await json(path.join(directory, 'installation.json'))
        if (manifest?.repository !== repository || manifest.schemaVersion !== 1 || !id.startsWith(`${manifest.revision}-`)) continue
        const installed = Date.parse(manifest.installedAt)
        if (!Number.isFinite(installed) || installed > cutoff) continue
        const moved = await this.retire(id, [{ source: directory, name: 'release' }], () => !this.hasActiveRuns())
        if (moved) this.log?.(`已清理未使用的 xGovernor 版本：${id}`)
      }
    } finally { await lock.close(); await fsp.rm(lockPath, { force: true }) }
  }
}

module.exports = { LocalRetention, SWEEP_INTERVAL }

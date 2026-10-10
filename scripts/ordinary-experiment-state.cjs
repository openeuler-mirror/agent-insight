const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 })
  return result.status === 0 ? result.stdout.trim() || null : null
}

function processGroupAlive(pid) {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function createOrdinaryExperimentStore(root, options = {}) {
  const identity = options.processIdentity || processIdentity
  const alive = options.processGroupAlive || processGroupAlive
  const signal = options.signalGroup || signalGroup
  const wait = options.sleep || sleep
  const runDir = path.join(root, 'experiment-runs')
  const cancellationDir = path.join(root, 'cancelled-experiments')
  const fileFor = (dir, runId) => {
    if (!/^cmd_[A-Za-z0-9_-]+$/.test(String(runId || ''))) throw new Error('Invalid experiment commandId')
    return path.join(dir, `${runId}.json`)
  }
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
    fs.renameSync(temp, file)
  }
  const state = (runId) => read(fileFor(runDir, runId))
  const patch = (runId, values) => write(fileFor(runDir, runId), { ...state(runId), ...values })
  const markConfirmed = (runId) => {
    const file = fileFor(cancellationDir, runId)
    const request = read(file)
    if (request) write(file, { ...request, confirmed: true })
  }
  const finish = (runId, confirmed = true) => {
    const current = state(runId)
    if (confirmed && current?.childPid && alive(current.childPid)) confirmed = false
    patch(runId, { stage: confirmed ? 'terminal' : 'uncertain', cleanupConfirmed: confirmed, finishedAt: new Date().toISOString() })
    if (confirmed) markConfirmed(runId)
  }
  const waitUntilGone = async (pid, duration) => {
    const end = Date.now() + duration
    while (alive(pid) && Date.now() < end) await wait(50)
    return !alive(pid)
  }
  const reconcile = async (runId) => {
    const current = state(runId)
    if (!current) return { confirmed: false, reason: 'RUN_STATE_UNAVAILABLE' }
    if (current.stage === 'terminal' && current.cleanupConfirmed) return { confirmed: true }
    if (current.stage === 'accepted' && !current.childPid) {
      finish(runId)
      return { confirmed: true }
    }
    const pid = Number(current.childPid)
    if (!Number.isInteger(pid) || pid <= 0) return { confirmed: false, reason: 'RUN_PROCESS_UNCONFIRMED' }
    if (!alive(pid)) {
      finish(runId)
      return { confirmed: true }
    }
    if (!current.childIdentity || identity(pid) !== current.childIdentity) {
      return { confirmed: false, reason: 'RUN_PROCESS_UNCONFIRMED' }
    }
    signal(pid, 'SIGTERM')
    if (!await waitUntilGone(pid, 2000)) {
      signal(pid, 'SIGKILL')
      if (!await waitUntilGone(pid, 2000)) return { confirmed: false, reason: 'RUN_PROCESS_UNCONFIRMED' }
    }
    finish(runId)
    return { confirmed: true }
  }
  return {
    state,
    accept(runId) {
      patch(runId, { stage: 'accepted', ownerPid: process.pid, ownerIdentity: identity(process.pid), startedAt: new Date().toISOString(), cleanupConfirmed: false })
    },
    launching(runId) {
      patch(runId, { stage: 'launching' })
    },
    started(runId, child) {
      patch(runId, { stage: 'running', childPid: child.pid, childIdentity: identity(child.pid) })
    },
    finish,
    requestCancellation(runId) {
      const file = fileFor(cancellationDir, runId)
      const previous = read(file)
      write(file, { requestedAt: previous?.requestedAt || new Date().toISOString(), confirmed: previous?.confirmed || false })
      return previous
    },
    cancellation(runId) { return read(fileFor(cancellationDir, runId)) },
    reconcile,
    async recover() {
      let names
      try { names = fs.readdirSync(runDir) }
      catch (error) { if (error.code === 'ENOENT') return; throw error }
      for (const name of names) {
        if (!/^cmd_[A-Za-z0-9_-]+\.json$/.test(name)) continue
        const runId = name.slice(0, -5)
        const current = state(runId)
        if (current?.stage === 'terminal') continue
        if (current?.ownerPid && current.ownerPid !== process.pid
          && current.ownerIdentity && identity(current.ownerPid) === current.ownerIdentity) continue
        if (current?.ownerPid && current.ownerPid !== process.pid && !current.ownerIdentity) {
          try { process.kill(current.ownerPid, 0); continue }
          catch (error) { if (error.code !== 'ESRCH') continue }
        }
        await reconcile(runId)
      }
    },
  }
}

module.exports = { createOrdinaryExperimentStore }

#!/usr/bin/env node
/**
 * Install FI python package, data dirs, worker config; optionally start worker.
 * Usage:
 *   node scripts/install-fault-injection.js [--check] [--start]
 * Env: AGENT_INSIGHT_HOST, AGENT_INSIGHT_API_KEY
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { randomBytes } = require('crypto')

const home = path.join(os.homedir(), '.agent-insight', 'fault-injection')

function normalizeHost(host) {
  return String(host || '')
    .trim()
    .replace(/\/$/, '')
}

function resolvePackageRoot() {
  const fromCwd = path.join(process.cwd(), 'agent_fault_injection')
  if (
    fs.existsSync(path.join(fromCwd, 'pyproject.toml')) ||
    fs.existsSync(path.join(fromCwd, 'setup.py'))
  ) {
    return fromCwd
  }
  const fromScript = path.join(__dirname, '..', 'agent_fault_injection')
  if (fs.existsSync(fromScript)) return fromScript
  return fromCwd
}

function ensureDirs() {
  for (const dir of [home, path.join(home, 'artifacts'), path.join(home, 'workspaces')]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function writeConfig(packageRoot) {
  const configPath = path.join(home, 'config.json')
  const prev = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
  const insightBaseUrl = normalizeHost(
    process.env.AGENT_INSIGHT_HOST || prev.insightBaseUrl || 'http://127.0.0.1:3000',
  )
  const apiKey = process.env.AGENT_INSIGHT_API_KEY || prev.apiKey || ''
  const workerId =
    prev.workerId || `fi-worker-${os.hostname()}-${randomBytes(3).toString('hex')}`
  const next = {
    ...prev,
    insightBaseUrl,
    apiKey,
    workerId,
    maxParallel: prev.maxParallel || 5,
    pollIntervalMs: prev.pollIntervalMs || 2000,
    artifactsDir: path.join(home, 'artifacts'),
    workspaceBase: path.join(home, 'workspaces'),
    packageRoot,
  }
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2))
  return next
}

function pythonOk() {
  const r = spawnSync(
    'python3',
    ['-c', 'import agent_fault_injection; print(agent_fault_injection.__file__)'],
    { encoding: 'utf8', env: process.env },
  )
  return r.status === 0
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPidFile(pidPath) {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim()
    return Number(raw)
  } catch {
    return NaN
  }
}

function sleepMs(ms) {
  const seconds = Math.max(0.1, ms / 1000)
  spawnSync('sleep', [String(seconds)], { stdio: 'ignore' })
}

/** Read AGENT_INSIGHT_* from /proc/<pid>/environ (Linux/WSL). Returns null if unreadable. */
function readProcessEnvKeys(pid) {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return null
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`)
    const map = {}
    for (const entry of raw.toString('utf8').split('\0')) {
      if (!entry) continue
      const eq = entry.indexOf('=')
      if (eq <= 0) continue
      map[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    if (!('AGENT_INSIGHT_API_KEY' in map) && !('AGENT_INSIGHT_HOST' in map)) {
      return null
    }
    return {
      apiKey: map.AGENT_INSIGHT_API_KEY || '',
      insightBaseUrl: normalizeHost(map.AGENT_INSIGHT_HOST || ''),
    }
  } catch {
    return null
  }
}

function credentialsMatch(desired, running) {
  if (!desired || !running) return false
  return (
    String(desired.apiKey || '') === String(running.apiKey || '') &&
    normalizeHost(desired.insightBaseUrl) === normalizeHost(running.insightBaseUrl)
  )
}

/** true when existing worker must be killed and replaced for the desired credentials. */
function shouldRestartWorker(desired, running) {
  if (!running) return true
  return !credentialsMatch(desired, running)
}

function stopWorker(pid, pidPath) {
  if (!isPidAlive(pid)) {
    try {
      fs.unlinkSync(pidPath)
    } catch {
      /* ignore */
    }
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 20; i++) {
    if (!isPidAlive(pid)) break
    sleepMs(100)
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* ignore */
    }
    sleepMs(200)
  }
  try {
    fs.unlinkSync(pidPath)
  } catch {
    /* ignore */
  }
}

function workerEnv(desired) {
  return {
    ...process.env,
    AGENT_INSIGHT_API_KEY: desired.apiKey || '',
    AGENT_INSIGHT_HOST: normalizeHost(desired.insightBaseUrl),
  }
}

function startWorkerDaemon(workerScript, { foreground = false, desired = {} } = {}) {
  const logPath = path.join(home, 'worker.log')
  const pidPath = path.join(home, 'worker.pid')
  const existingPid = readPidFile(pidPath)
  if (isPidAlive(existingPid)) {
    const running = readProcessEnvKeys(existingPid)
    if (!shouldRestartWorker(desired, running)) {
      console.log(`FI Worker 已在运行 pid=${existingPid}`)
      console.log(`日志: ${logPath}`)
      console.log(`停止: kill $(cat ${pidPath})`)
      return 0
    }
    console.log(
      `配置已变更（apiKey/host），正在重启 Worker… (旧 pid=${existingPid})`,
    )
    stopWorker(existingPid, pidPath)
  }

  const env = workerEnv(desired)

  if (foreground || process.env.AGENT_INSIGHT_FI_WORKER_FOREGROUND === '1') {
    console.log('Starting FI worker in foreground…')
    const child = spawn(process.execPath, [workerScript], {
      stdio: 'inherit',
      env,
    })
    child.on('exit', (code) => process.exit(code || 0))
    return null
  }

  const logFd = fs.openSync(logPath, 'a')
  const child = spawn(process.execPath, [workerScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  })
  fs.closeSync(logFd)
  if (!child.pid) {
    console.error('FI Worker 启动失败：未获得 pid')
    return 1
  }
  fs.writeFileSync(pidPath, String(child.pid))
  child.unref()

  sleepMs(2500)
  if (!isPidAlive(child.pid)) {
    console.error('FI Worker 启动后立即退出，请查看日志：')
    console.error(`  ${logPath}`)
    try {
      const tail = fs.readFileSync(logPath, 'utf8').slice(-800)
      if (tail.trim()) console.error(tail)
    } catch {
      /* ignore */
    }
    return 1
  }

  console.log('FI Worker 已在后台启动')
  console.log(`pid=${child.pid}`)
  console.log(`日志: ${logPath}`)
  console.log(`停止: kill $(cat ${pidPath})`)
  console.log('可关闭本终端；刷新「新建注入任务」页应看到 Worker 在线。')
  return 0
}

function run(_options = {}) {
  const checkOnly = process.argv.includes('--check')
  const startWorker = process.argv.includes('--start')
  const foreground = process.argv.includes('--foreground')
  const packageRoot = resolvePackageRoot()

  ensureDirs()
  const config = writeConfig(packageRoot)

  if (checkOnly) {
    const ok =
      fs.existsSync(packageRoot) &&
      pythonOk() &&
      Boolean(config.apiKey || process.env.AGENT_INSIGHT_API_KEY)
    console.log(
      ok
        ? `fault-injection: ok workerId=${config.workerId} host=${config.insightBaseUrl}`
        : 'fault-injection: missing python package and/or apiKey (set AGENT_INSIGHT_API_KEY)',
    )
    process.exit(ok ? 0 : 1)
  }

  if (!pythonOk()) {
    const r = spawnSync('pip', ['install', '-e', packageRoot], { stdio: 'inherit' })
    if (r.status !== 0) {
      const r2 = spawnSync('pip3', ['install', '-e', packageRoot], { stdio: 'inherit' })
      if (r2.status !== 0) process.exit(r2.status || 1)
    }
  }

  console.log('fault-injection installed; data dir:', home)
  console.log('config:', path.join(home, 'config.json'))
  if (!config.apiKey) {
    console.log('WARN: apiKey empty — set AGENT_INSIGHT_API_KEY before starting worker')
  }

  if (startWorker) {
    const workerScript = path.join(__dirname, 'fi-worker.js')
    const code = startWorkerDaemon(workerScript, {
      foreground,
      desired: {
        apiKey: config.apiKey,
        insightBaseUrl: config.insightBaseUrl,
      },
    })
    if (code === null) return
    process.exit(code)
  }

  console.log('Start worker with: npx agent-insight install-fault-injection --start')
  console.log('  or foreground: … --start --foreground')
}

module.exports = {
  run,
  normalizeHost,
  readProcessEnvKeys,
  credentialsMatch,
  shouldRestartWorker,
  stopWorker,
  workerEnv,
}

if (require.main === module) {
  run()
}

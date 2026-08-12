#!/usr/bin/env node
/**
 * Install FI python package, data dirs, worker config; optionally start worker.
 * Usage:
 *   node scripts/install-fault-injection.js [--check] [--start]
 * Env: AGENT_INSIGHT_HOST, AGENT_INSIGHT_API_KEY
 *
 * Daily use: curl Insight /api/fault-injection/setup | bash (empty cwd → npx).
 * Local clone (cwd has scripts/ + agent_fault_injection/): editable install for FI engine dev.
 * Otherwise: sync package into ~/.agent-insight/fault-injection/python-pkg and pip install
 * (non-editable) so Worker is not tied to a disposable checkout / npx temp dir.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { randomBytes } = require('crypto')

const home = path.join(os.homedir(), '.agent-insight', 'fault-injection')
const stablePkgRoot = path.join(home, 'python-pkg')

function normalizeHost(host) {
  return String(host || '')
    .trim()
    .replace(/\/$/, '')
}

function resolvePython() {
  return process.env.AGENT_FI_PYTHON || process.env.PYTHON || 'python3'
}

/** True when installer runs from an agent-insight checkout (dev convenience). */
function isLocalDevClone() {
  return (
    fs.existsSync(path.join(process.cwd(), 'scripts', 'install-fault-injection.js')) &&
    (fs.existsSync(path.join(process.cwd(), 'agent_fault_injection', 'pyproject.toml')) ||
      fs.existsSync(path.join(process.cwd(), 'agent_fault_injection', 'setup.py')))
  )
}

function resolvePackageSource() {
  const fromCwd = path.join(process.cwd(), 'agent_fault_injection')
  if (
    fs.existsSync(path.join(fromCwd, 'pyproject.toml')) ||
    fs.existsSync(path.join(fromCwd, 'setup.py'))
  ) {
    return fromCwd
  }
  const fromScript = path.join(__dirname, '..', 'agent_fault_injection')
  if (
    fs.existsSync(path.join(fromScript, 'pyproject.toml')) ||
    fs.existsSync(path.join(fromScript, 'setup.py'))
  ) {
    return fromScript
  }
  return fromCwd
}

function ensureDirs() {
  for (const dir of [home, path.join(home, 'artifacts'), path.join(home, 'workspaces')]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function syncStablePackage(sourceRoot) {
  fs.mkdirSync(home, { recursive: true })
  fs.rmSync(stablePkgRoot, { recursive: true, force: true })
  fs.cpSync(sourceRoot, stablePkgRoot, { recursive: true })
  return stablePkgRoot
}

/**
 * Decide install root + editable flag.
 * Dev clone: editable against the checkout. Else: copy to stable python-pkg, non-editable.
 */
function resolveInstallTarget(sourceRoot) {
  const dev =
    isLocalDevClone() &&
    path.resolve(sourceRoot).startsWith(path.resolve(process.cwd()) + path.sep)
  if (dev) {
    return { packageRoot: sourceRoot, editable: true }
  }
  return { packageRoot: syncStablePackage(sourceRoot), editable: false }
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
  return { config: next, prevPackageRoot: prev.packageRoot || null }
}

function pythonOk(python = resolvePython()) {
  const r = spawnSync(
    python,
    ['-c', 'import agent_fault_injection; print(agent_fault_injection.__file__)'],
    { encoding: 'utf8', env: process.env, cwd: home },
  )
  return r.status === 0
}

function pipInstall(packageRoot, { editable }) {
  const args = editable ? ['install', '-e', packageRoot] : ['install', packageRoot]
  const r = spawnSync('pip', args, { stdio: 'inherit', env: process.env })
  if (r.status === 0) return true
  const r2 = spawnSync('pip3', args, { stdio: 'inherit', env: process.env })
  return r2.status === 0
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
      packageRoot: map.AGENT_INSIGHT_FI_PACKAGE_ROOT || '',
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

function packageRootChanged(desiredRoot, otherRoot) {
  if (!desiredRoot || !otherRoot) return false
  return path.resolve(desiredRoot) !== path.resolve(otherRoot)
}

/** true when existing worker must be killed and replaced. */
function shouldRestartWorker(desired, running, prevPackageRoot = null) {
  if (!running) return true
  if (!credentialsMatch(desired, running)) return true
  if (packageRootChanged(desired.packageRoot, running.packageRoot)) return true
  if (packageRootChanged(desired.packageRoot, prevPackageRoot)) return true
  if (desired.packageRoot && !fs.existsSync(desired.packageRoot)) return true
  return false
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
    AGENT_INSIGHT_FI_PACKAGE_ROOT: desired.packageRoot || '',
  }
}

function startWorkerDaemon(workerScript, { foreground = false, desired = {}, prevPackageRoot = null } = {}) {
  const logPath = path.join(home, 'worker.log')
  const pidPath = path.join(home, 'worker.pid')
  const existingPid = readPidFile(pidPath)
  if (isPidAlive(existingPid)) {
    const running = readProcessEnvKeys(existingPid)
    if (!shouldRestartWorker(desired, running, prevPackageRoot)) {
      console.log(`FI Worker 已在运行 pid=${existingPid}`)
      console.log(`日志: ${logPath}`)
      console.log(`停止: kill $(cat ${pidPath})`)
      return 0
    }
    console.log(
      `配置已变更（apiKey/host/packageRoot），正在重启 Worker… (旧 pid=${existingPid})`,
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
  const sourceRoot = resolvePackageSource()
  const python = resolvePython()
  const configPath = path.join(home, 'config.json')
  const prev =
    fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
  const prevPackageRoot = prev.packageRoot || null

  if (checkOnly) {
    const packageRoot = prevPackageRoot || sourceRoot
    const ok =
      Boolean(packageRoot) &&
      fs.existsSync(packageRoot) &&
      pythonOk(python) &&
      Boolean(prev.apiKey || process.env.AGENT_INSIGHT_API_KEY)
    console.log(
      ok
        ? `fault-injection: ok workerId=${prev.workerId || '?'} host=${prev.insightBaseUrl || '?'} packageRoot=${packageRoot}`
        : 'fault-injection: missing python package and/or apiKey (set AGENT_INSIGHT_API_KEY)',
    )
    process.exit(ok ? 0 : 1)
  }

  ensureDirs()

  if (!fs.existsSync(path.join(sourceRoot, 'pyproject.toml')) && !fs.existsSync(path.join(sourceRoot, 'setup.py'))) {
    console.error(`agent_fault_injection source missing: ${sourceRoot}`)
    process.exit(1)
  }

  const { packageRoot, editable } = resolveInstallTarget(sourceRoot)

  const needPip =
    !pythonOk(python) ||
    !fs.existsSync(packageRoot) ||
    (prevPackageRoot && !fs.existsSync(prevPackageRoot)) ||
    packageRootChanged(packageRoot, prevPackageRoot) ||
    !editable

  if (needPip) {
    console.log(
      editable
        ? `pip install -e ${packageRoot} (local clone / live reload)`
        : `pip install ${packageRoot} (stable copy under ${stablePkgRoot})`,
    )
    if (!pipInstall(packageRoot, { editable })) {
      process.exit(1)
    }
  }

  const { config } = writeConfig(packageRoot)

  console.log('fault-injection installed; data dir:', home)
  console.log('config:', path.join(home, 'config.json'))
  console.log('packageRoot:', packageRoot, editable ? '(editable)' : '(stable)')
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
        packageRoot: config.packageRoot,
      },
      prevPackageRoot,
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
  resolvePython,
  isLocalDevClone,
  resolvePackageSource,
  resolveInstallTarget,
  packageRootChanged,
  readProcessEnvKeys,
  credentialsMatch,
  shouldRestartWorker,
  stopWorker,
  workerEnv,
  stablePkgRoot,
}

if (require.main === module) {
  run()
}

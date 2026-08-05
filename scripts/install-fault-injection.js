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
  const insightBaseUrl = (
    process.env.AGENT_INSIGHT_HOST ||
    prev.insightBaseUrl ||
    'http://127.0.0.1:3000'
  ).replace(/\/$/, '')
  const apiKey = process.env.AGENT_INSIGHT_API_KEY || prev.apiKey || ''
  const workerId =
    prev.workerId || `fi-worker-${os.hostname()}-${randomBytes(3).toString('hex')}`
  const next = {
    ...prev,
    insightBaseUrl,
    apiKey,
    workerId,
    maxParallel: prev.maxParallel || 2,
    pollIntervalMs: prev.pollIntervalMs || 2000,
    artifactsDir: path.join(home, 'artifacts'),
    workspaceBase: path.join(home, 'workspaces'),
    dryRunDefault: false,
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

function run(_options = {}) {
  const checkOnly = process.argv.includes('--check')
  const startWorker = process.argv.includes('--start')
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
    console.log('Starting FI worker (keep this process running)…')
    const child = spawn(process.execPath, [workerScript], {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => process.exit(code || 0))
    return
  }

  console.log('Start worker with: npx agent-insight fi-worker')
  console.log('  or: node scripts/fi-worker.js')
}

module.exports = { run }

if (require.main === module) {
  run()
}

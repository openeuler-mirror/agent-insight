#!/usr/bin/env node
/**
 * FI Worker: claim runs from Insight, run local collector CLI, upload collect-result.
 * Usage: node scripts/fi-worker.js
 * Config: ~/.agent-insight/fault-injection/config.json
 *
 * Relies on an installed `agent_fault_injection` module (via install-fault-injection /
 * setup curl). Does not require spawning with cwd set to a git checkout.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { randomBytes } = require('crypto')

const homeFi = path.join(os.homedir(), '.agent-insight', 'fault-injection')
const configPath = path.join(homeFi, 'config.json')

function resolvePython() {
  return process.env.AGENT_FI_PYTHON || process.env.PYTHON || 'python3'
}

function normalizeInsightBaseUrl(host) {
  let value = String(host || '')
    .trim()
    .replace(/\/$/, '')
  if (!value) return value
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`
    const u = new URL(withScheme)
    if (u.hostname === '0.0.0.0' || u.hostname === '::' || u.hostname === '[::]') {
      u.hostname = '127.0.0.1'
      value = u.toString().replace(/\/$/, '')
    }
  } catch {
    /* keep raw */
  }
  return value
}

function loadConfig() {
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
  const insightBaseUrl = normalizeInsightBaseUrl(
    process.env.AGENT_INSIGHT_HOST ||
    raw.insightBaseUrl ||
    '',
  )
  const apiKey = process.env.AGENT_INSIGHT_API_KEY || raw.apiKey || ''
  const workerId =
    raw.workerId ||
    process.env.AGENT_INSIGHT_FI_WORKER_ID ||
    `fi-worker-${os.hostname()}-${randomBytes(3).toString('hex')}`
  const maxParallel = Math.max(1, Number(raw.maxParallel || 5))
  const pollIntervalMs = Math.max(500, Number(raw.pollIntervalMs || 2000))
  const workspaceBase =
    raw.workspaceBase || path.join(homeFi, 'workspaces')
  const artifactsDir = raw.artifactsDir || path.join(homeFi, 'artifacts')
  const packageRoot =
    process.env.AGENT_INSIGHT_FI_PACKAGE_ROOT ||
    raw.packageRoot ||
    path.join(__dirname, '..', 'agent_fault_injection')
  return {
    insightBaseUrl,
    apiKey,
    workerId,
    maxParallel,
    pollIntervalMs,
    workspaceBase,
    artifactsDir,
    packageRoot,
  }
}

function saveConfigPatch(patch) {
  const prev = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
  fs.mkdirSync(homeFi, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ ...prev, ...patch }, null, 2))
}

function resolveWorkspace(logical, workspaceBase) {
  const value = String(logical || '__default__').trim()
  if (!value || value === '__default__' || value === '~') return workspaceBase
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  if (path.isAbsolute(value)) return value
  return path.resolve(workspaceBase, value)
}

/** Stable cwd for CLI spawn — never a missing path (Node reports that as spawn ENOENT). */
function resolveCollectorCwd(cfg) {
  if (cfg.packageRoot && fs.existsSync(cfg.packageRoot)) return cfg.packageRoot
  fs.mkdirSync(homeFi, { recursive: true })
  return homeFi
}

function pythonModuleOk(python, env = process.env, cwd = homeFi) {
  const r = spawnSync(
    python,
    ['-c', 'import agent_fault_injection'],
    { encoding: 'utf8', env, cwd },
  )
  return r.status === 0
}

function formatSpawnError(err, { python, cwd }) {
  if (err && err.code === 'ENOENT') {
    if (!cwd || !fs.existsSync(cwd)) {
      return (
        `packageRoot missing: ${cwd || '(empty)'} ` +
        `(Node reports spawn ENOENT; re-run curl setup or install-fault-injection --start)`
      )
    }
    return `python executable not found: ${python}`
  }
  return err instanceof Error ? err.message : String(err)
}

function assertWorkerReady(cfg) {
  const python = resolvePython()
  if (cfg.packageRoot && !fs.existsSync(cfg.packageRoot)) {
    console.error(`[fi-worker] packageRoot does not exist: ${cfg.packageRoot}`)
    console.error(
      'Re-run: curl -fsSL "$HOST/api/fault-injection/setup?key=$API_KEY" | bash',
    )
    console.error('  or: npx agent-insight install-fault-injection --start')
    process.exit(1)
  }
  const cwd = resolveCollectorCwd(cfg)
  if (!pythonModuleOk(python, process.env, cwd)) {
    console.error(
      `[fi-worker] cannot import agent_fault_injection with ${python} (cwd=${cwd})`,
    )
    console.error('Re-run install-fault-injection / setup so the FI package is installed.')
    process.exit(1)
  }
  return { python, cwd }
}

// When HTTP(S)_PROXY is set, Node fetch often tunnels even 127.0.0.1 and hangs.
// Prefer curl --noproxy with -d @file (also avoids huge collect-result argv).
function hasHttpProxy() {
  return Boolean(
    process.env.http_proxy ||
      process.env.HTTP_PROXY ||
      process.env.https_proxy ||
      process.env.HTTPS_PROXY,
  )
}

async function api(cfg, method, apiPath, body) {
  const url = `${cfg.insightBaseUrl}${apiPath}`
  const useCurl = hasHttpProxy()

  if (useCurl) {
    const args = [
      '--noproxy',
      '*',
      '-sS',
      '-X',
      method,
      '-H',
      `x-witty-api-key: ${cfg.apiKey}`,
      '-H',
      'content-type: application/json',
    ]
    let tmpFile = null
    try {
      if (body !== undefined) {
        tmpFile = path.join(
          os.tmpdir(),
          `fi-worker-body-${process.pid}-${randomBytes(4).toString('hex')}.json`,
        )
        fs.writeFileSync(tmpFile, JSON.stringify(body), 'utf8')
        args.push('-d', `@${tmpFile}`)
      }
      args.push(url)
      const r = spawnSync('curl', args, {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      })
      if (r.error) throw new Error(r.error.message || String(r.error))
      if (r.signal) throw new Error(`curl killed by signal ${r.signal}`)
      if (r.status !== 0) {
        throw new Error((r.stderr || '').trim() || `curl exit ${r.status}`)
      }
      return r.stdout ? JSON.parse(r.stdout) : null
    } finally {
      if (tmpFile) {
        try {
          fs.unlinkSync(tmpFile)
        } catch {
          /* ignore */
        }
      }
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-witty-api-key': cfg.apiKey,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(json?.error || text || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return json
}

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' })
  return r.status === 0 ? (r.stdout || '').trim() : null
}

const INVENTORY_TIMEOUT_MS = 60_000

function emptyPlatform(note, executable = null) {
  return {
    ready: false,
    executable,
    agents: [],
    models: [],
    note,
  }
}

/** Startup inventory via Python catalog (opencode agent list + config). No JS builtins. */
function probeInventory(cfg, python) {
  const cwd = resolveCollectorCwd(cfg)
  const result = spawnSync(
    python,
    ['-m', 'agent_fault_injection.cli', 'platform', 'inventory', '--json'],
    {
      cwd,
      encoding: 'utf8',
      timeout: INVENTORY_TIMEOUT_MS,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    },
  )
  if (result.error) {
    const note =
      result.error.code === 'ETIMEDOUT'
        ? `platform inventory timed out after ${INVENTORY_TIMEOUT_MS}ms`
        : formatSpawnError(result.error, { python, cwd })
    console.error(`[fi-worker] inventory failed: ${note}`)
    return {
      platforms: {
        opencode: emptyPlatform(note, which('opencode')),
        xiaoo: emptyPlatform(note, which('xiaoo')),
      },
    }
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || `exit ${result.status}`
    console.error(`[fi-worker] inventory failed: ${detail}`)
    return {
      platforms: {
        opencode: emptyPlatform(detail, which('opencode')),
        xiaoo: emptyPlatform(detail, which('xiaoo')),
      },
    }
  }
  try {
    const payload = JSON.parse((result.stdout || '').trim() || '{}')
    const platforms = payload && typeof payload.platforms === 'object' ? payload.platforms : null
    if (!platforms) {
      const note = 'platform inventory JSON missing platforms'
      return {
        platforms: {
          opencode: emptyPlatform(note, which('opencode')),
          xiaoo: emptyPlatform(note, which('xiaoo')),
        },
      }
    }
    const normalize = (name) => {
      const raw = platforms[name]
      if (!raw || typeof raw !== 'object') {
        return emptyPlatform(`missing ${name} inventory`, which(name))
      }
      return {
        ready: Boolean(raw.ready),
        executable: raw.executable || which(name),
        agents: Array.isArray(raw.agents) ? raw.agents : [],
        models: Array.isArray(raw.models) ? raw.models : [],
        ...(typeof raw.note === 'string' && raw.note.trim() ? { note: raw.note.trim() } : {}),
      }
    }
    return {
      platforms: {
        opencode: normalize('opencode'),
        xiaoo: normalize('xiaoo'),
      },
    }
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err)
    console.error(`[fi-worker] inventory parse failed: ${note}`)
    return {
      platforms: {
        opencode: emptyPlatform(note, which('opencode')),
        xiaoo: emptyPlatform(note, which('xiaoo')),
      },
    }
  }
}

/** Build collector argv for FI CLI only — never spawn RAS. */
function buildCollectorArgs(run, workspace, artifactsDir) {
  const args = [
    '-m',
    'agent_fault_injection.cli',
    'run',
    '--platform',
    run.platform,
    '--agent',
    run.agent,
    '--fault',
    run.fault,
    '--prompt',
    run.prompt,
    '--workspace',
    workspace,
    '--output-dir',
    artifactsDir,
    '--run-id',
    run.runId,
  ]
  if (run.model) args.push('--model', run.model)
  if (run.submode) args.push('--submode', run.submode)
  if (run.timeoutSeconds) args.push('--timeout-seconds', String(run.timeoutSeconds))
  return args
}

function runCollector(cfg, run, python = resolvePython()) {
  return new Promise((resolve, reject) => {
    const workspace = resolveWorkspace(run.workspaceLogical, cfg.workspaceBase)
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(cfg.artifactsDir, { recursive: true })

    // FI experiments must not start RAS; RAS presence is platform mount only.
    const args = buildCollectorArgs(run, workspace, cfg.artifactsDir)
    const cwd = resolveCollectorCwd(cfg)
    const env = { ...process.env }

    const child = spawn(python, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    activeChildren.set(run.runId, child)
    let stderr = ''
    child.stderr.on('data', (c) => {
      stderr += String(c)
    })
    child.on('error', (err) => {
      activeChildren.delete(run.runId)
      reject(new Error(formatSpawnError(err, { python, cwd })))
    })
    child.on('close', (code) => {
      activeChildren.delete(run.runId)
      if (code !== 0) {
        // Still prefer a written collect-result (e.g. fault activated then
        // session abort) over treating the whole run as empty failure.
        try {
          resolve(readCollectResult(cfg.artifactsDir, run.runId))
          return
        } catch {
          reject(new Error(stderr || `collector exited ${code}`))
          return
        }
      }
      resolve(readCollectResult(cfg.artifactsDir, run.runId))
    })
  })
}

const activeChildren = new Map()

function killRun(runId) {
  const child = activeChildren.get(runId)
  if (!child?.pid) return false
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  return true
}

function readCollectResult(artifactsDir, runId) {
  const root = path.join(artifactsDir, runId)
  const direct = path.join(root, 'collect-result.json')
  if (fs.existsSync(direct)) return JSON.parse(fs.readFileSync(direct, 'utf8'))
  if (!fs.existsSync(root)) throw new Error(`artifact dir missing: ${root}`)
  for (const entry of fs.readdirSync(root)) {
    const candidate = path.join(root, entry, 'collect-result.json')
    if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8'))
  }
  throw new Error(`collect-result.json not found under ${root}`)
}

async function uploadResult(cfg, runId, payload, extra = {}) {
  return api(cfg, 'POST', `/api/fault-injection/runs/${encodeURIComponent(runId)}/collect-result`, {
    ...payload,
    ...extra,
  })
}

/** First non-internal IPv4 (never prefer 127.x). */
function pickReportedIp() {
  const nets = os.networkInterfaces() || {}
  const candidates = []
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      const family = entry.family
      const isV4 = family === 'IPv4' || family === 4
      if (!isV4 || entry.internal) continue
      const address = String(entry.address || '').trim()
      if (!address || address.startsWith('127.')) continue
      candidates.push(address)
    }
  }
  return candidates[0] || null
}

async function main() {
  const cfg = loadConfig()
  if (!cfg.insightBaseUrl || !cfg.apiKey) {
    console.error(
      'Missing insightBaseUrl/apiKey. Set AGENT_INSIGHT_HOST + AGENT_INSIGHT_API_KEY or run install-fault-injection.',
    )
    process.exit(1)
  }
  const { python } = assertWorkerReady(cfg)
  saveConfigPatch({
    insightBaseUrl: cfg.insightBaseUrl,
    apiKey: cfg.apiKey,
    workerId: cfg.workerId,
    workspaceBase: cfg.workspaceBase,
    artifactsDir: cfg.artifactsDir,
    maxParallel: cfg.maxParallel,
    pollIntervalMs: cfg.pollIntervalMs,
    packageRoot: cfg.packageRoot,
  })
  console.log(`[fi-worker] workerId=${cfg.workerId} host=${cfg.insightBaseUrl}`)
  console.log(`[fi-worker] python=${python} packageRoot=${cfg.packageRoot}`)

  let busy = 0
  console.log('[fi-worker] probing platform inventory via Python catalog…')
  const probed = probeInventory(cfg, python)
  const reportedIp = pickReportedIp()
  const inventory = {
    ...probed,
    ...(reportedIp ? { reportedIp } : {}),
  }
  if (reportedIp) console.log(`[fi-worker] reportedIp=${reportedIp}`)
  for (const [name, info] of Object.entries(inventory.platforms || {})) {
    const agents = Array.isArray(info.agents) ? info.agents.length : 0
    const models = Array.isArray(info.models) ? info.models.length : 0
    const note = info.note ? ` note=${info.note}` : ''
    console.log(
      `[fi-worker] inventory ${name}: ready=${Boolean(info.ready)} agents=${agents} models=${models}${note}`,
    )
  }

  async function tick() {
    try {
      await api(cfg, 'POST', '/api/fault-injection/worker/heartbeat', {
        workerId: cfg.workerId,
        hostname: os.hostname(),
        version: '0.1.0',
        inventory,
        busySlots: busy,
      })
      const claim = await api(cfg, 'POST', '/api/fault-injection/worker/claim', {
        workerId: cfg.workerId,
        limit: Math.max(0, cfg.maxParallel - busy),
      })
      for (const cmd of claim.commands || []) {
        if (cmd.type === 'stop' && cmd.runId) killRun(cmd.runId)
      }
      for (const run of claim.runs || []) {
        busy += 1
        void (async () => {
          try {
            const payload = await runCollector(cfg, run, python)
            await uploadResult(cfg, run.runId, payload)
            console.log(`[fi-worker] completed ${run.runId}`)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.error(`[fi-worker] failed ${run.runId}:`, message)
            try {
              await uploadResult(cfg, run.runId, {}, { error: message, interactions: [] })
            } catch (uploadErr) {
              console.error('[fi-worker] upload failed', uploadErr)
            }
          } finally {
            busy = Math.max(0, busy - 1)
          }
        })()
      }
    } catch (err) {
      console.error('[fi-worker] tick error', err instanceof Error ? err.message : err)
    }
  }

  await tick()
  setInterval(tick, cfg.pollIntervalMs)
}

function run() {
  return main()
}

module.exports = {
  run,
  buildCollectorArgs,
  resolvePython,
  resolveCollectorCwd,
  formatSpawnError,
  pythonModuleOk,
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

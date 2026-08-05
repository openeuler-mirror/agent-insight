#!/usr/bin/env node
/**
 * FI Worker: claim runs from Insight, run local collector CLI, upload collect-result.
 * Usage: node scripts/fi-worker.js
 * Config: ~/.agent-insight/fault-injection/config.json
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { randomBytes } = require('crypto')

const homeFi = path.join(os.homedir(), '.agent-insight', 'fault-injection')
const configPath = path.join(homeFi, 'config.json')

function loadConfig() {
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
  const insightBaseUrl = (
    process.env.AGENT_INSIGHT_HOST ||
    raw.insightBaseUrl ||
    ''
  ).replace(/\/$/, '')
  const apiKey = process.env.AGENT_INSIGHT_API_KEY || raw.apiKey || ''
  const workerId =
    raw.workerId ||
    process.env.AGENT_INSIGHT_FI_WORKER_ID ||
    `fi-worker-${os.hostname()}-${randomBytes(3).toString('hex')}`
  const maxParallel = Math.max(1, Number(raw.maxParallel || 2))
  const pollIntervalMs = Math.max(500, Number(raw.pollIntervalMs || 2000))
  const workspaceBase =
    raw.workspaceBase || path.join(homeFi, 'workspaces')
  const artifactsDir = raw.artifactsDir || path.join(homeFi, 'artifacts')
  const packageRoot =
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

// Prefer curl --noproxy when HTTP(S)_PROXY is set (Node fetch often ignores NO_PROXY).
async function api(cfg, method, apiPath, body) {
  const url = `${cfg.insightBaseUrl}${apiPath}`
  if (process.env.http_proxy || process.env.HTTP_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY) {
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
    if (body) args.push('-d', JSON.stringify(body))
    args.push(url)
    const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    if (r.status !== 0) throw new Error(r.stderr || `curl exit ${r.status}`)
    return r.stdout ? JSON.parse(r.stdout) : null
  }
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-witty-api-key': cfg.apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
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

function probeInventory(packageRoot) {
  const platforms = {}
  for (const id of ['opencode', 'xiaoo']) {
    const executable = which(id)
    platforms[id] = {
      ready: Boolean(executable),
      executable,
      agents: executable
        ? [{ id: id === 'xiaoo' ? 'default' : 'build', label: id === 'xiaoo' ? 'default' : 'build' }]
        : [],
      models: [],
    }
  }
  try {
    const code = `
import json
from agent_fault_injection.platform_adapters.opencode.adapter import OpenCodeAdapter
from agent_fault_injection.platform_adapters.xiaoo.adapter import XiaoOAdapter
out = {}
for name, Adapter in (("opencode", OpenCodeAdapter), ("xiaoo", XiaoOAdapter)):
    try:
        ad = Adapter()
        agents = ad.list_agents().get("agents") or ad.list_agents().get("items") or []
        models = ad.list_models().get("models") or ad.list_models().get("items") or []
        out[name] = {"agents": agents, "models": models}
    except Exception as e:
        out[name] = {"agents": [], "models": [], "error": str(e)}
print(json.dumps(out))
`
    const r = spawnSync('python3', ['-c', code], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: process.env,
    })
    if (r.status === 0 && r.stdout) {
      const parsed = JSON.parse(r.stdout)
      for (const id of Object.keys(platforms)) {
        const agents = parsed[id]?.agents
        const models = parsed[id]?.models
        if (Array.isArray(agents) && agents.length) platforms[id].agents = agents
        if (Array.isArray(models)) platforms[id].models = models
      }
    }
  } catch {
    /* keep which-based defaults */
  }
  return { platforms }
}

function runCollector(cfg, run) {
  return new Promise((resolve, reject) => {
    const workspace = resolveWorkspace(run.workspaceLogical, cfg.workspaceBase)
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(cfg.artifactsDir, { recursive: true })
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
      cfg.artifactsDir,
      '--run-id',
      run.runId,
      '--no-judge',
    ]
    if (run.model) args.push('--model', run.model)
    if (run.submode) args.push('--submode', run.submode)
    if (run.timeoutSeconds) args.push('--timeout-seconds', String(run.timeoutSeconds))

    const child = spawn('python3', args, {
      cwd: cfg.packageRoot,
      env: process.env,
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
      reject(err)
    })
    child.on('close', (code) => {
      activeChildren.delete(run.runId)
      if (code !== 0) {
        reject(new Error(stderr || `collector exited ${code}`))
        return
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

async function main() {
  const cfg = loadConfig()
  if (!cfg.insightBaseUrl || !cfg.apiKey) {
    console.error(
      'Missing insightBaseUrl/apiKey. Set AGENT_INSIGHT_HOST + AGENT_INSIGHT_API_KEY or run install-fault-injection.',
    )
    process.exit(1)
  }
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

  let busy = 0
  const inventory = probeInventory(cfg.packageRoot)

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
            const payload = await runCollector(cfg, run)
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

module.exports = { run }

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

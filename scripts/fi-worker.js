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
  const maxParallel = Math.max(1, Number(raw.maxParallel || 5))
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

// Prefer fetch for loopback. When HTTP(S)_PROXY is set for remote hosts, use curl
// with --noproxy and -d @file so large collect-result bodies do not blow argv.
function isLoopbackHost(urlStr) {
  try {
    const host = new URL(urlStr).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

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
  const useCurl = hasHttpProxy() && !isLoopbackHost(url)

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

const OPENCODE_BUILTIN_AGENTS = ['build', 'plan', 'general', 'explore']

function stripJsonc(text) {
  let out = ''
  let i = 0
  let inString = false
  let escape = false
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

function readJsonConfig(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(stripJsonc(raw))
  } catch {
    return null
  }
}

function loadOpenCodeConfig() {
  const home = path.join(os.homedir(), '.config', 'opencode')
  for (const name of ['opencode.jsonc', 'opencode.json', 'config.json']) {
    const data = readJsonConfig(path.join(home, name))
    if (data && typeof data === 'object') return data
  }
  return null
}

function modelsFromOpenCodeConfig(config) {
  const models = []
  const seen = new Set()
  const providers = config && typeof config.provider === 'object' ? config.provider : null
  if (providers) {
    for (const [providerId, body] of Object.entries(providers)) {
      if (!providerId || !body || typeof body !== 'object') continue
      const providerModels = body.models
      if (!providerModels || typeof providerModels !== 'object') continue
      for (const [modelId, meta] of Object.entries(providerModels)) {
        if (!modelId) continue
        const id = `${providerId}/${modelId}`
        if (seen.has(id)) continue
        seen.add(id)
        const label =
          meta && typeof meta === 'object' && typeof meta.name === 'string' && meta.name.trim()
            ? meta.name.trim()
            : modelId
        models.push({
          id,
          providerID: providerId,
          modelID: modelId,
          name: label,
          label,
          default: false,
        })
      }
    }
  }
  const top = typeof config?.model === 'string' ? config.model.trim() : ''
  if (top && top.includes('/')) {
    const [providerID, modelID] = top.split('/', 2)
    if (providerID && modelID && !seen.has(top)) {
      models.unshift({
        id: top,
        providerID,
        modelID,
        name: modelID,
        label: modelID,
        default: true,
      })
      seen.add(top)
    } else {
      for (const row of models) {
        row.default = row.id === top
      }
    }
  }
  return models
}

function loadXiaoOLlm() {
  const envPath = (process.env.XIAOO_CONFIG || '').trim()
  const configPath = envPath
    ? envPath.replace(/^~(?=\/|$)/, os.homedir())
    : path.join(os.homedir(), '.config', 'xiaoo', 'config.toml')
  try {
    if (!fs.existsSync(configPath)) return { models: [], note: `missing ${configPath}` }
    const text = fs.readFileSync(configPath, 'utf8')
    let inLlm = false
    const values = {}
    for (const line of text.split(/\r?\n/)) {
      const stripped = line.trim()
      if (!stripped || stripped.startsWith('#')) continue
      if (stripped.startsWith('[') && stripped.endsWith(']')) {
        inLlm = stripped === '[llm]'
        continue
      }
      if (!inLlm) continue
      const eq = stripped.indexOf('=')
      if (eq < 0) continue
      const key = stripped.slice(0, eq).trim()
      let val = stripped.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      values[key] = val
    }
    const provider = typeof values.provider === 'string' ? values.provider.trim() : ''
    const model = typeof values.model === 'string' ? values.model.trim() : ''
    if (!provider || !model) {
      return { models: [], note: `No [llm] provider/model in ${configPath}` }
    }
    const id = `${provider}/${model}`
    return {
      models: [
        {
          id,
          providerID: provider,
          modelID: model,
          name: model,
          label: model,
          default: true,
        },
      ],
    }
  } catch (err) {
    return { models: [], note: err instanceof Error ? err.message : String(err) }
  }
}

/** Lightweight inventory: which + builtins + local config files. Never shells out to platform CLIs. */
function probeInventory() {
  const platforms = {}

  const ocExe = which('opencode')
  const ocConfig = loadOpenCodeConfig()
  platforms.opencode = {
    ready: Boolean(ocExe),
    executable: ocExe,
    agents: ocExe
      ? OPENCODE_BUILTIN_AGENTS.map((id) => ({ id, name: id, label: id }))
      : [],
    models: ocExe && ocConfig ? modelsFromOpenCodeConfig(ocConfig) : [],
  }

  const xoExe = which('xiaoo')
  const xo = loadXiaoOLlm()
  platforms.xiaoo = {
    ready: Boolean(xoExe),
    executable: xoExe,
    agents: xoExe
      ? [{ id: 'defaultagent', name: 'defaultagent', label: 'defaultagent' }]
      : [],
    models: xoExe ? xo.models : [],
  }
  if (xo.note && xoExe) platforms.xiaoo.note = xo.note

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
  const inventory = probeInventory()

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

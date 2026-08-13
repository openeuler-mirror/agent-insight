#!/usr/bin/env node
/**
 * Agent Insight 常驻客户端服务。
 *
 * 由 systemd / launchd 托管，独立于 OpenCode 等 Agent 平台启停。
 * 职责：
 *   - 主动建立出站 WSS 控制连接（断线退避重连；失败降级 HTTPS 长轮询）
 *   - 能力发现（IP / OS / 平台 / 模型 / 组件版本）并上报
 *   - 按 configRef 拉取不可变配置快照，校验后原子写入
 *   - 执行白名单 action，回报 RECEIVED / RUNNING / SUCCEEDED / FAILED
 *   - 吸收 FI Worker：领取故障注入 run、跑采集器、上传结果
 *
 * 配置：~/.agent-insight/client/config.json
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { randomBytes } = require('crypto')

const { connectWebSocket } = require('./ws-client')

const CLIENT_HOME = path.join(os.homedir(), '.agent-insight', 'client')
const CONFIG_PATH = path.join(CLIENT_HOME, 'config.json')
const SPOOL_PATH = path.join(CLIENT_HOME, 'spool.json')

const WHITELIST = new Set([
  'APPLY_CLIENT_CONFIG',
  'PREPARE_EXPERIMENT_CASE',
  'RUN_EXPERIMENT_CASE',
  'REFRESH_CAPABILITIES',
])

// 配置类 action 禁止携带下载地址/路径/完整配置；运行类禁止携带自由执行字段。
const CONFIG_FORBIDDEN = ['url', 'config', 'path', 'downloadUrl', 'file']
const RUN_FORBIDDEN = ['command', 'shell', 'args', 'cwd', 'executable', 'script']

const AGENT_VERSION = '1.0.0'
const HEARTBEAT_MS = 30_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000
// 服务端 ping 间隔 30s；连续两次没动静就判定连接已死。
const LIVENESS_TIMEOUT_MS = 75_000
const LIVENESS_CHECK_MS = 15_000

function log(...args) {
  console.log(`[ras-client ${new Date().toISOString()}]`, ...args)
}

function logErr(...args) {
  console.error(`[ras-client ${new Date().toISOString()}]`, ...args)
}

// ---------------------------------------------------------------- config

function loadConfig() {
  const raw = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {}
  return {
    insightBaseUrl: (process.env.AGENT_INSIGHT_HOST || raw.insightBaseUrl || '').replace(/\/$/, ''),
    clientId: raw.clientId || '',
    deviceCredential: raw.deviceCredential || '',
    // 注册时下发的地址会随服务端换端口/域名而失效，因此以当前 insightBaseUrl 为准
    // 重新推导；注册值仅在 base 缺失时兜底。
    websocketUrl: raw.websocketUrl || '',
    pollUrl: raw.pollUrl || '',
    maxParallelFi: Math.max(1, Number(raw.maxParallelFi || 5)),
    workspaceBase: raw.workspaceBase || path.join(CLIENT_HOME, 'workspaces'),
    artifactsDir: raw.artifactsDir || path.join(CLIENT_HOME, 'artifacts'),
    fiPackageRoot:
      process.env.AGENT_INSIGHT_FI_PACKAGE_ROOT ||
      raw.fiPackageRoot ||
      path.join(__dirname, '..', 'agent_fault_injection'),
    // 安装器可显式写入一个已验证可 import 的目录；缺省时 resolveFiCwd 自行探测。
    fiCwd: process.env.AGENT_INSIGHT_FI_CWD || raw.fiCwd || '',
    // 安装器在 PEP 668 环境下会写入 venv 解释器路径。
    fiPython: process.env.AGENT_FI_PYTHON || raw.fiPython || '',
  }
}

function saveConfigPatch(patch) {
  const prev = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {}
  fs.mkdirSync(CLIENT_HOME, { recursive: true })
  const next = { ...prev, ...patch }
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, CONFIG_PATH)
}

/**
 * 控制通道地址以当前 insightBaseUrl 为准重新推导。
 * 注册时写入 config.json 的绝对地址在服务端换端口后会指向旧实例，
 * 表现为「客户端在跑却永远连不上」。
 */
function controlUrls(cfg) {
  const base = String(cfg.insightBaseUrl || '').replace(/\/$/, '')
  if (!base) {
    return { websocketUrl: cfg.websocketUrl, pollUrl: cfg.pollUrl }
  }
  return {
    websocketUrl: `${base.replace(/^http/, 'ws')}/api/reliability/client/v1/control`,
    pollUrl: `${base}/api/reliability/client/v1/commands/next`,
  }
}

// ---------------------------------------------------------------- http

async function api(cfg, method, apiPath, body, extraHeaders = {}) {
  const res = await fetch(`${cfg.insightBaseUrl}${apiPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.deviceCredential}`,
      'x-agent-insight-client-id': cfg.clientId,
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return null
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(json?.error?.message || json?.error || text || `HTTP ${res.status}`)
    err.status = res.status
    err.code = json?.error?.code
    throw err
  }
  return json
}

// ---------------------------------------------------------------- discovery

function pickReportedIp() {
  const nets = os.networkInterfaces() || {}
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      const isV4 = entry.family === 'IPv4' || entry.family === 4
      if (!isV4 || entry.internal) continue
      const address = String(entry.address || '').trim()
      if (address && !address.startsWith('127.')) return address
    }
  }
  return null
}

function resolvePython(cfg) {
  return (
    process.env.AGENT_FI_PYTHON ||
    (cfg && cfg.fiPython) ||
    process.env.PYTHON ||
    'python3'
  )
}

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' })
  return r.status === 0 ? (r.stdout || '').trim() : null
}

/**
 * 找一个能 `import agent_fault_injection` 的工作目录。
 *
 * 不能想当然用 fiPackageRoot：那是 pip 的**安装源目录**（含 pyproject.toml），
 * 在它里面反而 import 不到同名包 —— 可导入的是它的父目录（仓库根），
 * 或 pip 装好之后的任意目录。逐个实测而不是假设。
 */
function resolveFiCwd(cfg, python = resolvePython(cfg)) {
  if (cachedFiCwd !== undefined) return cachedFiCwd
  const candidates = [
    cfg.fiCwd,
    cfg.fiPackageRoot && path.dirname(cfg.fiPackageRoot),
    cfg.fiPackageRoot,
    CLIENT_HOME,
  ].filter(Boolean)
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue
    const r = spawnSync(python, ['-c', 'import agent_fault_injection'], {
      cwd: dir,
      encoding: 'utf8',
    })
    if (r.status === 0) {
      cachedFiCwd = dir
      return dir
    }
  }
  cachedFiCwd = null
  return null
}

let cachedFiCwd

/**
 * Python / agent_fault_injection 是**可选**能力。
 * 缺失时客户端照常上线，只是 faultInjection.ready=false —— 服务端据此不派发 FI run。
 * 常驻服务里绝不能因为可选依赖缺失而退出，否则会陷入 systemd 重启循环。
 */
function probeFaultInjection(cfg) {
  const python = resolvePython(cfg)
  const cwd = resolveFiCwd(cfg, python)
  if (!cwd) {
    return {
      ready: false,
      note: `cannot import agent_fault_injection with ${python}`,
      platforms: {},
    }
  }
  const result = spawnSync(
    python,
    ['-m', 'agent_fault_injection.cli', 'platform', 'inventory', '--json'],
    { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  )
  if (result.status !== 0) {
    const note = (result.stderr || result.stdout || '').trim() || `exit ${result.status}`
    return { ready: false, note, platforms: {} }
  }
  try {
    const payload = JSON.parse((result.stdout || '').trim() || '{}')
    return { ready: true, platforms: payload.platforms || {} }
  } catch (err) {
    return { ready: false, note: `inventory parse failed: ${err.message}`, platforms: {} }
  }
}

/** 探测代价高（要 spawn Python），一次探测供两份上报共用。 */
let cachedProbe = null

function getProbe(cfg, { refresh = false } = {}) {
  if (!cachedProbe || refresh) cachedProbe = probeFaultInjection(cfg)
  return cachedProbe
}

function normalizeModelIds(models) {
  return Array.isArray(models)
    ? models
        .map((m) => (typeof m === 'string' ? m : String(m?.id || m?.name || m?.label || '')))
        .map((m) => m.trim())
        .filter(Boolean)
    : []
}

function buildCapabilities(cfg, opts) {
  const fi = getProbe(cfg, opts)
  const platforms = Object.entries(fi.platforms || {}).map(([id, info]) => ({
    id,
    version: info?.version ? String(info.version) : undefined,
    models: normalizeModelIds(info?.models),
    actions: [...WHITELIST],
  }))
  if (!platforms.length) {
    // 没有 FI inventory 时仍上报本机可见的平台可执行文件，配置下发不依赖 FI。
    for (const id of ['opencode', 'xiaoo']) {
      if (which(id)) platforms.push({ id, models: [], actions: [...WHITELIST] })
    }
  }
  return {
    platforms,
    actions: [...WHITELIST],
    components: { clientVersion: AGENT_VERSION },
    faultInjection: {
      ready: fi.ready,
      note: fi.note,
      maxParallel: cfg.maxParallelFi,
    },
  }
}

/**
 * 把同一份探测结果转成 FI Worker 期望的 inventory 形状。
 *
 * 这是「一条命令同时生效」的关键：实验页 / 注入页 / 平台下拉全部读
 * FaultInjectionWorker.inventoryJson，客户端不写这张表就等于不存在。
 * Python 不可用时仍要上报（ready:false + note），让页面能区分
 * 「机器没装」和「机器在线但 FI 未就绪」。
 */
function buildFiInventory(cfg, opts) {
  const fi = getProbe(cfg, opts)
  const platforms = {}
  for (const id of ['opencode', 'xiaoo']) {
    const info = fi.platforms?.[id]
    if (info && typeof info === 'object') {
      platforms[id] = {
        ready: Boolean(info.ready),
        executable: info.executable || which(id),
        agents: Array.isArray(info.agents) ? info.agents : [],
        models: Array.isArray(info.models) ? info.models : [],
        ...(info.note ? { note: String(info.note) } : {}),
      }
    } else {
      platforms[id] = {
        ready: false,
        executable: which(id),
        agents: [],
        models: [],
        note: fi.note || 'fault injection components not installed',
      }
    }
  }
  const reportedIp = pickReportedIp()
  return { platforms, ...(reportedIp ? { reportedIp } : {}) }
}

// ---------------------------------------------------------------- config write

/**
 * 平台适配器决定配置文件位置。服务端指令**只给 configRef**，
 * 路径永远由本地决定，不接受下发。
 */
/** 只保留安全字符，并压掉连续的点 —— `..` 一旦留存就是目录穿越的原料。 */
function sanitizeSegment(value, fallback) {
  const safe = String(value || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[.-]+/, '')
    .slice(0, 64)
  return safe || fallback
}

function configTargetPath(platform, scope, correlation) {
  const root = path.join(os.homedir(), '.agent-insight')
  const platformDir = sanitizeSegment(platform, 'unknown')
  if (scope === 'experiment') {
    const runId = sanitizeSegment(
      correlation?.caseRunId || correlation?.experimentRunId || 'run',
      'run',
    )
    return path.join(root, 'ras', platformDir, 'experiments', `${runId}.json`)
  }
  return path.join(root, 'ras', platformDir, 'client-config.json')
}

/** 写临时文件 → fsync → 原子 rename，避免 RAS 读到半份 JSON。 */
function atomicWriteJson(targetPath, data) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, targetPath)
}

async function applyConfigSnapshot(cfg, payload) {
  const configRef = String(payload.configRef || '')
  if (!configRef) throw new Error('missing configRef')

  const snapshot = await api(cfg, 'GET', `/api/reliability/client/v1/config-snapshots/${encodeURIComponent(configRef)}`)
  if (!snapshot) throw new Error('empty snapshot')

  // 双端校验：绑定关系、平台、版本、checksum 都要对得上指令。
  if (snapshot.clientId !== cfg.clientId) throw new Error('snapshot clientId mismatch')
  if (payload.platform && snapshot.platform !== payload.platform) {
    throw new Error('snapshot platform mismatch')
  }
  if (payload.configVersion && snapshot.configVersion !== payload.configVersion) {
    throw new Error('snapshot configVersion mismatch')
  }
  if (payload.checksum && snapshot.checksum !== payload.checksum) {
    throw new Error('snapshot checksum mismatch')
  }

  const target = configTargetPath(snapshot.platform, snapshot.scope, snapshot.correlation)
  atomicWriteJson(target, {
    kind: 'agent-insight.ras-config',
    schemaVersion: snapshot.schemaVersion,
    scope: snapshot.scope,
    platform: snapshot.platform,
    clientId: snapshot.clientId,
    configVersion: snapshot.configVersion,
    checksum: snapshot.checksum,
    correlation: snapshot.correlation || undefined,
    expiresAt: snapshot.expiresAt,
    config: snapshot.config,
  })

  // 上面那份是审计快照（带 configVersion/checksum，便于排查）；
  // RAS 与 OpenCode 插件实际读的是 ~/.agent-insight/ras/config.json，
  // 不写它等于配置根本没生效。client scope 才写：experiment scope 是
  // 单次 Case 的临时配置，不该污染长期配置。
  if (snapshot.scope === 'client') {
    await writeRasRuntimeConfig(snapshot)
  }
  return { path: target, checksum: snapshot.checksum, configVersion: snapshot.configVersion }
}

function rasRuntimeConfigPath() {
  const rasHome =
    process.env.AGENT_INSIGHT_RAS_HOME || path.join(os.homedir(), '.agent-insight', 'ras')
  return path.join(rasHome, 'config.json')
}

/**
 * 把快照里的 capability 段合并进 RAS 的 config.json。
 *
 * 复用 OpenCode 插件自己的合并函数，保证两条写入路径产出**完全一致**的结构 ——
 * 自己再实现一遍迟早会漂移。该模块是 ESM，这里动态 import；
 * 它属于可选组件（未装 RAS 时不存在），失败不能影响配置写入主流程。
 */
async function writeRasRuntimeConfig(snapshot) {
  const capability = snapshot.config?.capability
  if (!capability || typeof capability !== 'object') return

  const target = rasRuntimeConfigPath()
  let existing = {}
  try {
    existing = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    existing = {}
  }

  let merged
  try {
    const mod = await import(
      path.join(__dirname, '..', 'agent_ras', 'platform_adapter', 'opencode', 'config_sync.js')
    )
    // 某些加载器（tsx / ts-node）会把 ESM 包一层 default，取不到就是 undefined。
    const merge =
      mod.mergeCapabilityIntoLocalRasConfig || mod.default?.mergeCapabilityIntoLocalRasConfig
    if (typeof merge !== 'function') {
      throw new Error('mergeCapabilityIntoLocalRasConfig not exported')
    }
    merged = merge(
      existing,
      capability,
      { updatedAt: new Date().toISOString() },
      snapshot.platform,
    )
  } catch (err) {
    logErr(`ras config merge unavailable (${err.message}); 跳过运行时配置写入`)
    return
  }

  atomicWriteJson(target, merged)
  log(`ras runtime config updated: ${target}`)
}

// ---------------------------------------------------------------- FI collector

const activeChildren = new Map()
/** 可靠性 Case 独占槽：持有期间不领 FI run，避免多个故障注入互相污染。 */
let reliabilitySlotHeld = false
let fiBusy = 0

function resolveWorkspace(logical, workspaceBase) {
  const value = String(logical || '__default__').trim()
  if (!value || value === '__default__' || value === '~') return workspaceBase
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  if (path.isAbsolute(value)) return value
  return path.resolve(workspaceBase, value)
}

function buildCollectorArgs(run, workspace, artifactsDir) {
  const args = [
    '-m', 'agent_fault_injection.cli', 'run',
    '--platform', run.platform,
    '--agent', run.agent,
    '--fault', run.fault,
    '--prompt', run.prompt,
    '--workspace', workspace,
    '--output-dir', artifactsDir,
    '--run-id', run.runId,
  ]
  if (run.model) args.push('--model', run.model)
  if (run.submode) args.push('--submode', run.submode)
  if (run.timeoutSeconds) args.push('--timeout-seconds', String(run.timeoutSeconds))
  return args
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

function runCollector(cfg, run) {
  return new Promise((resolve, reject) => {
    const python = resolvePython(cfg)
    const workspace = resolveWorkspace(run.workspaceLogical, cfg.workspaceBase)
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(cfg.artifactsDir, { recursive: true })
    const args = buildCollectorArgs(run, workspace, cfg.artifactsDir)
    // 必须与探测同一个 cwd —— 否则探测说 ready、实际 spawn 时 import 不到。
    const cwd = resolveFiCwd(cfg, python) || cfg.fiPackageRoot
    const child = spawn(python, args, {
      cwd,
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
      try {
        resolve(readCollectResult(cfg.artifactsDir, run.runId))
      } catch (err) {
        reject(code !== 0 ? new Error(stderr || `collector exited ${code}`) : err)
      }
    })
  })
}

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

// ---------------------------------------------------------------- actions

async function executeAction(cfg, frame, sendStatus) {
  const { action, payload = {} } = frame

  // 本地白名单二次校验：服务端已校验过，但客户端不能只信服务端。
  if (!WHITELIST.has(action)) {
    await sendStatus('FAILED', { error: { code: 'ACTION_NOT_ALLOWED', message: `未知 action: ${action}` } })
    return
  }
  const forbidden = action === 'RUN_EXPERIMENT_CASE' ? RUN_FORBIDDEN : CONFIG_FORBIDDEN
  for (const key of Object.keys(payload)) {
    if (forbidden.includes(key)) {
      await sendStatus('FAILED', {
        error: { code: 'PAYLOAD_FORBIDDEN', message: `payload 不允许字段 ${key}` },
      })
      return
    }
  }

  if (action === 'REFRESH_CAPABILITIES') {
    await sendStatus('RUNNING', {})
    await reportCapabilities(cfg)
    await sendStatus('SUCCEEDED', { result: { state: 'REFRESHED' } })
    return
  }

  if (action === 'APPLY_CLIENT_CONFIG' || action === 'PREPARE_EXPERIMENT_CASE') {
    await sendStatus('RUNNING', { result: { state: 'PULLING' } })
    try {
      const written = await applyConfigSnapshot(cfg, payload)
      await sendStatus('SUCCEEDED', {
        result: {
          state: 'WRITTEN',
          configRef: payload.configRef,
          configVersion: written.configVersion,
          checksum: written.checksum,
          writtenAt: new Date().toISOString(),
        },
      })
    } catch (err) {
      await sendStatus('FAILED', {
        result: { state: 'PULLING' },
        error: { code: err.code || 'CONFIG_APPLY_FAILED', message: err.message },
      })
    }
    return
  }

  if (action === 'RUN_EXPERIMENT_CASE') {
    if (fiBusy > 0) {
      await sendStatus('FAILED', {
        error: { code: 'CLIENT_BUSY', message: '本机正在执行故障注入任务，拒绝并发运行可靠性 Case' },
      })
      return
    }
    reliabilitySlotHeld = true
    await sendStatus('RUNNING', {})
    try {
      const result = await runExperimentCase(cfg, payload)
      await sendStatus('SUCCEEDED', { result })
    } catch (err) {
      await sendStatus('FAILED', {
        error: { code: err.code || 'CASE_RUN_FAILED', message: err.message },
      })
    } finally {
      reliabilitySlotHeld = false
    }
  }
}

/**
 * 通过已安装的平台适配器启动 Case。
 * 平台可执行文件、工作目录和启动参数都由本地决定 —— 指令只给结构化输入。
 */
async function runExperimentCase(cfg, payload) {
  const platform = String(payload.platform || '')
  const model = payload.model ? String(payload.model) : null
  const input = String(payload.input || '')
  if (!platform || !input) throw new Error('platform 与 input 必填')

  const executable = which(platform)
  if (!executable) {
    const err = new Error(`平台可执行文件不可用: ${platform}`)
    err.code = 'PLATFORM_NOT_AVAILABLE'
    throw err
  }

  const correlation = payload.correlation || {}
  const env = {
    ...process.env,
    AGENT_INSIGHT_CLIENT_ID: cfg.clientId,
    AGENT_INSIGHT_EXPERIMENT_ID: String(correlation.experimentId || ''),
    AGENT_INSIGHT_EXPERIMENT_RUN_ID: String(correlation.experimentRunId || ''),
    AGENT_INSIGHT_CASE_RUN_ID: String(correlation.caseRunId || ''),
    AGENT_INSIGHT_CONFIG_VERSION: String(payload.configVersion || ''),
    AGENT_INSIGHT_PLATFORM: platform,
  }
  const args = ['run', input]
  if (model) args.push('--model', model)
  const timeoutMs = Math.max(1, Number(payload.timeoutSeconds) || 600) * 1000

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: cfg.workspaceBase,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    fs.mkdirSync(cfg.workspaceBase, { recursive: true })
    let stderr = ''
    child.stderr.on('data', (c) => {
      stderr += String(c)
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // Agent 进程结束 ≠ Trace 已入库；这里只回报进程级结果。
      resolve({
        state: 'AGENT_EXITED',
        exitCode: code,
        stderr: stderr.slice(-2000) || undefined,
        finishedAt: new Date().toISOString(),
      })
    })
  })
}

// ---------------------------------------------------------------- reporting

let capabilitiesRevision = 0
// 进程启动时间做前缀：revision 只用于幂等去重，重启后必须换一批，
// 否则服务端会把首次上报当成重放而丢弃（表现为 platforms 一直是空）。
const REVISION_EPOCH = Date.now().toString(36)

async function reportCapabilities(cfg) {
  const capabilities = buildCapabilities(cfg)
  capabilitiesRevision += 1
  await api(cfg, 'PUT', '/api/reliability/client/v1/capabilities', {
    revision: `cap_${REVISION_EPOCH}_${capabilitiesRevision}`,
    hostname: os.hostname(),
    reportedIp: pickReportedIp(),
    os: process.platform,
    arch: process.arch,
    platforms: capabilities.platforms,
    actions: capabilities.actions,
    components: capabilities.components,
    faultInjection: capabilities.faultInjection,
  })
  log(
    `capabilities reported: platforms=${capabilities.platforms.map((p) => p.id).join(',') || 'none'} fi=${capabilities.faultInjection.ready}`,
  )
  return capabilities
}

const processStartedAt = new Date().toISOString()

async function sendHeartbeat(cfg) {
  await api(cfg, 'POST', '/api/reliability/client/v1/heartbeat', {
    agentVersion: AGENT_VERSION,
    status: 'healthy',
    service: {
      processStartedAt,
      supervisor: process.env.AGENT_INSIGHT_SUPERVISOR || null,
      watchdog: 'healthy',
      restartCount: Number(process.env.AGENT_INSIGHT_RESTART_COUNT || 0),
    },
    sentAt: new Date().toISOString(),
  })
  notifyWatchdog()
}

/**
 * 同一台机器再上报一份 FI Worker 心跳（workerId = clientId）。
 *
 * 实验页与注入页只读 FaultInjectionWorker，不写这张表客户端就等于不存在。
 * 与 FI 能力是否就绪无关——不就绪也要上报，页面据 ready/note 区分
 * 「没装」与「装了但缺 python3」。失败不抛：FI 可见性是附加能力，
 * 不能拖垮控制面心跳。
 */
async function sendFiHeartbeat(cfg) {
  try {
    await api(cfg, 'POST', '/api/fault-injection/worker/heartbeat', {
      workerId: cfg.clientId,
      hostname: os.hostname(),
      version: AGENT_VERSION,
      inventory: buildFiInventory(cfg),
      busySlots: fiBusy,
    })
  } catch (err) {
    logErr('fi heartbeat failed', err.message)
  }
}

/** systemd WatchdogSec：向 NOTIFY_SOCKET 发 WATCHDOG=1，无第三方依赖。 */
function notifyWatchdog() {
  const socketPath = process.env.NOTIFY_SOCKET
  if (!socketPath) return
  try {
    const dgram = require('dgram')
    const client = dgram.createSocket('unix_dgram')
    const addr = socketPath.startsWith('@') ? `\0${socketPath.slice(1)}` : socketPath
    client.send(Buffer.from('WATCHDOG=1'), addr, () => client.close())
  } catch {
    /* watchdog 通知失败不应影响主循环 */
  }
}

// ---------------------------------------------------------------- spool

function readSpool() {
  try {
    return JSON.parse(fs.readFileSync(SPOOL_PATH, 'utf8'))
  } catch {
    return []
  }
}

function writeSpool(entries) {
  fs.mkdirSync(CLIENT_HOME, { recursive: true })
  const tmp = `${SPOOL_PATH}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2))
  fs.renameSync(tmp, SPOOL_PATH)
}

/** 回执发送失败时落盘，网络恢复后重试。指令本身不补发，只补发回执。 */
function spoolReceipt(entry) {
  const entries = readSpool()
  entries.push({ ...entry, spooledAt: new Date().toISOString() })
  writeSpool(entries.slice(-500))
}

async function flushSpool(cfg) {
  const entries = readSpool()
  if (!entries.length) return
  const remaining = []
  for (const entry of entries) {
    try {
      await api(
        cfg,
        'POST',
        `/api/reliability/client/v1/commands/${encodeURIComponent(entry.commandId)}/status`,
        entry.body,
      )
    } catch (err) {
      // 410/404 表示指令已过期或不存在，丢弃即可，不必无限重试。
      if (err.status !== 404 && err.status !== 410) remaining.push(entry)
    }
  }
  writeSpool(remaining)
}

// ---------------------------------------------------------------- main loop

async function main() {
  const cfg = loadConfig()
  if (!cfg.insightBaseUrl || !cfg.clientId || !cfg.deviceCredential) {
    logErr('缺少 insightBaseUrl / clientId / deviceCredential，请先执行安装脚本完成注册')
    process.exit(1)
  }
  fs.mkdirSync(CLIENT_HOME, { recursive: true })
  log(`clientId=${cfg.clientId} host=${cfg.insightBaseUrl}`)

  await reportCapabilities(cfg).catch((err) => logErr('capabilities failed', err.message))

  const heartbeatAll = () => {
    sendHeartbeat(cfg).catch((err) => logErr('heartbeat failed', err.message))
    // FI 心跳节拍必须快于服务端的 online 判定窗口（workerOnlineMs ≤ 60s）。
    sendFiHeartbeat(cfg)
  }
  setInterval(heartbeatAll, HEARTBEAT_MS)
  heartbeatAll()

  setInterval(() => {
    flushSpool(cfg).catch(() => {})
  }, 15_000)

  fiLoop(cfg)
  controlLoop(cfg)
}

async function sendCommandStatus(cfg, commandId, status, extra = {}) {
  const body = {
    type: 'COMMAND_STATUS',
    commandId,
    status,
    occurredAt: new Date().toISOString(),
    ...extra,
  }
  try {
    await api(cfg, 'POST', `/api/reliability/client/v1/commands/${encodeURIComponent(commandId)}/status`, body)
  } catch (err) {
    if (err.status !== 404 && err.status !== 410) spoolReceipt({ commandId, body })
    throw err
  }
}

/** 已处理过的 commandId —— 同一指令不得重复执行。 */
const handledCommands = new Set()

async function handleCommand(cfg, frame, sendVia) {
  if (!frame?.commandId) return
  if (handledCommands.has(frame.commandId)) return
  handledCommands.add(frame.commandId)
  if (handledCommands.size > 1000) {
    for (const id of [...handledCommands].slice(0, 500)) handledCommands.delete(id)
  }

  const sendStatus = async (status, extra) => {
    try {
      await sendVia(frame.commandId, status, extra)
    } catch (err) {
      logErr(`status ${status} failed for ${frame.commandId}:`, err.message)
    }
  }

  // 先 ACK：服务端据此把指令从 SENT 推进到 RECEIVED。
  await sendStatus('RECEIVED', {})
  await executeAction(cfg, frame, sendStatus)
}

async function controlLoop(cfg) {
  let backoff = RECONNECT_BASE_MS
  for (;;) {
    let conn = null
    try {
      const wsUrl = controlUrls(cfg).websocketUrl
      conn = await connectWebSocket(wsUrl, {
        headers: {
          authorization: `Bearer ${cfg.deviceCredential}`,
          'x-agent-insight-client-id': cfg.clientId,
        },
      })
      log('control channel connected (wss)')
      backoff = RECONNECT_BASE_MS

      const sendVia = async (commandId, status, extra) => {
        const frame = {
          type: 'COMMAND_STATUS',
          commandId,
          status,
          occurredAt: new Date().toISOString(),
          ...extra,
        }
        if (!conn.send(JSON.stringify(frame))) {
          await sendCommandStatus(cfg, commandId, status, extra)
        }
      }

      await new Promise((resolve) => {
        // 服务端每 30s 发一次 ping；只要连接活着就会有帧到达。
        // 服务端进程被杀时可能不发 FIN（半开连接），OS 不会通知我们，
        // 光等 close 会永远挂住 —— 所以这里自己判活。
        let lastSeen = Date.now()
        const watchdog = setInterval(() => {
          if (Date.now() - lastSeen > LIVENESS_TIMEOUT_MS) {
            logErr('control channel silent; assuming dead and reconnecting')
            clearInterval(watchdog)
            try {
              conn.close(1001)
            } catch {
              /* ignore */
            }
            resolve()
          }
        }, LIVENESS_CHECK_MS)

        conn.on('message', (raw) => {
          lastSeen = Date.now()
          let frame
          try {
            frame = JSON.parse(raw)
          } catch {
            return
          }
          if (frame?.type !== 'COMMAND') return
          handleCommand(cfg, frame, sendVia).catch((err) => logErr('command failed', err.message))
        })
        conn.on('ping', () => {
          lastSeen = Date.now()
        })
        conn.on('close', () => {
          clearInterval(watchdog)
          resolve()
        })
      })
      log('control channel closed; reconnecting')
    } catch (err) {
      logErr(`control channel unavailable (${err.message}); falling back to long-poll`)
      // WSS 不可用时用长轮询兜底，直到下次重连成功。
      await pollOnce(cfg).catch(() => {})
    }
    await new Promise((r) => setTimeout(r, backoff))
    backoff = Math.min(RECONNECT_MAX_MS, backoff * 2)
  }
}

async function pollOnce(cfg) {
  const frame = await api(cfg, 'GET', '/api/reliability/client/v1/commands/next?waitSeconds=25')
  if (!frame) return
  await handleCommand(cfg, frame, (commandId, status, extra) =>
    sendCommandStatus(cfg, commandId, status, extra),
  )
}

/**
 * FI run 领取循环：可靠性 Case 持槽时不领，避免故障注入互相污染。
 *
 * FI 组件不可用时只跳过 claim，**不影响心跳** —— 心跳由 main 的
 * heartbeatAll 负责，机器照样出现在 Worker 列表里并标记 not ready。
 */
async function fiLoop(cfg) {
  const caps = buildCapabilities(cfg)
  if (!caps.faultInjection.ready) {
    log(`fault injection not ready (${caps.faultInjection.note || 'unknown'}); 仍上报心跳，仅不领取注入任务`)
    return
  }
  for (;;) {
    try {
      if (!reliabilitySlotHeld && fiBusy < cfg.maxParallelFi) {
        const claim = await api(cfg, 'POST', '/api/fault-injection/worker/claim', {
          workerId: cfg.clientId,
          limit: Math.max(0, cfg.maxParallelFi - fiBusy),
        })
        for (const cmd of claim?.commands || []) {
          if (cmd.type === 'stop' && cmd.runId) killRun(cmd.runId)
        }
        for (const run of claim?.runs || []) {
          fiBusy += 1
          void (async () => {
            try {
              const payload = await runCollector(cfg, run)
              await api(
                cfg,
                'POST',
                `/api/fault-injection/runs/${encodeURIComponent(run.runId)}/collect-result`,
                payload,
              )
              log(`fi run completed: ${run.runId}`)
            } catch (err) {
              logErr(`fi run failed ${run.runId}:`, err.message)
              await api(
                cfg,
                'POST',
                `/api/fault-injection/runs/${encodeURIComponent(run.runId)}/collect-result`,
                { error: err.message, interactions: [] },
              ).catch((uploadErr) => {
                // 别静默：上传失败会让 run 永远卡在 collecting，必须留下线索。
                logErr(`fi result upload failed ${run.runId}:`, uploadErr.message)
              })
            } finally {
              fiBusy = Math.max(0, fiBusy - 1)
            }
          })()
        }
      }
    } catch (err) {
      logErr('fi claim error', err.message)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

function shutdown() {
  for (const runId of activeChildren.keys()) killRun(runId)
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

module.exports = {
  controlUrls,
  rasRuntimeConfigPath,
  writeRasRuntimeConfig,
  resolveFiCwd,
  buildFiInventory,
  buildCapabilities,
  normalizeModelIds,
  buildCollectorArgs,
  readCollectResult,
  configTargetPath,
  atomicWriteJson,
  probeFaultInjection,
  WHITELIST,
  CONFIG_FORBIDDEN,
  RUN_FORBIDDEN,
}

if (require.main === module) {
  main().catch((err) => {
    logErr('fatal', err)
    process.exit(1)
  })
}

#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInferenceGateway } from './inference_gateway.mjs'
import { syncConfigFiles } from './inference_config.mjs'

const self = fileURLToPath(import.meta.url)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return fallback; throw error } }
function atomic(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tmp, content, { mode }); fs.renameSync(tmp, file)
}
function context(options = {}) {
  const env = options.env || process.env
  const homeDir = options.homeDir || env.HOME || os.homedir()
  const insightDir = options.insightDir || env.AGENT_INSIGHT_HOME || path.join(homeDir, '.agent-insight')
  return { ...options, env, homeDir, insightDir, root: path.join(insightDir, 'inference-proxy') }
}
function loadInstall(c) {
  const state = read(path.join(c.root, 'installation.json'), { enabled: false, agents: [], files: [], launchers: [] })
  return { ...state, enabled: state.explicitEnabled ?? state.enabled }
}
function saveInstall(c, value) {
  // Cached legacy plugins check only enabled; keep their automatic enrollment disabled.
  atomic(path.join(c.root, 'installation.json'), JSON.stringify({ ...value, explicitEnabled: value.enabled, enabled: false }))
}
function accountKey(c) {
  if (c.env.AGENT_INSIGHT_API_KEY !== undefined) return c.env.AGENT_INSIGHT_API_KEY
  let key = ''
  for (const name of ['.env', 'config']) {
    try {
      const line = fs.readFileSync(path.join(c.insightDir, name), 'utf8').split(/\r?\n/).find(line => /^AGENT_INSIGHT_API_KEY=/.test(line.trim()))
      if (line) key = line.trim().slice(line.trim().indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return key
}
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
async function locked(c, fn) {
  fs.mkdirSync(c.root, { recursive: true, mode: 0o700 })
  const lock = path.join(c.root, 'lock')
  const deadline = Date.now() + 20000
  while (true) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); fs.writeFileSync(path.join(lock, 'owner'), String(process.pid)); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner; try { owner = Number(fs.readFileSync(path.join(lock, 'owner'), 'utf8')) } catch {}
      if (owner && !alive(owner)) { fs.rmSync(lock, { recursive: true, force: true }); continue }
      if (!owner && Date.now() - fs.statSync(lock).mtimeMs > 20000) { fs.rmSync(lock, { recursive: true, force: true }); continue }
      if (Date.now() > deadline) throw new Error('Inference configuration is busy; retry shortly')
      await sleep(50)
    }
  }
  try { return await fn() } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}
function flagValues(args, name) {
  const values = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break
    if (args[i] === name) values.push(args[++i] ?? '')
    else if (args[i].startsWith(name + '=')) values.push(args[i].slice(name.length + 1))
  }
  return values
}
const flag = (args, name) => flagValues(args, name).at(-1)
export function discoverConfigFiles(options = {}) {
  const c = context(options), args = c.args || [], files = []
  const add = (agent, file) => files.push({ agent, file: path.resolve(file) })
  const agents = c.agents || ['opencode', 'qoder']
  const cwd = path.resolve(c.cwd || process.cwd())
  if (agents.includes('opencode')) {
    for (const dir of [path.join(c.env.XDG_CONFIG_HOME || path.join(c.homeDir, '.config'), 'opencode'), c.env.OPENCODE_CONFIG_DIR].filter(Boolean)) {
      for (const name of ['config.json', 'opencode.json', 'opencode.jsonc']) add('opencode', path.join(dir, name))
    }
    if (c.env.OPENCODE_CONFIG) add('opencode', path.resolve(cwd, c.env.OPENCODE_CONFIG))
    if (!['1', 'true'].includes(c.env.OPENCODE_DISABLE_PROJECT_CONFIG)) {
      let dir = cwd
      while (true) {
        for (const name of ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']) add('opencode', path.join(dir, name))
        if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) break
        dir = path.dirname(dir)
      }
    }
  }
  if (agents.includes('qoder')) {
    const project = path.resolve(cwd, flag(args, '--cwd') || flag(args, '-w') || '.')
    const configuredSources = flagValues(args, '--setting-sources')
    const sources = (configuredSources.length ? configuredSources : ['user,project,local']).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean)
    if (sources.some(value => !['user', 'project', 'local'].includes(value))) throw new Error('Unsupported Qoder setting source')
    const configRoots = flagValues(args, '--config-dir')
    if (sources.includes('user')) for (const dir of configRoots.length ? configRoots : [c.env.QODERCN_CONFIG_DIR || path.join(c.homeDir, '.qoder-cn')]) add('qoder', path.join(path.resolve(cwd, dir), 'settings.json'))
    if (sources.includes('project')) add('qoder', path.join(project, '.qoder/settings.json'))
    if (sources.includes('local')) add('qoder', path.join(project, '.qoder/settings.local.json'))
    for (const settings of flagValues(args, '--settings')) if (settings && !settings.trim().startsWith('{')) add('qoder', path.resolve(cwd, settings))
  }
  return files.filter((entry, i) => files.findIndex(f => f.file === entry.file && f.agent === entry.agent) === i)
}
async function healthy(c) {
  const runtime = read(path.join(c.root, 'runtime.json'), undefined)
  if (!runtime) return undefined
  try {
    const response = await fetch(runtime.origin + '/_agent_insight/health', { headers: { 'x-agent-insight-control': runtime.token }, signal: AbortSignal.timeout(700) })
    const value = await response.json()
    if (response.ok && value.instance === runtime.token) return runtime
  } catch {}
}
async function ensureDaemon(c, installation) {
  const existing = await healthy(c)
  const accountHash = hash(accountKey(c) || 'anonymous').slice(0, 16)
  if (existing && existing.accountHash === accountHash && existing.runtimePath === self && existing.policy === 'explicit-v1') return existing
  if (existing) await stopDaemon(c)
  const log = fs.openSync(path.join(c.root, 'daemon.log'), 'a', 0o600)
  const child = spawn(installation.nodePath || process.execPath, [self, 'daemon', c.insightDir], {
    env: { ...c.env, AGENT_INSIGHT_API_KEY: accountKey(c), AGENT_INSIGHT_HOME: c.insightDir, HOME: c.homeDir }, detached: true, stdio: ['ignore', log, log],
  })
  fs.closeSync(log)
  let startError; child.once('error', error => { startError = error }); child.once('exit', code => { startError = new Error(`Inference proxy exited before becoming healthy (${code})`) }); child.unref()
  for (let i = 0; i < 100; i++) { await sleep(50); const runtime = await healthy(c); if (runtime) return runtime; if (startError) throw startError }
  throw new Error('Inference proxy did not become healthy; Agent configuration was not changed')
}
function mergeFiles(...groups) {
  return [...new Map(groups.flat().map(f => {
    let identity = path.resolve(f.file)
    try { identity = fs.realpathSync(identity) } catch (error) { if (error.code !== 'ENOENT') throw error }
    return [`${f.agent}:${identity}`, f]
  })).values()]
}
function syncKnown(c, install, origin, extra = []) {
  const files = mergeFiles((install.files || []).filter(item => install.agents.includes(item.agent)), discoverConfigFiles({ ...c, agents: install.agents }), extra)
  const result = syncConfigFiles({ insightDir: c.insightDir, origin, files, env: c.env, onBackup: c.onBackup })
  const persistent = result.managed.filter(item => !['resolved', 'inline'].includes(path.relative(fs.realpathSync(c.root), item.file).split(path.sep)[0]))
  install.coverage = install.agents.flatMap(agent => {
    const managedEndpoints = persistent.filter(item => item.agent === agent).length
    const coverage = [{ agent, product: 'cli', state: managedEndpoints ? 'configured' : 'no_supported_endpoint', managedEndpoints }]
    if (agent === 'qoder') for (const product of ['desktop', 'jetbrains']) coverage.push({ agent, product, state: 'adapter_unavailable', managedEndpoints: 0 })
    return coverage
  })
  const saved = loadInstall(c)
  install.files = mergeFiles(saved.files || [], files)
  saveInstall(c, { ...install, agents: [...new Set([...(saved.agents || []), ...install.agents])] })
  return { ...result, coverage: install.coverage }
}
export async function prepareProxy(options = {}) {
  const c = context(options)
  return locked(c, async () => {
    const install = loadInstall(c)
    install.nodePath = c.nodePath || install.nodePath || process.execPath
    saveInstall(c, install)
    for (const item of install.launchers || []) {
      if (!fs.existsSync(item.path) || fs.lstatSync(item.path).isSymbolicLink()) continue
      const code = `#!${install.nodePath || process.execPath}\nimport(${JSON.stringify(pathToFileURL(self).href)}).then(m=>m.launchQoder(${JSON.stringify(c.insightDir)},${JSON.stringify(item.path)},process.argv.slice(2))).catch(e=>{console.error('Agent Insight: '+e.message);process.exitCode=1})\n`
      if (hash(fs.readFileSync(item.path)) !== item.managedHash) throw new Error(`Previously managed Qoder launcher was edited; update it manually before retrying: ${item.path}`)
      if (hash(code) === item.managedHash) continue
      const backup = path.join(c.root, 'legacy-launchers', hash(fs.readFileSync(item.path)))
      if (!fs.existsSync(backup)) atomic(backup, fs.readFileSync(item.path))
      atomic(item.path, code, 0o755)
      item.managedHash = hash(code)
      saveInstall(c, install)
    }
    // Replace older polling runtimes without touching model configuration files or enrolling new endpoints.
    if (install.enabled) await ensureDaemon(c, install)
    return { prepared: true, enabled: install.enabled }
  })
}
export async function installProxy(options = {}) {
  const c = context(options)
  process.stderr.write('显式配置模型转发：先备份配置，再登记上游并改写模型地址。新增 Provider 或修改上游后请重新执行此命令。\n')
  return locked(c, async () => {
    const before = loadInstall(c)
    const install = { ...before, enabled: true, nodePath: c.nodePath || before.nodePath || process.execPath, homeDir: c.homeDir, agents: [...new Set([...before.agents, ...(c.agents || ['opencode'])])] }
    saveInstall(c, install)
    const runtime = await ensureDaemon(c, install)
    const result = syncKnown(c, { ...install, agents: c.agents || ['opencode'] }, runtime.origin, c.files || [])
    return { ...result, origin: runtime.origin, launchers: install.launchers.map(x => x.path) }
  })
}
export async function syncProxy(options = {}) {
  return installProxy(options)
}
export function isManagedOpenCodeEndpoint(address, options = {}) {
  if (typeof address !== 'string') return false
  const c = context(options)
  const state = read(path.join(c.root, 'config-state.json'), {})
  return Object.values(state.files || {}).some(file => file.agent === 'opencode' && Object.values(file.fields || {}).some(field =>
    [field, ...(field.aliases || [])].some(record => address === record.managed || address.startsWith(record.managed + '/'))))
}
export async function prepareOpenCodeConfig(cfg, options = {}) {
  const c = context(options), install = loadInstall(c)
  if (!install.enabled || !install.agents.includes('opencode')) return
  const providers = [...Object.values(cfg.provider || {}).map(p => p.options), ...Object.values(cfg.providers || {}).map(p => p.settings)]
  if (providers.some(p => isManagedOpenCodeEndpoint(p?.baseURL, c))) await locked(c, () => ensureDaemon(c, install))
}
export async function prepareOpenCodeRequest(address, options = {}) {
  const c = context(options), install = loadInstall(c)
  if (install.enabled && install.agents.includes('opencode') && isManagedOpenCodeEndpoint(address, c)) await locked(c, () => ensureDaemon(c, install))
  return address
}
async function stopDaemon(c) {
  const runtime = await healthy(c)
  if (runtime) {
    await fetch(runtime.origin + '/_agent_insight/stop', { method: 'POST', headers: { 'x-agent-insight-control': runtime.token }, signal: AbortSignal.timeout(2000) }).then(r => r.text())
    for (let i = 0; i < 40; i++) { if (!await healthy(c)) return; await sleep(25) }
    throw new Error('Inference proxy has not stopped; retry installation')
  }
}
export async function launchQoder(insightDir, entry, args) {
  const c = context({ insightDir, args })
  const install = loadInstall(c)
  const launcher = install.launchers.find(item => item.path === entry)
  if (!launcher) throw new Error('Managed Qoder launcher is missing its original executable')
  await prepareProxy(c)
  const child = spawn(launcher.original, args, { stdio: 'inherit', env: { ...process.env, AGENT_INSIGHT_HOME: insightDir } })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  child.once('error', error => { process.stderr.write(`Qoder launch failed: ${error.message}\n`); process.exitCode = 1 })
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1) })
}
async function daemon(insightDir) {
  const c = context({ insightDir }), token = crypto.randomUUID()
  const gateway = createInferenceGateway({ routes: [] }, { insightDir, getRoutes: () => read(path.join(c.root, 'config-state.json'), {}).routes || [] })
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/_agent_insight/')) {
      if (req.headers['x-agent-insight-control'] !== token) { res.writeHead(403); res.end(); return }
      if (req.method === 'GET' && req.url === '/_agent_insight/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ instance: token })); return }
      if (req.method === 'POST' && req.url === '/_agent_insight/stop') { res.end('{}'); setTimeout(stop, 20); return }
      res.writeHead(404); res.end(); return
    }
    gateway.emit('request', req, res)
  })
  const stop = () => { server.close(); server.closeAllConnections() }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  const previous = read(path.join(c.root, 'runtime.json'), undefined)
  const port = previous ? Number(new URL(previous.origin).port) : 0
  let runtime
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
    runtime = { origin: `http://127.0.0.1:${server.address().port}`, pid: process.pid, token, accountHash: hash(accountKey(c) || 'anonymous').slice(0, 16), runtimePath: self, policy: 'explicit-v1' }
    atomic(path.join(c.root, 'runtime.json'), JSON.stringify(runtime))
  } catch (error) { stop(); throw error }
}
let isMain = false
try { isMain = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === self } catch {}
if (isMain) {
  const [command, insightDir, agents, ...args] = process.argv.slice(2)
  const options = { insightDir, nodePath: process.execPath, agents: (agents || 'opencode').split(','), args, onBackup: item => {
    process.stderr.write(`配置：${item.file}\n首次原件：${item.original}\n最新原始地址备份：${item.latest}\n`)
  } }
  if (options.agents.some(agent => !['opencode', 'qoder'].includes(agent))) { process.stderr.write('Unsupported Agent; choose opencode or qoder\n'); process.exitCode = 1 }
  else try {
    const action = { prepare: prepareProxy, configure: installProxy, install: installProxy, sync: syncProxy, status: async o => ({ ...loadInstall(context(o)), healthy: Boolean(await healthy(context(o))) }) }[command]
    if (command === 'daemon') await daemon(insightDir)
    else if (action) {
      const result = await action(options)
      process.stdout.write(JSON.stringify(result) + '\n')
      if (['configure', 'install', 'sync'].includes(command)) for (const item of result.coverage || []) {
        if (item.state === 'adapter_unavailable') continue
        process.stderr.write(`${item.agent} CLI：持久配置中 ${item.managedEndpoints} 个模型地址已配置转发（不含运行时快照）；实际请求与 Trace 关联需单独验证。\n`)
      }
      if (['configure', 'install', 'sync'].includes(command) && result.coverage?.some(item => item.agent === 'qoder')) {
        process.stderr.write('Qoder 原生 IDE / JetBrains：模型地址未接管；采集组件安装不代表统一调用 ID 关联已启用。\n')
      }
    }
    else throw new Error('Usage: inference_proxy.mjs prepare|configure|status <insight-directory> [opencode,qoder] [Qoder settings flags]')
  } catch (error) { process.stderr.write(`Agent Insight inference proxy: ${error.message}\n`); process.exitCode = 1 }
}

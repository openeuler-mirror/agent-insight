'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { once } = require('node:events')
const { installationRoot, readState, readRelease, repository } = require('./installation.cjs')
const { artifactIdentity } = require('./artifact-identity.cjs')

async function atomicJson(file, value) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await fsp.rename(temporary, file)
  } finally { await fsp.rm(temporary, { force: true }).catch(() => {}) }
}

async function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const child = spawn(file, args, { cwd: options.cwd, env: options.env || process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    let aborted = false
    const kill = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch {}
    }
    const abort = () => { aborted = true; kill() }
    const timer = setTimeout(abort, options.timeoutMs || 45 * 60 * 1000)
    options.signal?.addEventListener('abort', abort, { once: true })
    const dispose = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); if (options.verbose) process.stderr.write(chunk) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); if (options.verbose) process.stderr.write(chunk) })
    child.once('error', cause => { dispose(); reject(new Error(`无法执行 ${file}：${cause.message}`)) })
    child.once('close', code => {
      dispose()
      if (aborted) reject(new Error(`${file} 已取消或执行超时`))
      else if (code !== 0) reject(new Error(`${file} 执行失败 (${code})：${stderr.slice(-4000)}`))
      else resolve(stdout.trim())
    })
  })
}

function checkSource(source) {
  const read = file => fs.readFileSync(path.join(source, file), 'utf8')
  const main = read('apps/server/src/main.rs')
  const routes = read('apps/server/src/httpserver/session.rs')
  const worker = read('crates/protocol/runtime/src/worker.rs')
  if (!main.includes('XGOVERNOR_TENANT_BIND_ADDR') || !main.includes('--worker') || !main.includes('DockerProvider')
    || !['/sessions/open', '/sessions/exec', '/sessions/turns', '/sessions/close', '/sessions/cancel', '/turns/:turn_id/events'].every(route => routes.includes(route))
    || !worker.includes('RuntimeStateSnapshot')) throw new Error('上游源码不满足当前适配器的协议布局；需要更新适配器，旧版本保持不变')
  for (const file of ['Cargo.lock', 'apps/runtime-pi/extension/package-lock.json']) fs.accessSync(path.join(source, file))
  const pkg = JSON.parse(read('apps/runtime-pi/extension/package.json'))
  const piVersion = pkg.devDependencies?.['@earendil-works/pi-coding-agent']
  if (!/^\d+\.\d+\.\d+$/.test(piVersion) || !pkg.pi?.extensions?.includes('./index.ts')) throw new Error('上游 Pi 依赖或桥接扩展布局不兼容')
  return { pi: piVersion, extension: pkg.version }
}

async function freePort() {
  const socket = net.createServer()
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const result = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return result
}

async function probeServer(directory, config, signal, sourceEnv = process.env) {
  const probe = path.join(directory, '.probe')
  await fsp.mkdir(probe, { mode: 0o700 })
  const token = randomBytes(32).toString('hex')
  await fsp.writeFile(path.join(probe, 'tenants.toml'), `[admin]\ntokens = ["${token}"]\n`, { mode: 0o600 })
  const admin = await freePort()
  let tenant = await freePort()
  while (tenant === admin) tenant = await freePort()
  const env = Object.fromEntries(Object.entries(sourceEnv).filter(([key]) => !key.startsWith('XGOVERNOR_') && key !== 'E2B_API_KEY'))
  Object.assign(env, {
    XGOVERNOR_DATA_DIR: path.join(probe, 'state'), XGOVERNOR_TENANTS_CONFIG_PATH: path.join(probe, 'tenants.toml'),
    XGOVERNOR_BIND_ADDR: `127.0.0.1:${admin}`, XGOVERNOR_TENANT_BIND_ADDR: `127.0.0.1:${tenant}`,
    XGOVERNOR_DOCKER_DEPLOYMENT: `insight-update-${randomBytes(12).toString('hex')}`,
    XGOVERNOR_PI_WORKER: config.runtimes['pi-agent'].workerExecutable, XGOVERNOR_PI_EXECUTABLE: config.runtimes['pi-agent'].executable,
    XGOVERNOR_XIAOO_WORKER: config.serverExecutable,
  })
  const log = await fsp.open(path.join(probe, 'server.log'), 'w', 0o600)
  const child = spawn(config.serverExecutable, [], { cwd: probe, env, stdio: ['ignore', log.fd, log.fd] })
  let spawnError
  child.on('error', cause => { spawnError = cause })
  const exited = once(child, 'close').catch(() => {})
  try {
    const base = `http://127.0.0.1:${admin}/api/v1`
    const request = (route, auth = true, body) => fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500),
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const deadline = Date.now() + 20000
    while (true) {
      signal?.throwIfAborted()
      if (spawnError || child.exitCode !== null || child.signalCode) throw new Error(`新 server 无法启动${spawnError ? `：${spawnError.message}` : ` (${child.exitCode})`}`)
      try {
        const health = await request('/health')
        if (health.ok && (await health.json()).status === 'ok') break
      } catch {}
      if (Date.now() >= deadline) throw new Error('新 server 健康检查超时')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    const unauthorized = await request('/sessions', false)
    await unauthorized.body?.cancel()
    if (unauthorized.status !== 401) throw new Error('新 server 未兑现会话鉴权要求')
    const sessions = await request('/sessions')
    if (!sessions.ok) throw new Error('新 server 会话协议不兼容')
    await sessions.json()
    for (const route of ['/sessions/open', '/sessions/exec', '/sessions/turns', '/sessions/close', '/sessions/cancel']) {
      const response = await request(route, true, [])
      await response.body?.cancel()
      if (![400, 422].includes(response.status)) throw new Error(`新 server ${route} 协议不兼容`)
    }
  } catch (cause) {
    const logText = await fsp.readFile(path.join(probe, 'server.log'), 'utf8').catch(() => '')
    throw new Error(`${cause.message}${logText ? `\n${logText.slice(-4000)}` : ''}`)
  } finally {
    if (child.exitCode === null && !child.signalCode && !spawnError) child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
    await log.close()
    await fsp.rm(probe, { recursive: true, force: true })
  }
}

class DependencyManager {
  constructor(options = {}) {
    this.root = options.root || installationRoot()
    this.target = options.target || { platform: process.platform, arch: process.arch }
    this.run = options.command || command
    this.probe = options.probe || probeServer
    this.env = options.env || process.env
    this.signal = options.signal
    this.log = options.log || (message => console.log(`[xgovernor] ${message}`))
  }
  async locked(action) {
    await fsp.mkdir(this.root, { recursive: true, mode: 0o700 })
    const lock = path.join(this.root, 'update.lock')
    let descriptor
    try { descriptor = await fsp.open(lock, 'wx', 0o600) } catch (cause) {
      if (cause.code === 'EEXIST') throw new Error(`已有更新或回退操作占用 ${lock}；若进程异常终止，请确认进程已退出后清理此锁文件`)
      throw cause
    }
    try { await descriptor.writeFile(String(process.pid)); return await action() }
    finally { await descriptor.close(); await fsp.rm(lock, { force: true }) }
  }
  async update(version) {
    if (version !== undefined && (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(version) || version.includes('..'))) throw new Error('--version 需为 tag 或 commit')
    if (this.target.platform !== 'linux' || !['x64', 'arm64'].includes(this.target.arch)) throw new Error('xGovernor 本地 Docker 安装仅支持 Linux x64/arm64；请在执行机运行此命令')
    return this.locked(async () => {
      const previous = readState(this.root)
      const stage = path.join(this.root, `.staging-${randomBytes(8).toString('hex')}`)
      let release
      let activated = false
      await fsp.mkdir(path.join(stage, 'source'), { recursive: true, mode: 0o700 })
      const source = path.join(stage, 'source')
      const run = (file, args, cwd = source, verbose = false) => this.run(file, args, {
        cwd, verbose, signal: this.signal, timeoutMs: file === 'git' ? 180000 : undefined,
        env: { ...this.env, GIT_TERMINAL_PROMPT: '0', CARGO_TARGET_DIR: path.join(source, 'target'), CARGO_BUILD_JOBS: '2' },
      })
      try {
        this.log('检查 Git、Cargo 和 npm；从官方仓库解析目标版本')
        for (const tool of ['git', 'cargo', 'npm']) await run(tool, ['--version'])
        if (!require('./toolchain.cjs').nodeSupported(await run('node', ['--version']))) throw new Error('构建 Pi 桥接扩展需要 Node.js >=22.19；请重新执行客户端安装命令')
        await run('git', ['init', '--quiet'])
        await run('git', ['remote', 'add', 'origin', repository])
        await run('git', ['fetch', '--depth=1', 'origin', version || 'HEAD'], source, true)
        await run('git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD'])
        const revision = (await run('git', ['rev-parse', 'HEAD'])).trim()
        if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('官方仓库未返回有效 commit')
        if (previous) {
          try {
            const current = readRelease(this.root, previous.current, this.target)
            if (current.manifest.revision === revision) { this.log(`已是目标版本 ${revision}`); return { changed: false, ...current.manifest } }
          } catch (cause) { this.log(`当前安装需要修复：${cause.message}`) }
        }
        const components = checkSource(source)
        this.log(`构建 ${revision} 的 server、Pi worker；首次构建可能较慢`)
        await run('cargo', ['build', '--locked', '--release', '-p', 'xgovernor-server', '-p', 'xgovernor-runtime-pi', '--bin', 'xgovernor-server', '--bin', 'pi-worker'], source, true)
        this.log(`安装上游锁定的 Pi ${components.pi} 及桥接扩展依赖`)
        const extension = path.join(source, 'apps/runtime-pi/extension')
        await run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], extension, true)
        await run('npm', ['run', 'typecheck'], extension, true)
        const installedPi = JSON.parse(await fsp.readFile(path.join(extension, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'))
        if (installedPi.version !== components.pi) throw new Error('Pi 实际安装版本与上游锁定版本不一致')
        const id = `${revision}-${randomBytes(8).toString('hex')}`
        release = path.join(this.root, 'releases', id)
        await fsp.mkdir(path.dirname(release), { recursive: true })
        await fsp.rename(stage, release)
        const artifacts = {
          server: 'source/target/release/xgovernor-server', piWorker: 'source/target/release/pi-worker',
          pi: 'source/apps/runtime-pi/extension/node_modules/.bin/pi', extension: 'source/apps/runtime-pi/extension',
        }
        const config = { serverExecutable: path.join(release, artifacts.server), runtimes: {
          'pi-agent': { kind: 'pi', workerExecutable: path.join(release, artifacts.piWorker), executable: path.join(release, artifacts.pi), extensionDirectory: path.join(release, artifacts.extension) },
          xiaoo: { kind: 'xiaoo', workerExecutable: path.join(release, artifacts.server) },
        } }
        const identity = artifactIdentity(config)
        if (identity.reasons.length) throw new Error(identity.reasons.join('；'))
        this.log('检查新 server 启动、鉴权及会话接口；不调用模型、不创建任务容器')
        await this.probe(release, config, this.signal, this.env)
        const manifest = { schemaVersion: 1, repository, revision, requestedVersion: version || 'HEAD', installedAt: new Date().toISOString(),
          ...this.target, artifacts, components, artifactDigest: identity.digest,
          compatibility: { contract: 'agent-insight-xgovernor/v1', checks: ['source-layout', 'extension-typecheck', 'server-health-auth-routes'] },
        }
        await atomicJson(path.join(release, 'installation.json'), manifest)
        readRelease(this.root, id, this.target)
        this.signal?.throwIfAborted()
        await atomicJson(path.join(this.root, 'current.json'), { schemaVersion: 1, current: id, previous: previous?.current || null })
        activated = true
        this.log(`已切换到 ${revision}；受管理 Profile 将在下一次能力上报时刷新摘要，运行中的 Case 继续使用原版本`)
        this.log('已有手动 server/worker/CLI/扩展路径的 Profile 不会被接管；使用受管理安装前请移除这些路径配置')
        return { changed: true, ...manifest }
      } finally {
        await fsp.rm(stage, { recursive: true, force: true })
        if (release && !activated) await fsp.rm(release, { recursive: true, force: true })
      }
    })
  }
  status() {
    const state = readState(this.root)
    if (!state) return { installed: false, root: this.root }
    const installed = readRelease(this.root, state.current, this.target)
    return { installed: true, root: this.root, directory: installed.directory, previous: state.previous, ...installed.manifest }
  }
  async rollback() {
    return this.locked(async () => {
      const state = readState(this.root)
      if (!state?.previous) throw new Error('没有可回退的已安装版本')
      const previous = readRelease(this.root, state.previous, this.target)
      await this.probe(previous.directory, previous.config, this.signal, this.env)
      this.signal?.throwIfAborted()
      await atomicJson(path.join(this.root, 'current.json'), { schemaVersion: 1, current: state.previous, previous: state.current })
      this.log(`已回退到 ${previous.manifest.revision}；运行中的 Case 保持原版本`)
      return previous.manifest
    })
  }
}

module.exports = { DependencyManager, atomicJson, checkSource, probeServer, command }

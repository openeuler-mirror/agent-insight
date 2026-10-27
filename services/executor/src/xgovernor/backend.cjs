'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { randomBytes } = require('node:crypto')
const { spawn } = require('node:child_process')
const { XGovernorClient, error } = require('./client.cjs')
const { exportTrace, resumeUpload, liveTraceReporter } = require('./trace.cjs')
const { describeProfile, validateExecution, bindingFor, executionCapabilities } = require('../execution-config.cjs')
const { artifactIdentity } = require('./artifact-identity.cjs')
const { resolveModel } = require('./model-resolver.cjs')
const { installationRoot } = require('./installation.cjs')
const { toolchainEnvironment } = require('./toolchain.cjs')
const { prepareExecutionImage } = require('../execution-images.cjs')
const { prepareExecutionWorkspace } = require('../execution-workspace.cjs')
const { commandFailure } = require('./command-diagnostics.cjs')

async function port() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}
async function identity(pid) {
  try { return (await fsp.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19] } catch { return null }
}

class XGovernorExecutionBackend {
  constructor(options) {
    this.options = options
    this.config = options.config
    this.root = path.join(options.baseDir, 'xgovernor-runs')
    this.processRunner = options.processRunner
    this.processes = new Map()
    this.reservations = new Map()
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const opaque = JSON.parse(fs.readFileSync(path.join(this.root, entry.name, 'lease.json'), 'utf8'))
        if (!opaque.closed) this.reservations.set(entry.name, opaque.resources || null)
        const profile = opaque.executionConfig || this.config.profiles[opaque.profileKey]
        if (profile && opaque.directory === path.join(this.root, entry.name)) resumeUpload({ opaque }, profile, options.insightBaseUrl)
      } catch { this.reservations.set(entry.name, null) }
    }
  }
  profile(task) {
    const spec = validateExecution(task.execution)
    const config = this.options.configProvider?.() || this.config
    const binding = bindingFor(config.bindings, task.benchmark.key, task.agentConfig.platform)
    const local = config.profiles[spec.profile.key]
    if (!binding || binding.profile !== spec.profile.key || !local || describeProfile(binding.profile, local).definitionDigest !== spec.profile.definitionDigest) throw error('EXECUTION_PROFILE_CHANGED', '冻结执行环境与本机配置不一致')
    const runtime = local.runtimes[task.agentConfig.platform]
    if (!runtime?.agents.includes(task.agentConfig.agent) || task.agentConfig.agentOptions) throw error('AGENT_OPTIONS_INVALID', 'Runtime 不支持所选 Agent 或参数')
    if (task.policy.network !== 'deny' || spec.profile.sandbox !== 'docker') throw error('POLICY_UNSUPPORTED', '执行环境要求未被兑现')
    return { local, runtime, spec, config }
  }
  validate(task) {
    const result = this.profile(task)
    const capability = (this.options.probe || executionCapabilities)({ config: result.config }).profiles.find(item => item.profile.key === task.execution.profile.key)
    const readiness = capability?.targetReadiness?.[task.agentConfig.platform] || capability
    if (!readiness?.ready) throw error('EXECUTOR_CAPABILITY_MISSING', readiness?.note || '执行环境未就绪')
    if (!this.reservations.has(task.context.runId)) {
      const usage = [...this.reservations.values()]
      if (usage.some(resources => !resources)
        || usage.reduce((sum, resources) => sum + resources.cpu, result.local.resources.cpu) > os.availableParallelism()
        || usage.reduce((sum, resources) => sum + resources.memoryMiB, result.local.resources.memoryMiB) > os.totalmem() / 1024 ** 2) {
        throw Object.assign(error('SERVICE_BUSY', 'Docker 执行预算不足或尚有资源待清理'), { status: 409, retryable: true })
      }
    }
    return result
  }
  assertFrozen(local, platform) {
    if (!local.artifactDigest) return
    const identity = artifactIdentity(local)
    const selected = platform ? artifactIdentity({ ...local, runtimes: { [platform]: local.runtimes[platform] } }) : identity
    if (selected.reasons.length || identity.digest !== local.artifactDigest) throw error('EXECUTION_PROFILE_CHANGED', '本次执行绑定的制品发生变化')
  }
  assertHandle(handle) {
    if (handle.backendKey !== 'xgovernor' || !/^[A-Za-z0-9_-]{1,160}$/.test(handle.runId) || handle.opaque.directory !== path.join(this.root, handle.runId)) throw error('EXECUTION_HANDLE_INVALID', '执行句柄 ownership 不匹配')
  }
  async persist(handle, context) {
    this.assertHandle(handle)
    await this.options.atomicWriteJson(path.join(handle.opaque.directory, 'lease.json'), handle.opaque)
    await context.persist(handle)
  }
  async client(handle) {
    this.assertHandle(handle)
    const auth = (await fsp.readFile(path.join(handle.opaque.directory, 'admin.auth'), 'utf8')).trim()
    return new XGovernorClient(`http://127.0.0.1:${handle.opaque.adminPort}`, auth, this.options.fetchImpl)
  }
  docker(local, args, signal, timeoutMs = 30000, options = {}) {
    return this.processRunner(local.dockerExecutable, ['--host', `unix://${local.dockerSocket}`, ...args], { ...options, signal, timeoutMs, maxOutputBytes: 20 * 1024 * 1024 })
  }
  async prepare(task, context) {
    const { local, runtime, spec } = this.validate(task)
    const resolved = await (this.options.resolveModel || resolveModel)(task, runtime, local, { signal: context.signal })
    this.reservations.set(context.runId, local.resources)
    const directory = path.join(this.root, context.runId)
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 }).catch(cause => { this.reservations.delete(context.runId); throw cause })
    const handle = { backendKey: 'xgovernor', schemaVersion: 1, runId: context.runId, opaque: {
      directory, profileKey: spec.profile.key, profile: spec.profile, deployment: `insight-${randomBytes(16).toString('hex')}`, runtimeId: `insight-${randomBytes(16).toString('hex')}`,
      platform: task.agentConfig.platform, resources: local.resources, startedAt: Date.now(), closed: false,
      cleanupConfig: { dockerExecutable: local.dockerExecutable, dockerSocket: local.dockerSocket, serverExecutable: local.serverExecutable, timeouts: local.timeouts },
      executionConfig: local,
    } }
    await this.persist(handle, context)
    const { image, resolution } = await prepareExecutionImage(task, {
      workDir: directory, signal: context.signal,
      docker: (args, options = {}) => this.docker(local, args, options.signal, local.timeouts.prepareSeconds * 1000, options),
    })
    if (image.Architecture !== spec.environment.arch || image.Os !== 'linux' || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw error('EXECUTION_IMAGE_INVALID', '镜像架构或不可变身份不匹配')
    handle.opaque.imageId = image.Id
    if (resolution) handle.opaque.imageResolution = resolution
    await this.persist(handle, context)
    const adminPort = await port()
    let tenantPort = await port()
    while (tenantPort === adminPort) tenantPort = await port()
    Object.assign(handle.opaque, { adminPort, tenantPort, workspaceRoot: spec.environment.workspaceRoot, datasetRevision: task.workspace.revision })
    const auth = randomBytes(32).toString('hex')
    await fsp.writeFile(path.join(directory, 'admin.auth'), auth, { mode: 0o600, flag: 'wx' })
    await fsp.writeFile(path.join(directory, 'tenants.toml'), `[admin]\ntokens = ["${auth}"]\n\n[[tenant]]\ntenant_id = "case"\ntokens = ["${randomBytes(32).toString('hex')}"]\n`, { mode: 0o600, flag: 'wx' })
    const inherited = toolchainEnvironment(installationRoot(), process.env)
    const environment = Object.fromEntries(Object.entries(inherited).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'].includes(key)))
    for (const key of Object.keys(environment)) if (key.startsWith('XGOVERNOR_') || key === 'E2B_API_KEY') delete environment[key]
    for (const model of Object.values(local.models)) delete environment[model.apiKeyEnv]
    environment[resolved.model.apiKeyEnv] = resolved.credential
    Object.assign(environment, {
      XGOVERNOR_DATA_DIR: path.join(directory, 'state'), XGOVERNOR_TENANTS_CONFIG_PATH: path.join(directory, 'tenants.toml'),
      XGOVERNOR_BIND_ADDR: `127.0.0.1:${adminPort}`, XGOVERNOR_TENANT_BIND_ADDR: `127.0.0.1:${tenantPort}`,
      XGOVERNOR_DEFAULT_WORKSPACE_ROOT: spec.environment.workspaceRoot, XGOVERNOR_DOCKER_ENABLED: '1',
      XGOVERNOR_DOCKER_CLI: local.dockerExecutable, XGOVERNOR_DOCKER_SOCKET: local.dockerSocket,
      XGOVERNOR_DOCKER_IMAGE: image.Id, XGOVERNOR_DOCKER_DEPLOYMENT: handle.opaque.deployment,
      XGOVERNOR_DOCKER_CPUS: String(local.resources.cpu), XGOVERNOR_DOCKER_MEMORY_MB: String(local.resources.memoryMiB), XGOVERNOR_DOCKER_PIDS: String(local.resources.pids),
      XGOVERNOR_DOCKER_DISK_BYTES: String(8 * 1024 ** 3), XGOVERNOR_DOCKER_OUTPUT_BYTES: String(16 * 1024 ** 2),
      XGOVERNOR_ORPHAN_THRESHOLD_SECS: String(task.agentConfig.timeoutSeconds + local.timeouts.prepareSeconds + 1800),
      PI_OFFLINE: '1', PI_TELEMETRY: '0',
    })
    const workerEnvironment = runtime.workerEnvironment || { pi: 'XGOVERNOR_PI_WORKER', xiaoo: 'XGOVERNOR_XIAOO_WORKER' }[runtime.kind]
    if (workerEnvironment) environment[workerEnvironment] = runtime.workerExecutable
    if (runtime.executable && runtime.kind === 'pi') environment.XGOVERNOR_PI_EXECUTABLE = runtime.executable
    if (runtime.kind === 'xiaoo' && !runtime.traceExporter) {
      const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`
      const wrapper = path.join(directory, 'xiaoo-worker')
      await fsp.writeFile(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(__dirname, 'capture-worker.cjs'))} ${quote(runtime.workerExecutable)} ${quote(path.join(directory, 'worker-state.json'))} "$@"\n`, { mode: 0o700, flag: 'wx' })
      environment.XGOVERNOR_XIAOO_WORKER = wrapper
    }
    await this.persist(handle, context)
    let child
    let client
    for (let attempt = 0; attempt < 3; attempt++) {
      const logFile = await fsp.open(path.join(directory, 'server.log'), 'a', 0o600)
      const offset = (await logFile.stat()).size
      try { this.assertFrozen(local, task.agentConfig.platform) } catch (cause) { await logFile.close(); throw cause }
      child = (this.options.spawnImpl || spawn)(local.serverExecutable, [], { cwd: directory, env: environment, detached: true, stdio: ['ignore', logFile.fd, logFile.fd] })
      const spawned = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      spawned.catch(() => {})
      await logFile.close()
      child.on('error', () => {})
      this.processes.set(context.runId, child)
      await spawned
      handle.opaque.pid = child.pid
      handle.opaque.processIdentity = await identity(child.pid)
      await this.persist(handle, context)
      client = await this.client(handle)
      const readyDeadline = Date.now() + 60000
      let ready = false
      while (true) {
        context.signal?.throwIfAborted()
        if (child.exitCode !== null || child.signalCode) break
        try { await client.request('/health', undefined, context.signal, 1000); await client.request('/sessions', undefined, context.signal, 1000); ready = true; break } catch (cause) { if (Date.now() > readyDeadline) throw cause }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (ready) break
      const startupLog = (await fsp.readFile(path.join(directory, 'server.log'))).subarray(offset).toString()
      if (attempt === 2 || !/address already in use|EADDRINUSE|os error 98/i.test(startupLog)) throw error('XGOVERNOR_START_FAILED', 'xGovernor 启动后退出；请检查本机日志')
      handle.opaque.adminPort = await port()
      do { handle.opaque.tenantPort = await port() } while (handle.opaque.adminPort === handle.opaque.tenantPort)
      environment.XGOVERNOR_BIND_ADDR = `127.0.0.1:${handle.opaque.adminPort}`
      environment.XGOVERNOR_TENANT_BIND_ADDR = `127.0.0.1:${handle.opaque.tenantPort}`
    }
    const model = resolved.model
    handle.opaque.modelId = `${model.provider}/${model.model}`
    handle.opaque.resolvedModel = { provider: model.provider, model: model.model, ...(model.capabilities ? { capabilities: model.capabilities } : {}), ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) }
    await this.persist(handle, context)
    const role = { ...(['pi', 'xiaoo'].includes(runtime.kind) ? { tools_enabled: true, max_turns: 160 } : {}), ...runtime.settings, backend_id: 'docker',
      ...(runtime.kind === 'pi' ? { extension_dir: runtime.extensionDirectory, discovery: { extensions: false, skills: false, prompt_templates: false, themes: false, context_files: false } } : runtime.kind === 'xiaoo' ? { allow_interaction: false } : {}),
    }
    const opened = await client.request('/sessions/open', {
      runtime_id: handle.opaque.runtimeId, runtime_kind: runtime.kind, conversation_id: handle.opaque.deployment, sender_id: 'agent-insight',
      workspace: { kind: 'daemon_default' },
      llm: { provider: model.provider, model: model.model, api_key_env: model.apiKeyEnv, ...(model.apiBase ? { api_base: model.apiBase } : {}), ...(model.api ? { api: model.api } : {}), ...(model.capabilities ? { capabilities: model.capabilities } : {}) },
      deployment: { options: { provider_options: { network_mode: 'none', workspace_root: spec.environment.workspaceRoot, bootstrap: true } } },
      ext: { [runtime.namespace]: role },
    }, context.signal, local.timeouts.prepareSeconds * 1000)
    if (opened.runtime_id !== handle.opaque.runtimeId || opened.isolation?.boundary !== 'container' || opened.isolation?.network !== 'isolated') throw error('ISOLATION_MISMATCH', 'xGovernor 未兑现容器和网络隔离要求')
    const ids = (await this.docker(local, ['ps', '-aq', '--filter', `label=io.xgovernor.docker-prototype=${handle.opaque.deployment}`], context.signal)).stdout.trim().split(/\s+/).filter(Boolean)
    if (ids.length !== 1) throw error('ISOLATION_MISMATCH', '无法精确核对本次工具容器')
    const inspected = JSON.parse((await this.docker(local, ['inspect', ids[0]], context.signal)).stdout)[0]
    if (inspected.Image !== image.Id || inspected.HostConfig.NetworkMode !== 'none' || inspected.Mounts?.length || inspected.Config.User !== '10001:10001'
      || inspected.HostConfig.Privileged !== false || !inspected.HostConfig.CapDrop?.includes('ALL') || !inspected.HostConfig.SecurityOpt?.includes('no-new-privileges:true') || inspected.Config.WorkingDir !== spec.environment.workspaceRoot
      || inspected.HostConfig.Memory !== local.resources.memoryMiB * 1024 ** 2 || inspected.HostConfig.NanoCpus !== local.resources.cpu * 1e9 || inspected.HostConfig.PidsLimit !== local.resources.pids) throw error('ISOLATION_MISMATCH', '容器实际配置与冻结要求不同')
    handle.opaque.containerId = inspected.Id
    await this.persist(handle, context)
    Object.assign(handle.opaque, await prepareExecutionWorkspace(task, {
      exec: (command, operation) => this.exec(handle, command, context.signal, undefined, operation),
    }))
    await this.persist(handle, context)
    this.assertFrozen(local, task.agentConfig.platform)
    return handle
  }
  async exec(handle, command, signal, cwd, operation = 'sandbox-command') {
    const client = await this.client(handle)
    const result = await client.request('/sessions/exec', { runtime_id: handle.opaque.runtimeId, command, cwd: cwd || handle.opaque.workspaceRoot, timeout_ms: 120000 }, signal, 150000)
    if (result.exit_code !== 0 || result.timed_out) {
      const cause = commandFailure(result, operation)
      await this.options.atomicWriteJson(path.join(handle.opaque.directory, 'diagnostic.json'), cause.runFacts.sandboxDiagnostic).catch(() => {})
      throw cause
    }
    return result
  }
  async runAgent(handle, input, context) {
    const local = handle.opaque.executionConfig || this.config.profiles[handle.opaque.profileKey]
    const runtime = local.runtimes[input.platform]
    this.assertFrozen(local, input.platform)
    const client = await this.client(handle)
    if (handle.opaque.submitIntent) throw error('EXECUTION_STATE_UNKNOWN', '任务已提交或结果未知，拒绝重复运行')
    handle.opaque.submitIntent = true
    handle.opaque.startedAt = Date.now()
    await this.persist(handle, context)
    let result
    let traceReporter
    const traceContext = { ...context, input: input.input, platform: input.platform }
    try {
      const receipt = await client.request('/sessions/turns', { runtime_id: handle.opaque.runtimeId, text: input.input, client_request_id: handle.runId,
        ...(handle.opaque.resolvedModel?.reasoningEffort ? { reasoning_effort: handle.opaque.resolvedModel.reasoningEffort } : {}),
      }, input.signal)
      if (receipt.runtime_id !== handle.opaque.runtimeId || !receipt.turn_id) throw error('XGOVERNOR_EVENT_MISMATCH', '任务回执与会话不匹配')
      handle.opaque.turnId = receipt.turn_id
      await this.persist(handle, context)
      await context.onTraceId?.({ traceId: `xgovernor:${handle.runId}` })
      traceReporter = liveTraceReporter(handle, runtime, local, traceContext, this.processRunner, { log: this.options.log })
      const terminal = await client.events(handle.opaque.runtimeId, receipt.turn_id, input.signal, () => context.heartbeat?.())
      if (terminal.kind !== 'turn_completed' || terminal.outcome !== 'complete') throw error('AGENT_RUN_FAILED', 'Agent 未正常完成本次任务')
      result = { exitCode: 0, timedOut: false, model: handle.opaque.modelId, usage: terminal.usage, startedAt: new Date(handle.opaque.startedAt).toISOString(), finishedAt: new Date().toISOString(), execution: {
        profile: handle.opaque.profile || describeProfile(handle.opaque.profileKey, local), controllerBoundary: 'host', toolBoundary: 'container', network: 'deny', resources: local.resources, imageId: handle.opaque.imageId, workspace: { datasetRevision: handle.opaque.datasetRevision, patchBaseCommit: handle.opaque.baseCommit }, ...(handle.opaque.imageResolution ? { imageResolution: handle.opaque.imageResolution } : {}),
      } }
    } catch (cause) {
      await traceReporter?.stop()
      await this.cancel(handle).catch(() => {})
      cause.runFacts = { ...(cause.runFacts || {}), ...(await exportTrace(handle, runtime, local, { ...traceContext, failed: true }, this.processRunner).catch(() => ({}))) }
      throw cause
    }
    await traceReporter?.stop()
    const trace = await exportTrace(handle, runtime, local, traceContext, this.processRunner)
    return { ...result, traceId: trace.traceId }
  }
  async collect(handle, contract, context) {
    if (contract.collector !== 'git-patch/v1') throw error('ARTIFACT_COLLECTOR_UNSUPPORTED', '后端未实现该提交物合同')
    if (!/^[a-f0-9]{40}$/.test(handle.opaque.baseCommit)) throw error('WORKSPACE_REVISION_MISMATCH', '执行句柄缺少有效的 Patch 基线，拒绝使用当前 HEAD 替代')
    const collector = new this.options.GitPatchCollector(async (command, args) => {
      const result = await this.exec(handle, [command, ...args], context.signal, undefined, args[0] === 'add' ? 'patch-stage' : 'patch-diff')
      return { stdout: result.stdout, stderr: result.stderr }
    })
    return collector.collect(contract, { workspace: { baseCommit: handle.opaque.baseCommit } })
  }
  async cancel(handle, context = {}) {
    this.assertHandle(handle)
    if (handle.opaque.adminPort) await (await this.client(handle)).request('/sessions/cancel', { runtime_id: handle.opaque.runtimeId, ...(handle.opaque.turnId ? { turn_id: handle.opaque.turnId } : {}) }, context.signal, 15000)
  }
  async close(handle, context = {}) {
    this.assertHandle(handle)
    context.signal?.throwIfAborted()
    const local = handle.opaque.cleanupConfig || this.config.profiles[handle.opaque.profileKey]
    if (!local) throw error('CLEANUP_PENDING', '清理所需配置缺失')
    if (!handle.opaque.adminPort) {
      handle.opaque.closed = true
      await this.options.atomicWriteJson(path.join(handle.opaque.directory, 'lease.json'), handle.opaque)
      this.reservations.delete(handle.runId)
      return { status: 'succeeded', finishedAt: new Date().toISOString() }
    }
    if (handle.opaque.adminPort) {
      await this.cancel(handle, context).catch(() => {})
      await (await this.client(handle)).request('/sessions/close', { runtime_id: handle.opaque.runtimeId }, context.signal, local.timeouts.cleanupSeconds * 1000).catch(() => {})
    }
    context.signal?.throwIfAborted()
    const child = this.processes.get(handle.runId)
    if (!handle.opaque.pid && !child) {
      for (const entry of await fsp.readdir('/proc')) {
        if (!/^\d+$/.test(entry)) continue
        try {
          const environment = (await fsp.readFile(`/proc/${entry}/environ`, 'utf8')).split('\0')
          const stat = (await fsp.readFile(`/proc/${entry}/stat`, 'utf8')).split(') ')[1].split(' ')
          if (stat[2] === entry && environment.includes(`XGOVERNOR_DATA_DIR=${path.join(handle.opaque.directory, 'state')}`)
            && await fsp.realpath(`/proc/${entry}/exe`) === await fsp.realpath(local.serverExecutable)) {
            handle.opaque.pid = Number(entry); handle.opaque.processIdentity = stat[19]; break
          }
        } catch {}
      }
    }
    if (handle.opaque.pid) {
      const current = await identity(handle.opaque.pid)
      if (current && current === handle.opaque.processIdentity) {
        try { process.kill(-handle.opaque.pid, 'SIGTERM') } catch (cause) { if (cause.code !== 'ESRCH') throw cause }
        const until = Date.now() + Math.min(local.timeouts.cleanupSeconds * 1000, 20000)
        while (await identity(handle.opaque.pid) === current && Date.now() < until) {
          context.signal?.throwIfAborted()
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (await identity(handle.opaque.pid) === current) { try { process.kill(-handle.opaque.pid, 'SIGKILL') } catch (cause) { if (cause.code !== 'ESRCH') throw cause } }
      } else if (current) throw error('CLEANUP_PENDING', 'daemon PID 身份已变化，拒绝终止其他进程')
    }
    if (child && child.exitCode === null && !child.signalCode) await new Promise(resolve => { child.once('close', resolve); setTimeout(resolve, 1000).unref() })
    const ids = (await this.docker(local, ['ps', '-aq', '--filter', `label=io.xgovernor.docker-prototype=${handle.opaque.deployment}`], context.signal)).stdout.trim().split(/\s+/).filter(Boolean)
    for (const id of ids) {
      const container = JSON.parse((await this.docker(local, ['inspect', id], context.signal)).stdout)[0]
      if (container.Config.Labels?.['io.xgovernor.docker-prototype'] !== handle.opaque.deployment) throw error('CLEANUP_PENDING', '无法核对容器 ownership')
      await this.docker(local, ['rm', '-f', id], context.signal)
    }
    if (handle.opaque.pid && await identity(handle.opaque.pid) === handle.opaque.processIdentity) throw error('CLEANUP_PENDING', 'daemon 尚未确认停止')
    handle.opaque.closed = true
    await this.options.atomicWriteJson(path.join(handle.opaque.directory, 'lease.json'), handle.opaque)
    this.reservations.delete(handle.runId)
    this.processes.delete(handle.runId)
    return { status: 'succeeded', finishedAt: new Date().toISOString() }
  }
  async recover(record, context) {
    let handle = record.executionHandle
    if (!handle) {
      try {
        handle = { backendKey: 'xgovernor', runId: context.runId, opaque: JSON.parse(await fsp.readFile(path.join(this.root, context.runId, 'lease.json'), 'utf8')) }
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw cause
        this.reservations.delete(context.runId)
        return { status: 'succeeded', finishedAt: new Date().toISOString() }
      }
    }
    return this.close(handle, context)
  }
}

module.exports = { XGovernorExecutionBackend }

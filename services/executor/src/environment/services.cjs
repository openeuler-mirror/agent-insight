'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { setTimeout: delay } = require('node:timers/promises')
const { loadProjectConfig } = require('../project-config.cjs')
const { bindingFor } = require('../execution-config.cjs')
const { resolveManagedProfile, installationRoot } = require('../xgovernor/installation.cjs')
const { readSetup, COMPATIBLE_REVISION } = require('../xgovernor/setup.cjs')
const { collectorEnvironment, traceApiKey } = require('../xgovernor/credentials.cjs')
const { command } = require('../xgovernor/dependency-manager.cjs')
const { artifactIdentity } = require('../xgovernor/artifact-identity.cjs')

const issue = (code, message) => ({ code, message })
const readable = file => { try { fs.accessSync(file, fs.constants.R_OK); return true } catch { return false } }
const executable = file => { try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false } }
const which = name => {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(directory, name)
    if (executable(file)) return file
  }
  return null
}
function piSdkModule() {
  const cli = which('pi')
  if (!cli) return null
  let dir = path.dirname(fs.realpathSync(cli))
  while (dir !== path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (pkg.name?.endsWith('/pi-coding-agent') && readable(path.join(dir, 'dist/index.js'))) return path.join(dir, 'dist/index.js')
    } catch {}
    dir = path.dirname(dir)
  }
  return null
}
function createServices({ cfg, client, signal, env = process.env } = {}) {
  const setup = readSetup()
  env = collectorEnvironment({ ...env, ...Object.fromEntries(Object.entries(setup.context || {}).filter(([k]) => k !== 'home')),
    ...(setup.context?.home ? { HOME: setup.context.home, AGENT_INSIGHT_USER_HOME: setup.context.home } : {}) })
  const home = env.AGENT_INSIGHT_USER_HOME || env.HOME || os.homedir()
  const project = () => loadProjectConfig('executor')
  const run = (file, args, options = {}) => command(file, args, { ...options, env, signal, timeoutMs: options.timeoutMs || 10000 })
  const nativeRun = async (file, args) => {
    const shell = /\/(?:bash|zsh)$/.test(env.SHELL || '') ? env.SHELL : '/bin/bash'
    return run(shell, ['-lic', 'exec "$@"', 'insight-environment-check', file, ...args])
  }

  async function checkAgent(context, options = {}) {
    const issues = []
    if (options.override) {
      try { await require('../xgovernor/model-resolver.cjs').resolveModel({ agentConfig: { model: options.modelId } }, options.runtime, options.local, { env, signal }) }
      catch (cause) { signal?.throwIfAborted(); issues.push(issue(cause.code || 'MODEL_CONFIGURATION_INVALID', cause.message)) }
      return issues
    }
    const name = context.platform === 'pi-agent' ? 'pi' : context.platform
    if (!which(name)) return [issue('AGENT_NOT_INSTALLED', `请在执行机安装所选 Agent（${name}），然后再次点击“下一步”。`)]
    if (!options.sandbox) {
      const runtime = client.probeExperimentRuntime(context.platform)
      if (!runtime.ready) issues.push(issue('AGENT_TRACE_NOT_READY', '所选 Agent 的执行或链路回传组件未就绪，请重新执行该 Agent 的链路跟踪安装命令。'))
    }
    try {
      if (context.platform === 'pi-agent') {
        const sdkModule = piSdkModule()
        if (!sdkModule) return [...issues, issue('MODEL_CONFIGURATION_UNREADABLE', '无法读取已安装 Pi 的模型 SDK，请检查执行账号的 Pi 安装。')]
        // The existing resolver enters the Agent login shell and keeps credentials off stdout.
        await require('../xgovernor/model-resolver.cjs').resolveModel(
          { agentConfig: { model: context.model } },
          { kind: 'pi', sdkModule, nativeAgent: !options.sandbox }, { models: {} }, { env, signal })
      } else if (context.platform === 'xiaoo') {
        const file = (env.XIAOO_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'xiaoo/config.toml')).replace(/^~(?=\/)/, home)
        if (!readable(file)) issues.push(issue('MODEL_CONFIGURATION_MISSING', '请使用客户端运行账号，在执行机的 xiaoO 中配置模型及 API Key（config.toml）。'))
        else {
          const python = cfg.fiPython || which('python3')
          if (!python) issues.push(issue('MODEL_CONFIGURATION_UNREADABLE', '读取 xiaoO 模型配置需要 Python 3.11+，请在执行机准备后重试。'))
          else {
            const script = 'import json,sys,os\ntry:\n import tomllib\nexcept ImportError:\n import tomli as tomllib\nwith open(sys.argv[1],"rb") as f: c=tomllib.load(f)\nl=c.get("llm",{}); p=l.get("profiles",{}); l={**l,**p.get(l.get("active_profile"),{})}; e=l.get("api_key_env",""); print(json.dumps({"provider":l.get("provider"),"model":l.get("model"),"hasEnv":bool(os.environ.get(e,"")),"hasEnvRef":bool(e),"hasVault":os.path.isfile(os.path.join(os.path.dirname(sys.argv[1]),"llm_secrets.json"))}))'
            const value = JSON.parse((await nativeRun(python, ['-c', script, file])).split('\n').at(-1))
            if (!value.provider || (!context.model && !value.model)) issues.push(issue('MODEL_CONFIGURATION_MISSING', '请在执行机 xiaoO 中配置默认 provider/model，或选择有效模型。'))
            else if (context.model && context.model.split('/')[0] !== value.provider) issues.push(issue('MODEL_CONFIGURATION_INVALID', '所选模型 provider 与执行机 xiaoO 配置不一致，请调整模型选择或执行机配置。'))
            else if (value.hasEnvRef && !value.hasEnv && !value.hasVault) issues.push(issue('MODEL_CREDENTIAL_MISSING', '执行机未找到 xiaoO 所选模型的 API Key，请在原生 xiaoO 配置凭据后再次点击“下一步”。'))
          }
        }
      } else if (context.platform === 'opencode') {
        const config = JSON.parse(await run(which('opencode'), ['debug', 'config']))
        const selected = context.model || config.model
        if (!selected) issues.push(issue('MODEL_CONFIGURATION_MISSING', '请为实验选择模型，或在执行机 OpenCode 中配置默认模型。'))
        else {
          const provider = selected.split('/')[0]
          const authFile = path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'opencode/auth.json')
          let auth = {}
          try { auth = JSON.parse(fs.readFileSync(authFile, 'utf8')) } catch {}
          const configured = config.provider?.[provider]?.options
          const variable = `${provider.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_API_KEY`
          if (!auth[provider] && !configured?.apiKey && !env[variable] && !configured?.baseURL?.match(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/)) {
            issues.push(issue('MODEL_CREDENTIAL_MISSING', '执行机未找到所选模型的认证配置，请使用客户端运行账号执行 opencode auth login 或配置对应 provider。'))
          }
        }
      }
    } catch (cause) {
      signal?.throwIfAborted()
      const known = /^MODEL_/.test(cause.code || '')
      issues.push(issue(known ? cause.code : 'MODEL_CONFIGURATION_UNREADABLE', known ? cause.message : '无法读取所选 Agent 的模型配置，请检查执行账号、模型配置和文件权限后重试。'))
    }
    return issues
  }
  function executionBinding(context) {
    const execution = project().execution
    const binding = bindingFor(execution.bindings, context.dataset.adapterKey, context.platform)
    return binding ? { key: binding.profile, backendKey: 'xgovernor', local: execution.profiles[binding.profile] } : null
  }
  async function checkSandbox(context, binding) {
    const local = binding.local
    const runtime = local?.runtimes[context.platform]
    const modelId = context.model || runtime?.defaultModel || (Object.keys(local?.models || {}).length === 1 ? Object.keys(local.models)[0] : '')
    const issues = await checkAgent(context, { sandbox: true, override: local?.models[modelId], runtime, local, modelId })
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) issues.push(issue('EXECUTION_PLATFORM_UNSUPPORTED', '当前执行方式需要 Linux x64/arm64 主机，请更换运行主机。'))
    if (!local?.runtimes[context.platform]?.agents.includes(context.agent)) return { issues: [...issues, issue('AGENT_UNSUPPORTED', '执行机未配置所选 Agent 对应的执行方式。')], prepare: [] }
    if (!traceApiKey(local, env)) issues.push(issue('TRACE_AUTH_MISSING', '执行机链路上报认证未配置，请重新执行客户端链路跟踪安装命令。'))
    try {
      const docker = await run(local.dockerExecutable, ['--host', `unix://${local.dockerSocket}`, 'info', '--format', '{{.OSType}} {{.CgroupVersion}}'])
      if (docker.trim() !== 'linux 2') issues.push(issue('DOCKER_UNSUPPORTED', '请在执行机配置 Linux Docker 和 cgroup v2，然后再次点击“下一步”。'))
    } catch {
      signal?.throwIfAborted()
      issues.push(issue('DOCKER_UNAVAILABLE', '无法访问执行机 Docker，请确认服务已启动且客户端运行账号具有访问权限。'))
    }
    const installed = resolveManagedProfile(local, { env })
    const selected = installed.config.runtimes[context.platform]
    const managed = !local.serverExecutable && !Object.values(local.runtimes).some(r => r.workerExecutable || r.executable || r.extensionDirectory)
    const identity = artifactIdentity({ ...installed.config, runtimes: { [context.platform]: selected } })
    const needsInstall = installed.reasons.length || identity.reasons.length || (managed && installed.config.managedRevision !== COMPATIBLE_REVISION)
    if (needsInstall && !managed) issues.push(issue('EXECUTION_COMPONENT_INVALID', '执行机手动配置的运行组件缺失或不可用，请检查 executor.local.yaml 中所选 Agent 的执行路径。'))
    if (needsInstall && managed) {
      const tools = await require('../xgovernor/toolchain.cjs').checkBuildTools({ root: installationRoot(env), env, command: run })
      if (tools.length) issues.push(issue('BUILD_TOOLS_MISSING', `请由管理员在执行机准备编译依赖：${tools.join('、')}，然后再次点击“下一步”。`))
    }
    if (!needsInstall) {
      try {
        await require('../xgovernor/model-resolver.cjs').resolveModel({ agentConfig: { model: context.model } }, selected, installed.config, { env, signal })
      } catch (cause) { signal?.throwIfAborted(); issues.push(issue(cause.code || 'MODEL_CONFIGURATION_INVALID', cause.message)) }
    }
    return { issues, prepare: needsInstall && managed ? ['sandbox'] : [] }
  }
  async function prepareSandbox(context, _binding, reportProgress) {
    const root = installationRoot(env)
    while (fs.existsSync(path.join(root, 'setup.lock')) || fs.existsSync(path.join(root, 'update.lock'))) {
      await reportProgress({ state: 'preparing' })
      await delay(1000, undefined, { signal })
    }
    const result = await require('../xgovernor/setup.cjs').installSelectedBackend({
      frameworks: context.platform, env, signal, autoInstallSystem: false,
      onBuild: ({ firstInstall }) => reportProgress({ state: 'preparing', durationHint: firstInstall ? 'first_install_minutes' : 'minutes' }),
      command: (file, args, settings) => command(file, args, { ...settings, signal }),
      log: () => {},
    })
    if (!result.ready) throw Object.assign(new Error('运行组件下载、编译或验证失败，请检查执行机网络、磁盘和权限后再次点击“下一步”。'), { code: 'ENVIRONMENT_INSTALL_FAILED' })
  }
  async function checkFaultInjection(context) {
    const result = client.probeFaultInjection(cfg)
    if (!result.ready) {
      const bootstrap = require(fiRuntimeModule()).resolveBootstrapPython({ env })
      return bootstrap && fiSource() ? { issues: [], prepare: ['fault-injection'] }
        : { issues: [issue('FI_ENVIRONMENT_MISSING', '请在执行机准备支持 venv 的 Python 3.11+，并更新客户端安装包后重试。')], prepare: [] }
    }
    const platform = result.platforms?.[context.platform]
    const issues = platform?.ready ? [] : [issue('FI_ADAPTER_NOT_READY', platform?.note || '所选 Agent 的故障注入适配未就绪，请检查执行机 Agent 安装和权限。')]
    if (platform?.ready && Array.isArray(platform.agents) && platform.agents.length && !platform.agents.some(a => (typeof a === 'string' ? a : a.id || a.name) === context.agent)) issues.push(issue('FI_AGENT_UNAVAILABLE', '故障注入组件未发现所选 Agent，请在执行机配置后重试。'))
    if (platform?.ready && context.dataset.faultTypes.length) {
      const script = 'import json,sys\nfrom agent_fault_injection.fault_inject.catalog.definition import FaultRegistry\nr=FaultRegistry(); missing=[name for name in json.loads(sys.argv[1]) if name not in r.names()]; print(json.dumps(missing))'
      try {
        const missing = JSON.parse(await run(cfg.fiPython || env.AGENT_FI_PYTHON, ['-I', '-c', script, JSON.stringify(context.dataset.faultTypes)]))
        if (missing.length) issues.push(issue('FI_FAULT_UNAVAILABLE', `执行机未安装数据集需要的故障定义：${missing.join('、')}。请更新或同步故障组件后重试。`))
      } catch { issues.push(issue('FI_CATALOG_UNREADABLE', '执行机无法读取故障注入目录，请检查组件版本和文件权限后重试。')) }
    }
    return { issues, prepare: [] }
  }
  function fiRuntimeModule() {
    const installed = path.resolve(__dirname, '../../lib/fi-python-runtime.js')
    return fs.existsSync(installed) ? installed : path.resolve(__dirname, '../../../../scripts/lib/fi-python-runtime.js')
  }
  function fiSource() {
    return [cfg.fiPackageRoot, path.resolve(__dirname, '../../fi-source'), path.resolve(__dirname, '../../../../agent_fault_injection')].find(file => file && readable(path.join(file, 'pyproject.toml')))
  }
  async function prepareFaultInjection() {
    const { ensureManagedFiRuntime } = require(fiRuntimeModule())
    const runtime = ensureManagedFiRuntime({ sourceRoot: fiSource(), env })
    Object.assign(cfg, { fiPython: runtime.python, fiPackageRoot: runtime.packageRoot, fiRuntimeRoot: runtime.runtimeRoot, fiRuntimeMode: runtime.runtimeMode })
    const file = path.join(env.AGENT_INSIGHT_HOME || path.join(os.homedir(), '.agent-insight'), 'client/config.json')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    await require('../xgovernor/dependency-manager.cjs').atomicJson(file, { ...saved, fiPython: runtime.python, fiPackageRoot: runtime.packageRoot, fiRuntimeRoot: runtime.runtimeRoot, fiRuntimeMode: runtime.runtimeMode })
    client.clearEnvironmentProbeCache()
  }
  async function checkMcts(_context, benchmark) {
    const mcts = require('../mcts-runtime.cjs')
    const result = benchmark === 'zsoft-l1' ? mcts.probeMctsZsoftRuntime(cfg) : mcts.probeMctsBenchmarkRuntime(cfg, benchmark)
    return { issues: result.ready ? [] : [issue('MCTS_ENVIRONMENT_NOT_READY', `${result.reason}。请在执行机完成 MCTS 配置后再次点击“下一步”。`)], prepare: [] }
  }
  async function checkZsoftSource() {
    try {
      const root = require('../mcts-config.cjs').mctsZsoftTasksDir(cfg)
      if (readable(root)) return []
    } catch {}
    return [issue('ZSOFT_TASKS_MISSING', '请在执行机 MCTS config.env 中配置可读取的 ZSOFT_TASKS_DIR 后重试。')]
  }
  return { checkAgent, executionBinding, checkSandbox, prepareSandbox, checkFaultInjection, prepareFaultInjection, checkMcts, checkZsoftSource }
}
module.exports = { createServices, piSdkModule }

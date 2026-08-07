#!/usr/bin/env node

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const PACKAGE_ROOT = path.resolve(__dirname, '..')
const RUNTIME_ENTRIES = [
  'core',
  'platform_adapter',
  'ras_embed',
  'config',
  'pyproject.toml',
  'README.md',
]

function statusResult(status, message, extra = {}) {
  return { status, message, ...extra }
}

function getDataRoot(env = process.env, home = os.homedir()) {
  return env.AGENT_INSIGHT_DATA_DIR || path.join(home, '.agent-insight')
}

function parsePythonVersion(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
  }
}

function isSupportedPythonVersion(version) {
  const parsed = parsePythonVersion(version)
  return Boolean(parsed && (parsed.major > 3 || (parsed.major === 3 && parsed.minor >= 10)))
}

function mergeRasConfig(existing, values) {
  const output = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? structuredClone(existing)
    : {}
  const ras = output.agent_ras && typeof output.agent_ras === 'object'
    ? output.agent_ras
    : {}
  const service = ras.service && typeof ras.service === 'object' ? ras.service : {}
  const insight = ras.insight && typeof ras.insight === 'object' ? ras.insight : {}
  const loop = ras.llm_thinking_loop && typeof ras.llm_thinking_loop === 'object'
    ? ras.llm_thinking_loop
    : {}

  ras.enabled = true
  Object.assign(service, {
    transport: 'inproc',
    python: values.python,
    python_home: values.pythonHome,
    libpython: values.libpython,
    repo_root: values.runtimeRoot,
    python_packages: values.pythonPackages,
  })
  insight.enabled = insight.enabled !== false
  if (values.eventsUrl) insight.events_url = values.eventsUrl
  if (values.apiKey !== undefined) insight.api_key = values.apiKey
  if (loop.semantic_content_enabled === undefined) loop.semantic_content_enabled = true

  ras.service = service
  ras.insight = insight
  ras.llm_thinking_loop = loop
  output.agent_ras = ras
  return output
}

function mergeOpenCodeConfig(existing) {
  const output = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? structuredClone(existing)
    : {}
  const agents = output.agent && typeof output.agent === 'object' && !Array.isArray(output.agent)
    ? output.agent
    : {}
  const plugins = Array.isArray(output.plugin) ? [...output.plugin] : []
  const pluginEntry = './plugins/agent-insight-ras.js'
  if (!plugins.includes(pluginEntry)) plugins.push(pluginEntry)
  output.agent = agents
  output.plugin = plugins
  return output
}

function fileSha256(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function installXiaooHooker(runtimeRoot, rasRoot, home = os.homedir()) {
  const sourceHooker = path.join(runtimeRoot, 'platform_adapter', 'xiaoo', 'hooker')
  if (!fs.existsSync(sourceHooker)) {
    return { ok: false, error: `missing xiaoo hooker at ${sourceHooker}` }
  }
  const destRoot = path.join(rasRoot, 'xiaoo', 'hooker')
  fs.mkdirSync(destRoot, { recursive: true })
  for (const name of fs.readdirSync(sourceHooker)) {
    const src = path.join(sourceHooker, name)
    const dst = path.join(destRoot, name)
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dst)
    }
  }
  const hookerMain = path.join(destRoot, 'hooker_main.py')
  const sourceMain = path.join(sourceHooker, 'hooker_main.py')
  if (fileSha256(hookerMain) !== fileSha256(sourceMain)) {
    return { ok: false, error: 'xiaoo hooker_main.py hash mismatch after copy' }
  }
  const pluginPath = path.join(destRoot, 'plugin.json')
  // Plugin hooks only (Chat / Tool / Session). stream_delta is NOT a hook_point —
  // xiaoO gateway LoopEventSink invokes hooker_main.py stream_delta directly.
  const entries = [
    ['agent_ras_chat_received', '*.Chat.message.received', 'chat_received'],
    ['agent_ras_tool_post', '*.Tool.*.post', 'tool_post'],
    ['agent_ras_session_state', '*.Session.lifecycle.state', 'session_state'],
  ]
  const pluginFixed = entries.map(([id, hook_point, op]) => ({
    id,
    hook_point,
    command: `python3 "${hookerMain}" ${op}`,
  }))
  fs.writeFileSync(pluginPath, `${JSON.stringify(pluginFixed, null, 2)}\n`, 'utf8')

  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  const configPath = path.join(xdg, 'xiaoo', 'config.toml')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  let toml = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
  const pluginLine = `"${pluginPath.replace(/\\/g, '/')}"`
  if (!toml.includes(pluginPath) && !toml.includes(pluginPath.replace(/\\/g, '/'))) {
    if (!/\[hooker\]/.test(toml)) {
      toml += `\n[hooker]\nplugins = [${pluginLine}]\n`
    } else if (/plugins\s*=\s*\[/.test(toml)) {
      toml = toml.replace(/plugins\s*=\s*\[/, (m) => `${m}${pluginLine}, `)
    } else {
      toml = toml.replace(/\[hooker\]/, `[hooker]\nplugins = [${pluginLine}]`)
    }
    fs.writeFileSync(configPath, toml, 'utf8')
  }
  return { ok: true, pluginPath, destRoot, configPath }
}

function readJsonWithBackup(filePath, label) {
  if (!fs.existsSync(filePath)) return {}
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    const backupPath = `${filePath}.bak.${Date.now()}`
    fs.copyFileSync(filePath, backupPath)
    console.warn(`⚠️  ${label} JSON 无法解析，已备份到 ${backupPath}`)
    return {}
  }
}

function readEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {}
  const result = {}
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }
  return result
}

function resolveEventsUrl(env, fileEnv) {
  if (env.AGENT_INSIGHT_RAS_EVENTS_URL) return env.AGENT_INSIGHT_RAS_EVENTS_URL
  const host = env.AGENT_INSIGHT_HOST || fileEnv.AGENT_INSIGHT_HOST
  if (!host) return ''
  const normalized = /^https?:\/\//.test(host) ? host : `http://${host}`
  return `${normalized.replace(/\/$/, '')}/api/ingest/ras-events`
}

function hashRuntime(sourceRoot) {
  const hash = crypto.createHash('sha256')

  function visit(target, relative) {
    const stat = fs.statSync(target)
    if (stat.isDirectory()) {
      const names = fs.readdirSync(target)
        .filter((name) => name !== '__pycache__' && name !== '.pytest_cache' && !name.endsWith('.pyc'))
        .sort()
      for (const name of names) visit(path.join(target, name), path.join(relative, name))
      return
    }
    hash.update(relative)
    hash.update(fs.readFileSync(target))
  }

  for (const entry of RUNTIME_ENTRIES) {
    const target = path.join(sourceRoot, entry)
    if (!fs.existsSync(target)) throw new Error(`RAS runtime 缺少 ${entry}`)
    visit(target, entry)
  }
  return hash.digest('hex')
}

function copyRuntime(sourceRoot, runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  for (const entry of RUNTIME_ENTRIES) {
    const source = path.join(sourceRoot, entry)
    const target = path.join(runtimeRoot, entry)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(source, target, { recursive: true, force: true })
  }
}

function probePython(options = {}) {
  const env = options.env || process.env
  const candidates = options.candidates
    || [env.RAS_PYTHON, process.platform === 'win32' ? 'python' : 'python3', 'python']
      .filter(Boolean)
  const runner = options.runner || spawnSync
  const probe = [
    'import json, pathlib, sys, sysconfig',
    'lib = sysconfig.get_config_var("LDLIBRARY") or ""',
    'libdir = sysconfig.get_config_var("LIBDIR") or ""',
    'candidates = []',
    'if libdir and lib: candidates.append(pathlib.Path(libdir) / lib)',
    'if libdir and lib.endswith(".a"):',
    '  base = lib[:-2]',
    '  candidates.extend(pathlib.Path(libdir) / (base + ext) for ext in (".so", ".so.1.0", ".dylib"))',
    'prefixes = {pathlib.Path(sys.prefix), pathlib.Path(sys.base_prefix)}',
    'for pattern in ("libpython3*.so*", "libpython3*.dylib"):',
    '  for prefix in prefixes: candidates.extend(sorted((prefix / "lib").glob(pattern), reverse=True))',
    'found = next((str(p) for p in candidates if p.is_file() and p.suffix != ".a"), "")',
    'print(json.dumps({"version": ".".join(map(str, sys.version_info[:3])), "executable": sys.executable, "home": sys.prefix, "libpython": found}))',
  ].join('\n')

  for (const candidate of candidates) {
    const result = runner(candidate, ['-c', probe], { encoding: 'utf8', env })
    if (result.status !== 0) continue
    try {
      const info = JSON.parse(result.stdout.trim())
      if (!isSupportedPythonVersion(info.version)) {
        return statusResult('failed', `Python ${info.version} 版本过低，需要 Python 3.10+`)
      }
      const pip = runner(info.executable, ['-m', 'pip', '--version'], { encoding: 'utf8', env })
      if (pip.status !== 0) {
        return statusResult('failed', `Python ${info.version} 缺少 pip，请先安装 python3-pip`)
      }
      if (!info.libpython || !fs.existsSync(info.libpython)) {
        return statusResult(
          'failed',
          '未找到共享 libpython；请安装带共享库的 Python（Linux 常见包：python3-dev）',
        )
      }
      return statusResult('ready', 'Python 环境可用', { ...info })
    } catch {
      continue
    }
  }
  return statusResult('failed', '未找到 Python 3.10+；请安装 Python 和 pip 后重试')
}

function installPythonPackage(
  python,
  runtimeRoot,
  pythonPackages,
  runner = spawnSync,
  env = process.env,
) {
  fs.mkdirSync(pythonPackages, { recursive: true })
  const result = runner(
    python,
    [
      '-m',
      'pip',
      'install',
      '--upgrade',
      '--ignore-installed',
      '--no-warn-conflicts',
      '--no-warn-script-location',
      '--target',
      pythonPackages,
      runtimeRoot,
    ],
    { stdio: 'inherit', env: { ...env, PIP_DISABLE_PIP_VERSION_CHECK: '1' } },
  )
  if (result.status !== 0) {
    throw new Error('Python 包安装失败；请检查 pip 输出和目录权限')
  }
  for (const buildArtifact of ['agent_ras.egg-info', 'build']) {
    fs.rmSync(path.join(runtimeRoot, buildArtifact), { recursive: true, force: true })
  }
}

function checkRasInstallation(options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  if (env.AGENT_INSIGHT_RAS === '0') {
    return statusResult('disabled', 'AGENT_INSIGHT_RAS=0，已跳过 Agent RAS')
  }
  if (platform === 'win32') {
    return statusResult('unsupported', '原生 Windows 暂不支持 Agent RAS inproc，请在 WSL 中安装')
  }

  const packageRoot = options.packageRoot || PACKAGE_ROOT
  const sourceRoot = path.join(packageRoot, 'agent_ras')
  if (!fs.existsSync(sourceRoot)) {
    return statusResult('failed', `npm/source 包缺少 Agent RAS runtime：${sourceRoot}`)
  }

  try {
    const dataRoot = options.dataRoot || getDataRoot(env, options.home)
    const rasRoot = env.AGENT_INSIGHT_RAS_HOME || path.join(dataRoot, 'ras')
    const markerPath = path.join(rasRoot, 'install.json')
    const configPath = path.join(rasRoot, 'config.json')
    if (!fs.existsSync(markerPath) || !fs.existsSync(configPath)) {
      return statusResult('failed', 'Agent RAS 尚未安装，请执行 agent-insight install-ras')
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    const fingerprint = hashRuntime(sourceRoot)
    const runtimeRoot = path.join(rasRoot, 'runtime', fingerprint.slice(0, 12))
    const pythonPackages = path.join(runtimeRoot, '.python-packages')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const service = config?.agent_ras?.service || {}

    const coreOk =
      marker.fingerprint === fingerprint
      && marker.runtimeRoot === runtimeRoot
      && fs.existsSync(runtimeRoot)
      && fs.existsSync(pythonPackages)
      && service.transport === 'inproc'
      && service.repo_root === runtimeRoot
      && service.python_packages === pythonPackages

    if (!coreOk) {
      return statusResult('failed', 'Agent RAS runtime 不是当前版本，请执行 agent-insight install-ras')
    }

    const want = options.platforms || ['opencode', 'xiaoo']
    const configHome = env.XDG_CONFIG_HOME || path.join(options.home || os.homedir(), '.config')
    const details = { configPath, runtimeRoot, platforms: {} }

    if (want.includes('opencode')) {
      const openCodeRoot = path.join(configHome, 'opencode')
      const wrapperPath = path.join(openCodeRoot, 'plugins', 'agent-insight-ras.js')
      const openCodeConfigPath = path.join(openCodeRoot, 'opencode.json')
      let openCodeOk = false
      try {
        const openCodeConfig = JSON.parse(fs.readFileSync(openCodeConfigPath, 'utf8'))
        const expectedPlugin = './plugins/agent-insight-ras.js'
        openCodeOk =
          fs.existsSync(wrapperPath)
          && fs.readFileSync(wrapperPath, 'utf8').includes(
            path.join(runtimeRoot, 'platform_adapter', 'opencode', 'plugin.js'),
          )
          && Array.isArray(openCodeConfig.plugin)
          && openCodeConfig.plugin.includes(expectedPlugin)
          && Boolean(openCodeConfig.agent?.['ras-judge'])
      } catch {
        openCodeOk = false
      }
      details.platforms.opencode = openCodeOk ? 'ok' : 'missing'
      if (!openCodeOk && want.length === 1) {
        return statusResult('failed', 'OpenCode RAS 配置不是当前版本，请执行 agent-insight install-ras', details)
      }
    }

    if (want.includes('xiaoo')) {
      const hookerMain = path.join(rasRoot, 'xiaoo', 'hooker', 'hooker_main.py')
      const runtimeHooker = path.join(
        runtimeRoot,
        'platform_adapter',
        'xiaoo',
        'hooker',
        'hooker_main.py',
      )
      const xiaooOk =
        fs.existsSync(hookerMain)
        && fs.existsSync(runtimeHooker)
        && fileSha256(hookerMain) === fileSha256(runtimeHooker)
        && fs.existsSync(path.join(runtimeRoot, 'platform_adapter', 'xiaoo', 'hooks.py'))
      details.platforms.xiaoo = xiaooOk ? 'ok' : 'missing'
      if (!xiaooOk && want.length === 1) {
        return statusResult('failed', 'xiaoO RAS hooker 不是当前版本，请执行 agent-insight install-ras', details)
      }
    }

    const missing = Object.entries(details.platforms)
      .filter(([, v]) => v !== 'ok')
      .map(([k]) => k)
    if (missing.length && want.length > 1) {
      return statusResult(
        'failed',
        `Agent RAS 核心已就绪，但平台装配不完整：${missing.join(', ')}；请执行 agent-insight install-ras`,
        details,
      )
    }

    return statusResult('already current', 'Agent RAS 已是当前版本', details)
  } catch (error) {
    return statusResult('failed', `Agent RAS 安装状态无效：${error.message}`)
  }
}

function installRas(options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  if (env.AGENT_INSIGHT_RAS === '0') {
    return statusResult('disabled', 'AGENT_INSIGHT_RAS=0，已跳过 Agent RAS')
  }
  if (platform === 'win32') {
    return statusResult('unsupported', '原生 Windows 暂不支持 Agent RAS inproc，请在 WSL 中安装')
  }

  const packageRoot = options.packageRoot || PACKAGE_ROOT
  const sourceRoot = path.join(packageRoot, 'agent_ras')
  if (!fs.existsSync(sourceRoot)) {
    return statusResult('failed', `npm/source 包缺少 Agent RAS runtime：${sourceRoot}`)
  }

  try {
    const dataRoot = options.dataRoot || getDataRoot(env, options.home)
    const rasRoot = env.AGENT_INSIGHT_RAS_HOME || path.join(dataRoot, 'ras')
    fs.mkdirSync(rasRoot, { recursive: true })
    fs.accessSync(rasRoot, fs.constants.W_OK)

    const python = probePython({ env, runner: options.runner })
    if (python.status !== 'ready') return python

    const fingerprint = hashRuntime(sourceRoot)
    const runtimeRoot = path.join(rasRoot, 'runtime', fingerprint.slice(0, 12))
    const pythonPackages = path.join(runtimeRoot, '.python-packages')
    const markerPath = path.join(rasRoot, 'install.json')
    const marker = readJsonWithBackup(markerPath, 'RAS install marker')
    const current = marker.fingerprint === fingerprint
      && marker.python === python.executable
      && fs.existsSync(runtimeRoot)
      && fs.existsSync(pythonPackages)

    if (!current) {
      copyRuntime(sourceRoot, runtimeRoot)
      installPythonPackage(
        python.executable,
        runtimeRoot,
        pythonPackages,
        options.runner,
        env,
      )
    }

    const fileEnv = readEnvFile(path.join(dataRoot, '.env'))
    const apiKey = env.AGENT_INSIGHT_API_KEY ?? fileEnv.AGENT_INSIGHT_API_KEY ?? ''
    const eventsUrl = resolveEventsUrl(env, fileEnv)
    const configPath = path.join(rasRoot, 'config.json')
    const config = mergeRasConfig(readJsonWithBackup(configPath, 'RAS config'), {
      python: python.executable,
      pythonHome: python.home,
      libpython: python.libpython,
      runtimeRoot,
      pythonPackages,
      eventsUrl,
      apiKey,
    })
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

    const configHome = env.XDG_CONFIG_HOME || path.join(options.home || os.homedir(), '.config')
    const openCodeRoot = path.join(configHome, 'opencode')
    const pluginsRoot = path.join(openCodeRoot, 'plugins')
    fs.mkdirSync(pluginsRoot, { recursive: true })
    const wrapperPath = path.join(pluginsRoot, 'agent-insight-ras.js')
    const pluginPath = path.join(runtimeRoot, 'platform_adapter', 'opencode', 'plugin.js')
    fs.writeFileSync(
      wrapperPath,
      `// Generated by agent-insight install-ras; do not edit.\nexport { default } from ${JSON.stringify(pluginPath)}\n`,
      'utf8',
    )

    const openCodeConfigPath = path.join(openCodeRoot, 'opencode.json')
    const openCodeConfig = mergeOpenCodeConfig(
      readJsonWithBackup(openCodeConfigPath, 'OpenCode config'),
    )
    const judgePath = path.join(runtimeRoot, 'platform_adapter', 'opencode', 'ras_judge_agent.json')
    const judge = JSON.parse(fs.readFileSync(judgePath, 'utf8'))
    for (const [name, definition] of Object.entries(judge)) {
      if (!openCodeConfig.agent[name]) openCodeConfig.agent[name] = definition
    }
    fs.writeFileSync(openCodeConfigPath, `${JSON.stringify(openCodeConfig, null, 2)}\n`, 'utf8')

    const xiaoo = installXiaooHooker(runtimeRoot, rasRoot, options.home || os.homedir())
    if (!xiaoo.ok) {
      console.warn(`⚠️  xiaoO hooker install skipped: ${xiaoo.error}`)
    }

    fs.writeFileSync(
      markerPath,
      `${JSON.stringify({
        fingerprint,
        python: python.executable,
        runtimeRoot,
        pythonPackages,
        installedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      'utf8',
    )

    const opencode = spawnSync(
      platform === 'win32' ? 'where' : 'sh',
      platform === 'win32' ? ['opencode'] : ['-c', 'command -v opencode'],
      { encoding: 'utf8', env },
    )
    const warning = opencode.status === 0
      ? ''
      : '；未检测到 opencode，可在安装 OpenCode 后直接使用现有配置'
    return statusResult(current ? 'already current' : 'installed', `Agent RAS ${current ? '已是当前版本' : '安装完成'}${warning}`, {
      configPath,
      runtimeRoot,
      wrapperPath,
      xiaooPluginPath: xiaoo.ok ? xiaoo.pluginPath : undefined,
    })
  } catch (error) {
    return statusResult('failed', error.message)
  }
}

function printResult(result) {
  const icon = {
    installed: '✅',
    'already current': '✅',
    disabled: 'ℹ️',
    unsupported: '⚠️',
    failed: '❌',
  }[result.status] || 'ℹ️'
  console.log(`${icon} Agent RAS [${result.status}]: ${result.message}`)
  if (result.runtimeRoot) console.log(`   Runtime: ${result.runtimeRoot}`)
  if (result.configPath) console.log(`   Config: ${result.configPath}`)
}

function run() {
  const checkOnly = process.argv.slice(2).includes('--check')
  const result = checkOnly ? checkRasInstallation() : installRas()
  printResult(result)
  if (result.status === 'failed') process.exitCode = 1
  return result
}

if (require.main === module) run()

module.exports = {
  RUNTIME_ENTRIES,
  checkRasInstallation,
  getDataRoot,
  hashRuntime,
  installRas,
  installXiaooHooker,
  isSupportedPythonVersion,
  mergeOpenCodeConfig,
  mergeRasConfig,
  parsePythonVersion,
  probePython,
  printResult,
  readJsonWithBackup,
  resolveEventsUrl,
  run,
}

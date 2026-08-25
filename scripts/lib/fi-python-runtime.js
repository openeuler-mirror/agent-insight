const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const RUNTIME_SCHEMA_VERSION = 1
const DEFAULT_FI_HOME = path.join(os.homedir(), '.agent-insight', 'fault-injection')

function runtimePythonPath(venvRoot, platform = process.platform) {
  return platform === 'win32'
    ? path.join(venvRoot, 'Scripts', 'python.exe')
    : path.join(venvRoot, 'bin', 'python')
}

function pythonCandidates(env = process.env) {
  return [
    env.AGENT_FI_BOOTSTRAP_PYTHON,
    env.AGENT_FI_PYTHON,
    env.PYTHON,
    'python3',
  ]
    .map((value) => String(value || '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
}

function probePython(command, runner = spawnSync) {
  const code = [
    'import json,sys,venv',
    "print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3])}))",
  ].join(';')
  const result = runner(command, ['-c', code], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0) return null
  try {
    const value = JSON.parse(String(result.stdout || '').trim())
    const version = Array.isArray(value.version) ? value.version.map(Number) : []
    if (!path.isAbsolute(value.executable) || version.length < 2) return null
    if (version[0] < 3 || (version[0] === 3 && version[1] < 11)) return null
    return {
      executable: value.executable,
      version,
      versionText: version.join('.'),
    }
  } catch {
    return null
  }
}

function resolveBootstrapPython({ env = process.env, runner = spawnSync } = {}) {
  for (const candidate of pythonCandidates(env)) {
    const probed = probePython(candidate, runner)
    if (probed) return probed
  }
  return null
}

function shouldSkipHashEntry(name) {
  return (
    name === '__pycache__' ||
    name === '.pytest_cache' ||
    name === 'build' ||
    name === 'dist' ||
    name.endsWith('.egg-info') ||
    name.endsWith('.pyc') ||
    name.endsWith('.pyo')
  )
}

function hashPackageTree(root) {
  const hash = crypto.createHash('sha256')
  function visit(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !shouldSkipHashEntry(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\0`)
        visit(absolute)
      } else if (entry.isFile()) {
        hash.update(`f:${relative}\0`)
        hash.update(fs.readFileSync(absolute))
        hash.update('\0')
      }
    }
  }
  visit(root)
  return hash.digest('hex')
}

function atomicWriteJson(target, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  fs.renameSync(tmp, target)
  fs.chmodSync(target, mode)
}

function verifyManagedPython(python, { runner = spawnSync, cwd = DEFAULT_FI_HOME } = {}) {
  if (!python || !fs.existsSync(python)) return false
  const result = runner(
    python,
    [
      '-I',
      '-c',
      [
        'import json,sys,agent_fault_injection',
        "print(json.dumps({'prefix':sys.prefix,'base_prefix':sys.base_prefix,'module':agent_fault_injection.__file__}))",
      ].join(';'),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd },
  )
  if (result.status !== 0) return false
  try {
    const value = JSON.parse(String(result.stdout || '').trim())
    return Boolean(value.module) && value.prefix !== value.base_prefix
  } catch {
    return false
  }
}

function runtimeIdFor({ sourceRoot, editable, bootstrap }) {
  const projectMetadataHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(sourceRoot, 'pyproject.toml')))
    .digest('hex')
  const sourceIdentity = editable
    ? `editable:${path.resolve(sourceRoot)}:${projectMetadataHash}`
    : `package:${hashPackageTree(sourceRoot)}`
  const hash = crypto.createHash('sha256')
  hash.update(JSON.stringify({
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    sourceIdentity,
    python: bootstrap.executable,
    version: bootstrap.version,
  }))
  return hash.digest('hex').slice(0, 16)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function ensureManagedFiRuntime({
  sourceRoot,
  editable = false,
  fiHome = DEFAULT_FI_HOME,
  env = process.env,
  runner = spawnSync,
  now = () => new Date(),
} = {}) {
  if (!sourceRoot || !fs.existsSync(path.join(sourceRoot, 'pyproject.toml'))) {
    throw new Error(`agent_fault_injection source missing: ${sourceRoot || '(empty)'}`)
  }
  const bootstrap = resolveBootstrapPython({ env, runner })
  if (!bootstrap) {
    throw new Error('需要 Python 3.11+ 且必须支持 venv；不会向系统 Python 安装任何包')
  }

  const runtimeId = runtimeIdFor({ sourceRoot, editable, bootstrap })
  const runtimeRoot = path.join(fiHome, 'runtimes', runtimeId)
  const venvRoot = path.join(runtimeRoot, 'venv')
  const python = runtimePythonPath(venvRoot)
  const manifestPath = path.join(runtimeRoot, 'install.json')
  const currentPath = path.join(fiHome, 'current.json')
  const existing = readJson(manifestPath)

  if (
    existing?.schemaVersion === RUNTIME_SCHEMA_VERSION &&
    existing.runtimeId === runtimeId &&
    existing.python === python &&
    verifyManagedPython(python, { runner, cwd: fiHome })
  ) {
    atomicWriteJson(currentPath, existing)
    return { ...existing, reused: true }
  }

  if (fs.existsSync(runtimeRoot)) {
    const displaced = `${runtimeRoot}.incomplete-${Date.now()}`
    fs.renameSync(runtimeRoot, displaced)
  }
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })

  const packageRoot = editable ? path.resolve(sourceRoot) : path.join(runtimeRoot, 'package')
  if (!editable) fs.cpSync(sourceRoot, packageRoot, { recursive: true })

  const create = runner(bootstrap.executable, ['-m', 'venv', venvRoot], {
    encoding: 'utf8',
    stdio: 'inherit',
  })
  if (create.status !== 0 || !fs.existsSync(python)) {
    throw new Error(`创建故障注入虚拟环境失败 (exit ${create.status ?? 'unknown'})`)
  }

  const installArgs = [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-input',
    ...(editable ? ['-e'] : []),
    packageRoot,
  ]
  const install = runner(python, installArgs, { encoding: 'utf8', stdio: 'inherit' })
  if (install.status !== 0) {
    throw new Error(`在独立虚拟环境中安装故障注入组件失败 (exit ${install.status ?? 'unknown'})`)
  }
  if (!verifyManagedPython(python, { runner, cwd: fiHome })) {
    throw new Error('故障注入虚拟环境验证失败：无法隔离导入 agent_fault_injection')
  }

  const manifest = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    runtimeId,
    runtimeMode: 'managed-venv',
    runtimeRoot,
    python,
    pythonVersion: bootstrap.versionText,
    bootstrapPython: bootstrap.executable,
    packageRoot,
    editable,
    installedAt: now().toISOString(),
  }
  atomicWriteJson(manifestPath, manifest)
  atomicWriteJson(currentPath, manifest)
  return { ...manifest, reused: false }
}

function readCurrentRuntime(fiHome = DEFAULT_FI_HOME) {
  return readJson(path.join(fiHome, 'current.json'))
}

module.exports = {
  DEFAULT_FI_HOME,
  RUNTIME_SCHEMA_VERSION,
  atomicWriteJson,
  ensureManagedFiRuntime,
  hashPackageTree,
  probePython,
  readCurrentRuntime,
  resolveBootstrapPython,
  runtimeIdFor,
  runtimePythonPath,
  verifyManagedPython,
}

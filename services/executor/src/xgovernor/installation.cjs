'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { artifactIdentity } = require('./artifact-identity.cjs')

const repository = 'https://gitcode.com/openeuler/xGovernor.git'
const releaseId = /^[a-f0-9]{40}-[a-f0-9]{16}$/

function installationRoot(env = process.env) {
  if (env.AGENT_INSIGHT_DATA_DIR) throw new Error('AGENT_INSIGHT_DATA_DIR 已不支持，请迁移至 AGENT_INSIGHT_HOME')
  const configured = env.AGENT_INSIGHT_HOME || path.join(os.homedir(), '.agent-insight')
  const home = configured.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[/\\]|$)/, () => os.homedir())
  return path.join(path.resolve(home), 'dependencies', 'xgovernor')
}

function readState(root) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'))
    if (state.schemaVersion !== 1 || !releaseId.test(state.current) || (state.previous !== null && !releaseId.test(state.previous))) throw new Error('版本指针格式不兼容')
    return state
  } catch (cause) {
    if (cause.code === 'ENOENT') return null
    throw cause
  }
}

function readRelease(root, id, target = { platform: process.platform, arch: process.arch }) {
  if (!releaseId.test(id)) throw new Error('安装版本标识不合法')
  const directory = path.join(root, 'releases', id)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'installation.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.repository !== repository || !/^[a-f0-9]{40}$/.test(manifest.revision)
    || !id.startsWith(`${manifest.revision}-`) || manifest.platform !== target.platform || manifest.arch !== target.arch
    || !/^sha256:[a-f0-9]{64}$/.test(manifest.artifactDigest) || manifest.compatibility?.contract !== 'agent-insight-xgovernor/v1') throw new Error('安装清单、协议或目标架构不兼容')
  const resolve = name => {
    const value = manifest.artifacts?.[name]
    if (typeof value !== 'string' || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error('安装清单制品路径不合法')
    const resolved = fs.realpathSync(path.join(directory, value))
    if (!resolved.startsWith(`${fs.realpathSync(directory)}${path.sep}`)) throw new Error('安装制品超出版本目录')
    return path.join(directory, value)
  }
  const config = {
    serverExecutable: resolve('server'),
    runtimes: {
      'pi-agent': { kind: 'pi', workerExecutable: resolve('piWorker'), executable: resolve('pi'), extensionDirectory: resolve('extension') },
      xiaoo: { kind: 'xiaoo', workerExecutable: resolve('server') },
    },
  }
  const identity = artifactIdentity(config)
  if (identity.reasons.length || identity.digest !== manifest.artifactDigest) throw new Error(`安装制品缺失或摘要不一致${identity.reasons.length ? `：${identity.reasons.join('；')}` : ''}`)
  for (const file of [config.serverExecutable, config.runtimes['pi-agent'].workerExecutable, config.runtimes['pi-agent'].executable]) {
    if (!fs.statSync(file).isFile()) throw new Error('安装制品不是可执行文件')
    fs.accessSync(file, fs.constants.X_OK)
  }
  if (!fs.statSync(config.runtimes['pi-agent'].extensionDirectory).isDirectory()) throw new Error('Pi 扩展目录不合法')
  return { id, directory, manifest, config }
}

function resolveManagedProfile(local, options = {}) {
  if (local.serverExecutable || local.managedRevision || Object.values(local.runtimes).some(runtime => runtime.workerExecutable || runtime.executable || runtime.extensionDirectory)) return { config: local, reasons: [] }
  try {
    const root = options.root || installationRoot(options.env)
    const state = readState(root)
    if (!state) return { config: local, reasons: ['尚未安装 xGovernor；请重新执行客户端安装命令并选择 Pi/xiaoO'] }
    const installed = readRelease(root, state.current, options.target)
    const runtimes = Object.fromEntries(Object.entries(local.runtimes).map(([platform, runtime]) => {
      const component = Object.values(installed.config.runtimes).find(item => item.kind === runtime.kind)
      return [platform, { ...runtime, ...(component || {}) }]
    }))
    return { config: { ...local, serverExecutable: installed.config.serverExecutable, runtimes, managedRevision: installed.manifest.revision }, reasons: [] }
  } catch (cause) {
    return { config: local, reasons: [`xGovernor 受管理安装不可用：${cause.message}`] }
  }
}

module.exports = { installationRoot, readState, readRelease, resolveManagedProfile, repository }

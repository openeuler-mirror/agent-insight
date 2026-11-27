/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { artifactIdentity } = require('./artifact-identity.cjs')
const { BRIDGE_VERSION } = require('./native-credentials-build.cjs')

const repository = 'https://gitcode.com/openeuler/xGovernor.git'
const releaseId = /^[a-f0-9]{40}-[a-f0-9]{16}$/
const BUILD_LAYOUT_VERSION = 1
const MODEL_PREFLIGHT_TIMEOUT_SECONDS = 60

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
  if (manifest.build?.layoutVersion !== BUILD_LAYOUT_VERSION) throw new Error('旧安装未在最终版本目录构建；请重新执行客户端安装命令以重建 xGovernor')
  if (manifest.build.sourceDirectory !== fs.realpathSync(path.join(directory, 'source'))) throw new Error('安装目录已移动，与编译时路径不一致；请重新执行客户端安装命令以重建 xGovernor')
  if (manifest.build.modelPreflightTimeoutSeconds !== MODEL_PREFLIGHT_TIMEOUT_SECONDS) throw new Error('安装未包含 xiaoO 模型预检 60 秒时限；请在新建实验向导第二步重新准备环境以重建 xGovernor，重装客户端不会自动重建')
  if (manifest.components?.xiaooCredentials?.version !== BRIDGE_VERSION) throw new Error('安装缺少 xiaoO 原生凭据桥接；请重新执行客户端安装命令以重建')
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
      xiaoo: { kind: 'xiaoo', workerExecutable: resolve('server'), credentialExecutable: resolve('xiaooCredentials') },
    },
  }
  const identity = artifactIdentity(config)
  if (identity.reasons.length || identity.digest !== manifest.artifactDigest) throw new Error(`安装制品缺失或摘要不一致${identity.reasons.length ? `：${identity.reasons.join('；')}` : ''}`)
  for (const file of [config.serverExecutable, config.runtimes['pi-agent'].workerExecutable, config.runtimes['pi-agent'].executable, config.runtimes.xiaoo.credentialExecutable]) {
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

module.exports = { installationRoot, readState, readRelease, resolveManagedProfile, repository, BUILD_LAYOUT_VERSION, MODEL_PREFLIGHT_TIMEOUT_SECONDS }

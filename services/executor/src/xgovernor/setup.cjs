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
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { setTimeout: delay } = require('node:timers/promises')
const { DependencyManager, atomicJson, command } = require('./dependency-manager.cjs')
const { installationRoot } = require('./installation.cjs')
const { ensureBuildTools, toolchainEnvironment } = require('./toolchain.cjs')

const COMPATIBLE_REVISION = 'd08e67e366b89e622af9383383e251c4f40eb728'
const supported = ['pi-agent', 'xiaoo']
function selectedFrameworks(value) {
  return [...new Set(String(value || '').split(/[\s,]+/).map(item => item === 'goal-plus' ? 'pi-agent' : item).filter(item => supported.includes(item)))]
}
function readSetup(root = installationRoot()) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'setup.json'), 'utf8')) } catch { return {} }
}
async function saveSetupContext(options = {}) {
  const env = options.env || process.env
  const root = options.root || installationRoot(env)
  const previous = readSetup(root)
  const platforms = [...new Set([...(previous.platforms || []), ...selectedFrameworks(options.frameworks)])]
  if (!platforms.length) return
  await fsp.mkdir(root, { recursive: true, mode: 0o700 })
  await atomicJson(path.join(root, 'setup.json'), { ...previous, schemaVersion: 1, platforms, context: {
    home: env.AGENT_INSIGHT_USER_HOME || os.homedir(),
    ...Object.fromEntries(['PI_CODING_AGENT_DIR', 'XIAOO_CONFIG', 'XDG_CONFIG_HOME', 'SHELL'].filter(key => env[key]).map(key => [key, env[key]])),
  } })
}
async function installUnlocked(options = {}) {
  const env = options.env || process.env
  const root = options.root || installationRoot(env)
  const previous = readSetup(root)
  const selected = options.frameworks === undefined ? (previous.platforms || []) : selectedFrameworks(options.frameworks)
  if (!selected.length) return { skipped: true }
  const log = options.log || console.log
  const target = options.target || { platform: process.platform, arch: process.arch }
  await fsp.mkdir(root, { recursive: true, mode: 0o700 })
  const state = { schemaVersion: 1, platforms: selected, revision: COMPATIBLE_REVISION, context: {
    home: env.AGENT_INSIGHT_USER_HOME || os.homedir(),
    ...Object.fromEntries(['PI_CODING_AGENT_DIR', 'XIAOO_CONFIG', 'XDG_CONFIG_HOME', 'SHELL'].filter(key => env[key]).map(key => [key, env[key]])),
  } }
  await atomicJson(path.join(root, 'setup.json'), state)
  const run = options.command || command
  const manager = options.manager || new DependencyManager({ root, target, log, env: toolchainEnvironment(root, env) })
  let stage = 'platform'
  try {
    if (target.platform !== 'linux' || !['x64', 'arm64'].includes(target.arch)) throw new Error('本地 Docker 执行仅支持 Linux x64/arm64；普通 Agent 采集仍可使用')
    let installed
    try { installed = manager.status() } catch {}
    if (installed?.installed && installed.revision === COMPATIBLE_REVISION) log('[xgovernor] 已安装兼容版本，跳过下载和编译')
    else {
      await options.onBuild?.({ firstInstall: !fs.existsSync(path.join(root, 'current.json')) })
      log('[xgovernor] 准备源码编译依赖；仅维护客户端独立目录，不操作 MCTS')
      stage = 'toolchain'
      await (options.ensureBuildTools || ensureBuildTools)({ root, env, target, command: run, log, autoInstallSystem: options.autoInstallSystem })
      manager.env = toolchainEnvironment(root, env)
      stage = 'build'
      await manager.update(COMPATIBLE_REVISION)
    }
    stage = 'docker'
    const dockerConfig = options.dockerConfig || require('../project-config.cjs').loadProjectConfig('executor').execution.profiles['xgovernor-local-docker']
    const docker = await run(dockerConfig.dockerExecutable, ['--host', `unix://${dockerConfig.dockerSocket}`, 'info', '--format', '{{.OSType}} {{.CgroupVersion}}'], { env, timeoutMs: 10000 })
    if (docker.trim() !== 'linux 2') throw new Error('Docker 需要 Linux 和 cgroup v2；请由管理员调整宿主机后重新执行安装命令')
    await atomicJson(path.join(root, 'setup.json'), { ...state, ready: true })
    log('[xgovernor] 安装完成；模型和凭据沿用所选 Agent，Case 执行时独立启动服务')
    return { ready: true }
  } catch (cause) {
    const note = cause.message
    await atomicJson(path.join(root, 'setup.json'), { ...state, ready: false, note })
    log(`[xgovernor] Benchmark 未就绪：${note}。客户端保持在线；处理后重跑同一 curl 命令。`)
    return { ready: false, note, stage, code: cause.code }
  }
}
async function installSelectedBackend(options = {}) {
  const root = options.root || installationRoot(options.env)
  if (options.frameworks !== undefined && !selectedFrameworks(options.frameworks).length) return { skipped: true }
  if (options.frameworks === undefined && !readSetup(root).platforms?.length) return { skipped: true }
  await fsp.mkdir(root, { recursive: true, mode: 0o700 })
  const lock = path.join(root, 'setup.lock')
  let descriptor
  while (!descriptor) {
    if (options.waitForLock) await waitForSetupLocks(root, options)
    try { descriptor = await fsp.open(lock, 'wx', 0o600) } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause
      if (options.waitForLock) continue
      const note = '另一安装进程正在准备 xGovernor；待其结束后重试。异常终止遗留锁需确认进程退出后清理'
      const log = options.log || console.log
      log(note)
      return { ready: false, note }
    }
  }
  const controller = new AbortController()
  const externalCancel = () => controller.abort(options.signal.reason)
  options.signal?.addEventListener('abort', externalCancel, { once: true })
  if (options.signal?.aborted) externalCancel()
  const cancel = () => controller.abort(new Error('安装已取消'))
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try {
    await descriptor.writeFile(String(process.pid))
    const run = options.command || ((file, args, settings) => command(file, args, { ...settings, signal: controller.signal }))
    const manager = options.manager || new DependencyManager({ root, target: options.target, log: options.log, env: toolchainEnvironment(root, options.env), signal: controller.signal })
    return await installUnlocked({ ...options, root, manager, command: run })
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel)
    options.signal?.removeEventListener('abort', externalCancel)
    await descriptor.close(); await fsp.rm(lock, { force: true })
  }
}
async function waitForSetupLocks(root, options) {
  for (;;) {
    options.signal?.throwIfAborted()
    let waiting = false
    for (const name of ['setup.lock', 'update.lock']) {
      const file = path.join(root, name)
      try {
        const info = await fsp.stat(file)
        const pid = Number(await fsp.readFile(file, 'utf8'))
        let dead = false
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0) } catch (cause) { dead = cause.code === 'ESRCH' }
        }
        const latest = await fsp.stat(file)
        if (dead && latest.ino === info.ino && latest.mtimeMs === info.mtimeMs) await fsp.unlink(file)
        else waiting = true
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
    }
    if (!waiting) return
    await options.reportProgress?.({ state: 'preparing' })
    await delay(250, undefined, { signal: options.signal })
  }
}
module.exports = { COMPATIBLE_REVISION, selectedFrameworks, readSetup, saveSetupContext, installSelectedBackend }

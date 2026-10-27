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
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function readMctsEnvFile(home) {
  let content
  try { content = fs.readFileSync(path.join(home, '.env'), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error }
  const values = {}
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(AGENT_INSIGHT_MCTS_(?:REPO_DIR|PYTHON|TRACE_LAUNCHER))\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^#]*?))\s*(?:#.*)?$/)
    if (!match) continue
    let value = match[2] ?? match[3] ?? match[4].trim()
    if (match[2] !== undefined) {
      try { value = JSON.parse(`"${match[2]}"`) } catch {}
    }
    values[match[1]] = value
  }
  return values
}

function installationMctsConfig(home, env = process.env) {
  const file = readMctsEnvFile(home)
  let previous = {}
  try { previous = JSON.parse(fs.readFileSync(path.join(home, 'client', 'config.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('已有客户端配置无法读取，请检查 client/config.json') }
  return {
    mctsRepoDir: env.AGENT_INSIGHT_MCTS_REPO_DIR || file.AGENT_INSIGHT_MCTS_REPO_DIR || previous.mctsRepoDir || '',
    mctsPython: env.AGENT_INSIGHT_MCTS_PYTHON || file.AGENT_INSIGHT_MCTS_PYTHON || previous.mctsPython || '',
  }
}

function mctsPaths(config) {
  const repoDir = String(config.mctsRepoDir || '').trim()
  return {
    repoDir,
    python: String(config.mctsPython || '').trim() || path.join(repoDir, '.venv', 'bin', 'python'),
    traceLauncher: String(config.mctsTraceLauncher || '').trim(),
    entrypoint: path.join(repoDir, 'testcases_union', 'run_union.sh'),
    configEnv: path.join(repoDir, 'testcases_union', 'config.env'),
    main: path.join(repoDir, 'testcases_union', 'core', 'main.py'),
  }
}

function checkMctsPython(python, benchmarkKey = 'swe-bench') {
  const script = 'import sys, importlib.util; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
    + (benchmarkKey === 'swe-bench' ? '; sys.exit(0 if importlib.util.find_spec("datasets") is not None else 42)' : '')
  const result = spawnSync(python, ['-c', script], {
    encoding: 'utf8', timeout: 5_000,
  })
  if (result.error?.code === 'ETIMEDOUT') throw new Error('MCTS Python 环境检查超过 5 秒，请检查客户端负载后重试')
  if (result.error) throw new Error(`MCTS Python 无法启动（${result.error.code || '未知错误'}）`)
  if (result.status === 42) throw new Error('MCTS Python 环境中未找到 datasets，请使用该环境的 Python 安装')
  if (result.status !== 0) throw new Error(`MCTS Python 环境检查失败（${result.signal || result.status}）`)
  const version = /^([0-9]+)\.([0-9]+)$/.exec(String(result.stdout || '').trim())
  if (!version) throw new Error('MCTS Python 版本检测结果不合法')
  if (Number(version[1]) < 3 || (Number(version[1]) === 3 && Number(version[2]) < 11)) {
    throw new Error(`MCTS Python 需要 3.11+，当前版本为 ${version[0]}`)
  }
}

function checkMctsRepository(config, benchmarkKey = 'swe-bench') {
  const paths = mctsPaths(config)
  if (!path.isAbsolute(paths.repoDir) || /[\0\r\n]/.test(paths.repoDir)) throw new Error('请填写 MCTS 仓库的绝对路径')
  if (!path.isAbsolute(paths.python)) throw new Error('MCTS Python 路径必须是绝对路径')
  for (const [target, label] of [
    ...(benchmarkKey === 'swe-bench' ? [[paths.entrypoint, 'MCTS 启动脚本']] : []),
    [paths.configEnv, 'MCTS config.env'], [paths.main, 'MCTS 主程序'], [paths.python, 'MCTS Python 虚拟环境'],
  ]) {
    try { if (!fs.statSync(target).isFile()) throw new Error() }
    catch { throw new Error(`${label} 不存在`) }
  }
  if (!fs.readFileSync(paths.main, 'utf8').includes('--output-dir')) throw new Error('MCTS 未支持 --output-dir')
  checkMctsPython(paths.python, benchmarkKey)
  return paths
}

function mctsUpstream(paths, env = process.env) {
  // config.env is executable Bash, as in run_union.sh. Only the URL leaves the child shell;
  // discard its output so model credentials and tokens cannot enter installer logs.
  const result = spawnSync('bash', ['-c', 'set -e; DIR="$2"; source "$1" >/dev/null 2>&1; printf "%s" "${XGOVERNOR_BASE_URL:-http://127.0.0.1:8787}" >&3', 'mcts-config', paths.configEnv, path.dirname(paths.configEnv)], {
    cwd: paths.repoDir, env, stdio: ['ignore', 'ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 5_000,
  })
  if (result.error?.code === 'ETIMEDOUT') throw new Error('MCTS config.env 读取超过 5 秒')
  if (result.error || result.status !== 0) throw new Error('MCTS config.env 加载失败，请检查现有 MCTS 配置')
  const value = String(result.output[3] || '').trim()
  let url
  try { url = new URL(value) } catch { throw new Error('MCTS config.env 中的 xGovernor 地址不合法') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || /[\0\r\n]/.test(value)) {
    throw new Error('MCTS config.env 中的 xGovernor 地址必须为不含凭据、查询或片段的 HTTP(S) 地址')
  }
  return url.toString().replace(/\/+$/, '')
}

function mctsZsoftTasksDir(config, env = process.env) {
  const paths = mctsPaths(config)
  const result = spawnSync('bash', ['-c', 'set -e; source "$1" >/dev/null 2>&1; printf "%s" "${ZSOFT_TASKS_DIR:-}" >&3', 'mcts-zsoft-config', paths.configEnv], {
    cwd: paths.repoDir, env, stdio: ['ignore', 'ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 5_000,
  })
  if (result.error?.code === 'ETIMEDOUT') throw new Error('MCTS ZSoft 任务目录配置读取超过 5 秒')
  if (result.error || result.status !== 0) throw new Error('MCTS config.env 加载失败，请检查 ZSoft 任务目录配置')
  const tasksDir = String(result.output[3] || '').trim()
  if (!path.isAbsolute(tasksDir) || tasksDir.length > 4096 || /[\0\r\n]/.test(tasksDir)) {
    throw new Error('请在 MCTS testcases_union/config.env 中将 ZSOFT_TASKS_DIR 配置为绝对路径')
  }
  return tasksDir
}

function saveMctsRepoDir(home, repoDir, python) {
  const target = path.join(home, '.env')
  let content = ''
  try { content = fs.readFileSync(target, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const values = { AGENT_INSIGHT_MCTS_REPO_DIR: repoDir, ...(python ? { AGENT_INSIGHT_MCTS_PYTHON: python } : {}) }
  const lines = content.split(/\r?\n/).filter(line => {
    const key = /^\s*(?:export\s+)?(AGENT_INSIGHT_MCTS_\w+)\s*=/.exec(line)?.[1]
    return !Object.hasOwn(values, key || '')
  })
  while (lines.at(-1) === '') lines.pop()
  lines.push(...Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`), '')
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const temporary = `${target}.mcts-${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, lines.join('\n'), { mode: 0o600 })
    fs.renameSync(temporary, target)
  } finally { fs.rmSync(temporary, { force: true }) }
}

function shellQuote(value) { return `'${value.replace(/'/g, "'\\''")}'` }

function proxyPythonScript(python) {
  const quotedPython = shellQuote(python)
  return `#!/bin/sh\nif [ -n "\${AGENT_INSIGHT_MCTS_PROXY_URL:-}" ]; then\n  export XGOVERNOR_BASE_URL="$AGENT_INSIGHT_MCTS_PROXY_URL"\nfi\nexec ${quotedPython} "$@"\n`
}

module.exports = { readMctsEnvFile, installationMctsConfig, mctsPaths, checkMctsPython, checkMctsRepository, mctsUpstream, mctsZsoftTasksDir, saveMctsRepoDir, shellQuote, proxyPythonScript }

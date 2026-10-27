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

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadProjectConfig } = require('../../packages/project-config/index.cjs')

function bootstrapDataset({ key, name, args, describeFailure }) {
  const managedHome = process.env.AGENT_INSIGHT_HOME || path.join(os.homedir(), '.agent-insight')
  const logPath = path.join(managedHome, 'logs', `${key}-bootstrap.log`)
  let logFd
  let logReady = false
  let checkingConfig = true
  try {
    const config = loadProjectConfig('platform')
    checkingConfig = false
    if (!config.benchmarks[key].dataset.autoImport) {
      console.log(`${name} 自动导入已关闭，跳过准备。`)
      return
    }
    console.log(`Preparing ${name} dataset...`)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    logFd = fs.openSync(logPath, 'w', 0o600)
    logReady = true
    const result = spawnSync('npx', ['tsx', ...args], {
      cwd: path.resolve(__dirname, '../..'),
      env: process.env,
      stdio: ['ignore', logFd, logFd],
    })
    if (result.error) fs.writeSync(logFd, `${result.error.stack || result.error.message}\n`)
    if (result.signal) fs.writeSync(logFd, `导入进程被信号 ${result.signal} 终止\n`)
    if (result.status === 0) {
      console.log(`${name} 数据集已就绪。`)
      return
    }
    const [reason, advice] = describeFailure(fs.readFileSync(logPath, 'utf8'))
    console.warn(`⚠ ${name} 导入失败：${reason}。`)
    console.warn(`  将继续启动服务；${name} 相关实验暂不可用。`)
    console.warn(`  ${advice}`)
    console.warn(`  详细错误见：${logPath}；下次启动自动重试。`)
  } catch (error) {
    console.warn(checkingConfig ? `⚠ ${name} 导入配置无效。` : `⚠ ${name} 自动准备或日志写入失败。`)
    console.warn(`  将继续启动服务；${name} 相关实验暂不可用。`)
    console.warn(`  ${String(error.message || error).replace(/\s+/g, ' ').slice(0, 240)}`)
    console.warn(logReady
      ? `  详细错误见：${logPath}；下次启动自动重试。`
      : checkingConfig
        ? '  请修复配置文件，具体查看相关部署指南；下次启动自动重试。'
        : '  请检查日志目录的写入权限；下次启动自动重试。')
  } finally {
    if (logFd !== undefined) fs.closeSync(logFd)
  }
}

module.exports = { bootstrapDataset }

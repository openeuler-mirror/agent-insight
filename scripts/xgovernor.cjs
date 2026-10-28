#!/usr/bin/env node
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
const source = path.resolve(__dirname, '../services/executor/src/xgovernor/dependency-manager.cjs')
const installed = path.resolve(__dirname, 'executor/xgovernor/dependency-manager.cjs')
const managerPath = fs.existsSync(source) ? source : installed
const { DependencyManager } = require(managerPath)
const { installationRoot } = require(path.join(path.dirname(managerPath), 'installation.cjs'))
const { toolchainEnvironment } = require(path.join(path.dirname(managerPath), 'toolchain.cjs'))

async function run(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h') || !args.length) {
    console.log('用法：node xgovernor.cjs update [--version <tag或commit>] | status | rollback\nupdate 默认安装官方默认分支最新提交；需 Linux、Node >=22.19、Git、Cargo、npm。Docker 由执行机另行准备。')
    return
  }
  const [action, ...options] = args
  if (!['update', 'status', 'rollback'].includes(action) || options.length && !(action === 'update' && options.length === 2 && options[0] === '--version')) throw new Error('参数不合法；运行 node xgovernor.cjs --help 查看用法')
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('操作已取消'))
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    const manager = new DependencyManager({ signal: controller.signal, env: toolchainEnvironment(installationRoot()) })
    const result = action === 'update' ? await manager.update(options[1]) : action === 'rollback' ? await manager.rollback() : manager.status()
    console.log(JSON.stringify(result, null, 2))
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}

if (require.main === module) run().catch(cause => { console.error(`[xgovernor] ${cause.message}`); process.exitCode = 1 })
module.exports = { run }

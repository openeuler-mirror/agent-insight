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

const cache = new Map()
function inspectOpencodeRuntime(executable) {
  if (!executable) return { ready: false, canResolveTraceId: false, reason: '未找到 OpenCode 可执行文件' }
  let stamp
  try { const s = fs.statSync(executable); stamp = `${s.mtimeMs}:${s.size}` } catch { stamp = '' }
  const previous = cache.get(executable)
  if (previous?.stamp === stamp && Date.now() - previous.time < 30_000) return previous.result
  const options = { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 }
  const versionResult = spawnSync(executable, ['--version'], options)
  const version = String(versionResult.stdout || '').match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1]
  const major = Number(version?.split('.')[0])
  const helpResult = versionResult.status === 0 && [1, 2].includes(major)
    ? spawnSync(executable, ['run', '--help'], options) : null
  const help = `${helpResult?.stdout || ''}\n${helpResult?.stderr || ''}`
  const flags = ['--format', '--agent', '--model', '--title', ...(major === 2 ? ['--standalone', '--session'] : [])]
  const ready = helpResult?.status === 0 && flags.every(flag => help.includes(flag)) && /\bjson\b/.test(help)
  const result = { version, major, ready, canResolveTraceId: ready,
    supportsCommand: help.includes('--command'), supportsAuto: help.includes('--auto'),
    reason: ready ? undefined : `OpenCode ${version || '版本未知'} 未通过评测运行能力检查；需要可用的 run JSON、Agent、模型、会话标题${major === 2 ? '及独立服务' : ''}参数` }
  cache.set(executable, { stamp, time: Date.now(), result })
  return result
}
module.exports = { inspectOpencodeRuntime }

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

const reservedFlags = new Set(['--', '--mode', '--runtime', '--testbench', '--instance-id', '--task-id', '--split', '--output-dir', '--config', '--upstream', '--strict', '--model', '-m', '--agent', '--format', '--title', '--session', '--session-id', '--cwd', '--directory', '--port', '--hostname', '--attach', '--command', '--help', '--version'])

function validateCliFlag(value, flags = new Set()) {
  if (typeof value !== 'string' || !/^--[a-z][a-z0-9-]*$/.test(value) || reservedFlags.has(value) || flags.has(value)) {
    throw Object.assign(new TypeError(`不支持、保留或重复的启动参数：${value}`), { code: 'AGENT_OPTIONS_INVALID' })
  }
  flags.add(value)
}

function validateNativeCliKey(key, flags = new Set()) {
  const parameter = `--${key}`
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || reservedFlags.has(parameter) || flags.has(parameter)) {
    throw Object.assign(new TypeError(`不支持、保留或重复的启动参数：${parameter}`), { code: 'AGENT_OPTIONS_INVALID' })
  }
  flags.add(parameter)
  return parameter
}

module.exports = { validateCliFlag, validateNativeCliKey }

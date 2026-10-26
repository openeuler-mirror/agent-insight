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
const { createHash } = require('node:crypto')
const yaml = require('../project-config/yaml.cjs')
const { loadProjectConfig } = require('../project-config/index.cjs')
const { validateDefinition, validateValues, resolveAgentOptions } = require('./index.cjs')
const reservedFlags = new Set(['--', '--mode', '--runtime', '--testbench', '--instance-id', '--split', '--output-dir', '--config', '--upstream', '--strict', '--model', '-m', '--agent', '--format', '--title', '--session', '--session-id', '--cwd', '--directory', '--port', '--hostname', '--attach', '--command', '--help', '--version'])
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
}
function loadRuntimeDefinitions(options = {}) {
  const root = options.root || path.resolve(__dirname, '../..')
  const sourceExecutor = path.join(root, 'services', 'executor')
  const executorDir = fs.existsSync(sourceExecutor) ? sourceExecutor : path.join(root, 'executor')
  const runtimeDir = path.join(executorDir, 'runtimes')
  const overrides = loadProjectConfig('executor', { ...options, root }).runtimes
  const definitions = []
  for (const directory of fs.readdirSync(runtimeDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(runtimeDir, directory.name, 'runtime.yaml')
    try {
      const manifest = yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA })
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some(key => !['key', 'displayName', 'targets', 'parameterGroups', 'parameters', 'presets'].includes(key)) || manifest.key !== directory.name) throw new Error('Runtime Manifest 字段或 key 不合法')
      if (!Array.isArray(manifest.parameters)) throw new Error('parameters 必须为数组')
      const bindings = new Map()
      const flags = new Set()
      const parameters = manifest.parameters.map(parameter => {
        const { binding, ...field } = parameter
        if (!binding || Object.keys(binding).some(key => !['kind', 'flag', 'falseFlag'].includes(key)) || binding.kind !== 'argv') throw new Error(`${field.key}的 argv 绑定不合法`)
        if (binding.falseFlag !== undefined && field.type !== 'boolean') throw new Error('falseFlag 仅支持 boolean')
        for (const flag of [binding.flag, binding.falseFlag].filter(value => value !== undefined)) {
          if (typeof flag !== 'string' || !/^--[a-z][a-z0-9-]*$/.test(flag) || reservedFlags.has(flag) || flags.has(flag)) throw new Error(`不支持、保留或重复的启动参数：${flag}`)
          flags.add(flag)
        }
        if (!binding.flag) throw new Error('必须声明 flag')
        bindings.set(field.key, binding)
        return field
      })
      const descriptor = validateDefinition({ runtimeKey: manifest.key, displayName: manifest.displayName, definitionDigest: `sha256:${'0'.repeat(64)}`, targets: manifest.targets, parameterGroups: manifest.parameterGroups, parameters, presets: manifest.presets })
      const defaults = Object.fromEntries(Object.entries(overrides[manifest.key]?.defaults || {}).filter(([, value]) => value !== null))
      validateValues(descriptor, defaults, false)
      for (const field of descriptor.parameters) if (Object.hasOwn(defaults, field.key) && defaults[field.key] !== null) field.default = defaults[field.key]
      validateDefinition(descriptor)
      const digest = createHash('sha256').update(JSON.stringify(canonical({ descriptor, bindings: Object.fromEntries(bindings) }))).digest('hex')
      descriptor.definitionDigest = `sha256:${digest}`
      definitions.push({ descriptor, bindings })
    } catch (error) { throw new Error(`${file}: ${error.message}`) }
  }
  for (const key of Object.keys(overrides)) if (!definitions.some(item => item.descriptor.runtimeKey === key)) throw new Error(`未知 Runtime 默认值覆盖：${key}`)
  for (let i = 0; i < definitions.length; i++) for (const target of definitions[i].descriptor.targets) {
    if (definitions.slice(i + 1).some(item => item.descriptor.targets.some(other => target.platform === other.platform && (target.agent === '*' || other.agent === '*' || target.agent === other.agent)))) throw new Error(`执行目标重复：${target.platform}/${target.agent}`)
  }
  return definitions
}
function runtimeInvocationOptions(platform, agent, options, settings = {}) {
  const definitions = loadRuntimeDefinitions(settings)
  const resolved = resolveAgentOptions(definitions.map(item => item.descriptor), platform, agent, options)
  const runtime = definitions.find(item => item.descriptor === resolved.definition)
  const args = []
  if (resolved.agentOptions) for (const field of runtime.descriptor.parameters) {
    if (!Object.hasOwn(resolved.agentOptions.values, field.key)) continue
    const value = resolved.agentOptions.values[field.key]
    const binding = runtime.bindings.get(field.key)
    if (field.type === 'boolean') { const flag = value ? binding.flag : binding.falseFlag; if (flag) args.push(flag) }
    else args.push(binding.flag, String(value))
  }
  return { ...resolved, args }
}
module.exports = { loadRuntimeDefinitions, runtimeInvocationOptions }

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
const { validateDefinition, validateValues, validateExecutionValues, resolveAgentOptions, formatParameterJson } = require('./index.cjs')
const { validateSchema } = require('./parameter-json.cjs')
const { validateCliFlag: flag, validateNativeCliKey } = require('./cli-parameters.cjs')
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
}
const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`
const fail = message => { throw Object.assign(new TypeError(message), { code: 'AGENT_OPTIONS_INVALID' }) }
function configurationBinding(configuration) {
  if (configuration.version !== 2 || !['json-file', 'json-arg', 'argv'].includes(configuration.delivery)) fail('执行客户端不支持该参数交付方式')
  if (configuration.schema !== undefined) validateSchema(configuration.schema)
  const binding = configuration.binding || {}
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail('参数交付 binding 必须是对象')
  const flags = new Set()
  if (configuration.delivery === 'argv') {
    if (binding.mode === 'passthrough') {
      if (Object.keys(binding).some(key => key !== 'mode')) fail('argv passthrough binding 仅支持 mode')
      return binding
    }
    if (Object.keys(binding).some(key => key !== 'mappings') || !Array.isArray(binding.mappings)) fail('argv 必须声明 binding.mappings')
    const paths = []
    for (const item of binding.mappings) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['path', 'flag', 'falseFlag', 'encoding', 'booleanStyle', 'separator'].includes(key))) fail('argv 映射不合法')
      if (typeof item.path !== 'string' || !/^\/(?:[^~]|~[01])*$/.test(item.path)) fail('argv 映射 path 必须是非根 JSON Pointer')
      const tokens = item.path.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
      if (tokens.some(token => ['__proto__', 'constructor', 'prototype'].includes(token))) fail('argv 映射 path 不合法')
      if (paths.some(other => other === item.path || other.startsWith(`${item.path}/`) || item.path.startsWith(`${other}/`))) fail('argv 映射 path 重复或相互覆盖')
      paths.push(item.path)
      flag(item.flag, flags)
      if (item.falseFlag !== undefined) flag(item.falseFlag, flags)
      if (item.encoding !== undefined && !['json', 'repeat', 'join'].includes(item.encoding)) fail('argv 映射 encoding 不支持')
      if (item.booleanStyle !== undefined && !['value', 'switch'].includes(item.booleanStyle)) fail('argv 映射 booleanStyle 不支持')
      if (item.falseFlag !== undefined && item.booleanStyle !== 'switch') fail('falseFlag 必须配合 booleanStyle: switch')
      if (item.separator !== undefined && (typeof item.separator !== 'string' || item.separator.includes('\0') || item.encoding !== 'join')) fail('separator 仅支持 join 编码且必须是字符串')
    }
  } else {
    if (Object.keys(binding).some(key => !['flag', 'env'].includes(key))) fail('JSON 参数交付 binding 仅支持 flag / env')
    if (binding.flag !== undefined) flag(binding.flag, flags)
    if (binding.env !== undefined && (typeof binding.env !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(binding.env) || /^(?:PATH|HOME|PWD|SHELL|NODE_OPTIONS|LD_PRELOAD|PYTHONPATH)$/.test(binding.env))) fail('JSON 参数交付 env 不合法')
    if (configuration.delivery === 'json-arg' && (!binding.flag || binding.env)) fail('json-arg 必须指定 flag，且不支持 env')
  }
  return binding
}
function contractSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema
  const output = { ...schema }
  for (const key of ['title', 'description', 'default', '$schema']) delete output[key]
  if (output.properties) output.properties = Object.fromEntries(Object.entries(output.properties).map(([key, value]) => [key, contractSchema(value)]))
  if (output.items !== undefined) output.items = contractSchema(output.items)
  if (output.additionalProperties !== undefined) output.additionalProperties = contractSchema(output.additionalProperties)
  return output
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
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some(key => !['key', 'displayName', 'targets', 'parameterGroups', 'parameters', 'presets', 'configuration'].includes(key)) || manifest.key !== directory.name) throw new Error('Runtime Manifest 字段或 key 不合法')
      if (manifest.parameters !== undefined && !Array.isArray(manifest.parameters)) throw new Error('parameters 必须为数组')
      const bindings = new Map()
      const flags = new Set()
      const parameters = (manifest.parameters || []).map(parameter => {
        const { binding, ...field } = parameter
        if (!binding || Object.keys(binding).some(key => !['kind', 'flag', 'falseFlag'].includes(key)) || binding.kind !== 'argv') throw new Error(`${field.key}的 argv 绑定不合法`)
        if (binding.falseFlag !== undefined && field.type !== 'boolean') throw new Error('falseFlag 仅支持 boolean')
        flag(binding.flag, flags)
        if (binding.falseFlag !== undefined) flag(binding.falseFlag, flags)
        bindings.set(field.key, binding)
        return field
      })
      let deliveryBinding
      let configuration
      if (manifest.configuration !== undefined) {
        deliveryBinding = configurationBinding(manifest.configuration)
        configuration = { version: 2, defaults: manifest.configuration.defaults ?? {} }
      }
      const descriptor = validateDefinition({ runtimeKey: manifest.key, displayName: manifest.displayName, definitionDigest: `sha256:${'0'.repeat(64)}`, targets: manifest.targets, parameterGroups: manifest.parameterGroups || [], parameters, presets: manifest.presets || [], ...(configuration ? { configuration } : {}) })
      const override = overrides[manifest.key]?.defaults || {}
      if (configuration) {
        descriptor.configuration.defaults = validateValues(descriptor, { ...configuration.defaults, ...override })
      } else {
        const defaults = Object.fromEntries(Object.entries(override).filter(([, value]) => value !== null))
        validateValues(descriptor, defaults, false)
        for (const field of descriptor.parameters) if (Object.hasOwn(defaults, field.key)) field.default = defaults[field.key]
      }
      validateDefinition(descriptor)
      if (configuration) {
        descriptor.definitionDigest = digest({ runtimeKey: descriptor.runtimeKey, targets: descriptor.targets, version: 2, delivery: manifest.configuration.delivery, schema: contractSchema(manifest.configuration.schema), binding: deliveryBinding })
        descriptor.templateRevision = digest({ defaults: descriptor.configuration.defaults, presets: descriptor.presets })
      } else descriptor.definitionDigest = digest({ descriptor, bindings: Object.fromEntries(bindings) })
      definitions.push({ descriptor, bindings, ...(configuration ? { deliveryBinding, executionConfiguration: manifest.configuration } : {}) })
    } catch (error) { throw new Error(`${file}: ${error.message}`) }
  }
  for (const key of Object.keys(overrides)) if (!definitions.some(item => item.descriptor.runtimeKey === key)) throw new Error(`未知 Runtime 默认值覆盖：${key}`)
  for (let i = 0; i < definitions.length; i++) for (const target of definitions[i].descriptor.targets) {
    if (definitions.slice(i + 1).some(item => item.descriptor.targets.some(other => target.platform === other.platform && (target.agent === '*' || other.agent === '*' || target.agent === other.agent)))) throw new Error(`执行目标重复：${target.platform}/${target.agent}`)
  }
  return definitions
}
const pointer = (parent, key) => `${parent}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`
function passthroughArguments(values) {
  const args = []; const flags = new Set()
  for (const [key, value] of Object.entries(values)) {
    const parameter = validateNativeCliKey(key, flags)
    if (value === null || !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) fail(`${key} 仅支持有限数值、字符串或布尔值，不能拆分嵌套参数`)
    const literal = String(value)
    if (literal.includes('\0')) fail(`${key} 启动参数不能包含空字符`)
    if (literal.startsWith('-')) args.push(`${parameter}=${literal}`)
    else args.push(parameter, literal)
  }
  return args
}
function mappedArguments(values, mappings) {
  const args = []; const covered = new Set()
  function scalar(value, label) {
    if (value === null || typeof value === 'object') fail(`${label} 需要显式指定 JSON 编码`)
    const result = String(value)
    if (result.includes('\0')) fail(`${label} 启动参数不能包含空字符`)
    return result
  }
  for (const mapping of mappings) {
    const tokens = mapping.path.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
    let value = values
    let present = true
    for (const key of tokens) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) { present = false; break }
      value = value[key]
    }
    if (!present) continue
    covered.add(mapping.path)
    if (mapping.encoding === 'json') args.push(mapping.flag, JSON.stringify(value))
    else if (mapping.encoding === 'repeat' || mapping.encoding === 'join') {
      if (!Array.isArray(value)) fail(`${mapping.path} 的 ${mapping.encoding} 编码要求数组`)
      const items = value.map(item => scalar(item, mapping.path))
      if (mapping.encoding === 'repeat') { if (!items.length) fail(`${mapping.path} 空数组需要 JSON 编码`); for (const item of items) args.push(mapping.flag, item) }
      else args.push(mapping.flag, items.join(mapping.separator ?? ','))
    } else if (mapping.booleanStyle === 'switch') {
      if (typeof value !== 'boolean') fail(`${mapping.path} 的 switch 编码要求布尔值`)
      const selected = value ? mapping.flag : mapping.falseFlag
      if (selected) args.push(selected)
    } else args.push(mapping.flag, scalar(value, mapping.path))
  }
  function walk(value, current) {
    if (covered.has(current)) return
    if (value !== null && typeof value === 'object' && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) walk(child, pointer(current, key))
    } else fail(`${current || '/'} 未配置 CLI 参数映射；请在 Runtime manifest 中增加映射，或改用 JSON 交付`)
  }
  for (const [key, value] of Object.entries(values)) walk(value, pointer('', key))
  return args
}
function runtimeInvocationOptions(platform, agent, options, settings = {}) {
  const definitions = loadRuntimeDefinitions(settings)
  const resolved = resolveAgentOptions(definitions.map(item => item.descriptor), platform, agent, options)
  const runtime = definitions.find(item => item.descriptor === resolved.definition)
  const args = []; const env = {}
  let parameterFile
  if (resolved.agentOptions?.version === 2) {
    const configuration = runtime.executionConfiguration
    resolved.agentOptions.values = validateExecutionValues({ ...runtime.descriptor, configuration }, resolved.agentOptions.values)
    const binding = runtime.deliveryBinding
    const contents = formatParameterJson(resolved.agentOptions.values)
    if (configuration.delivery === 'argv') args.push(...(binding.mode === 'passthrough' ? passthroughArguments(resolved.agentOptions.values) : mappedArguments(resolved.agentOptions.values, binding.mappings)))
    else if (configuration.delivery === 'json-arg') args.push(binding.flag, contents)
    else parameterFile = { contents, ...(binding.flag ? { flag: binding.flag } : {}), env: binding.env || 'AGENT_INSIGHT_PARAMETERS_FILE' }
  } else if (resolved.agentOptions) for (const field of runtime.descriptor.parameters) {
    if (!Object.hasOwn(resolved.agentOptions.values, field.key)) continue
    const value = resolved.agentOptions.values[field.key]
    const binding = runtime.bindings.get(field.key)
    if (field.type === 'boolean') { const selected = value ? binding.flag : binding.falseFlag; if (selected) args.push(selected) }
    else args.push(binding.flag, String(value))
  }
  return { ...resolved, args, env, ...(parameterFile ? { parameterFile } : {}) }
}
function prepareRuntimeInvocation(plan, baseDir) {
  const args = [...plan.args]; const env = { ...plan.env }
  let directory
  try {
    if (plan.parameterFile) {
      const resolvedBaseDir = path.resolve(baseDir)
      fs.mkdirSync(resolvedBaseDir, { recursive: true })
      directory = fs.mkdtempSync(path.join(resolvedBaseDir, '.agent-insight-parameters-'))
      fs.chmodSync(directory, 0o700)
      const file = path.join(directory, 'parameters.json')
      fs.writeFileSync(file, plan.parameterFile.contents, { flag: 'wx', mode: 0o600 })
      if (plan.parameterFile.flag) args.push(plan.parameterFile.flag, file)
      env[plan.parameterFile.env] = file
    }
  } catch (error) { if (directory) fs.rmSync(directory, { recursive: true, force: true }); throw error }
  let cleaned = false
  return { args, env, cleanup() { if (!cleaned && directory) fs.rmSync(directory, { recursive: true, force: true }); cleaned = true } }
}
module.exports = { loadRuntimeDefinitions, runtimeInvocationOptions, prepareRuntimeInvocation }

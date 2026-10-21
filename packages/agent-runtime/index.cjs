'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const { parseParameterJson, validateParameterObject, validateSchema, formatParameterJson } = require('./parameter-json.cjs')
const { validateNativeCliKey } = require('./cli-parameters.cjs')

const own = (value, key) => Object.hasOwn(value, key)
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'command', 'shell', 'args', 'executable', 'token', 'credential', 'privatepayload'])
function fail(message, code = 'AGENT_OPTIONS_INVALID') { throw Object.assign(new TypeError(message), { code }) }
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`)
  return value
}
function keys(value, allowed, label) {
  record(value, label)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}包含未知字段：${key}`)
}
function name(value, label) {
  if (typeof value !== 'string' || !identifier.test(value) || forbidden.has(value.toLowerCase())) fail(`${label}不合法`)
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) fail(`${label}不合法`)
}
function scalar(value) { return typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) }
function fieldValue(field, value) {
  const label = field.label
  if (field.type === 'integer' && !Number.isSafeInteger(value)) fail(`${label}必须为安全整数`)
  if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) fail(`${label}必须为有限数值`)
  if (field.type === 'string' && (typeof value !== 'string' || value.includes('\0'))) fail(`${label}必须为字符串且不能包含空字符`)
  if (field.type === 'boolean' && typeof value !== 'boolean') fail(`${label}必须为布尔值`)
  if (field.type === 'enum' && !field.choices.includes(value)) fail(`${label}必须为允许的选项`)
  if (typeof value === 'number' && ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) fail(`${label}超出允许范围`)
  if (typeof value === 'string' && ((field.minLength !== undefined && value.length < field.minLength) || (field.maxLength !== undefined && value.length > field.maxLength))) fail(`${label}长度超出允许范围`)
  return value
}
function validateValues(definition, input, fillDefaults = true) {
  if (definition.configuration?.version === 2) {
    const values = validateParameterObject(input, definition.configuration.schema)
    if (definition.configuration.structure === 'flat') {
      for (const [key, value] of Object.entries(values)) {
        if (definition.configuration.delivery === 'argv') validateNativeCliKey(key)
        if (!scalar(value)) fail(`${key} 必须为有限数值、字符串或布尔值；执行端仅支持平铺参数`)
        if (typeof value === 'string' && value.includes('\0')) fail(`${key} 参数不能包含空字符`)
      }
    }
    return values
  }
  record(input, '参数值')
  const fields = new Map(definition.parameters.map(field => [field.key, field]))
  for (const key of Object.keys(input)) if (!fields.has(key)) fail(`未知的 Runtime 参数：${key}`)
  const values = {}
  for (const field of definition.parameters) {
    if (own(input, field.key)) values[field.key] = fieldValue(field, input[field.key])
    else if (fillDefaults && own(field, 'default')) values[field.key] = fieldValue(field, field.default)
    else if (fillDefaults && field.required) fail(`${field.label}不能为空`)
  }
  return values
}
function validateExecutionValues(definition, input, fillDefaults = true) {
  const values = validateValues(definition, input, fillDefaults)
  if (definition.configuration?.version === 2 && definition.configuration.structure !== 'nested'
    && Object.values(values).some(value => !scalar(value))) {
    fail('执行端未声明嵌套参数结构，仅支持平铺的字符串、数字和布尔值')
  }
  return values
}
function validateDefinition(input) {
  keys(input, ['runtimeKey', 'displayName', 'definitionDigest', 'templateRevision', 'targets', 'parameterGroups', 'parameters', 'presets', 'configuration'], 'Runtime 描述')
  name(input.runtimeKey, 'runtimeKey'); text(input.displayName, 'displayName')
  if (!/^sha256:[a-f0-9]{64}$/.test(input.definitionDigest)) fail('Runtime 定义摘要不合法')
  if (input.templateRevision !== undefined && !/^sha256:[a-f0-9]{64}$/.test(input.templateRevision)) fail('Runtime 模板摘要不合法')
  if (input.configuration !== undefined) {
    keys(input.configuration, ['version', 'defaults', 'schema', 'delivery', 'structure'], '参数配置定义')
    if (input.configuration.version !== 2 || !['json-file', 'json-arg', 'argv'].includes(input.configuration.delivery)) fail('参数配置协议或交付方式不支持')
    if (input.configuration.structure !== undefined && !['flat', 'nested'].includes(input.configuration.structure)) fail('参数配置结构仅支持 flat / nested')
    if (input.configuration.schema !== undefined) validateSchema(input.configuration.schema)
    validateValues(input, input.configuration.defaults)
  }
  for (const key of ['targets', 'parameterGroups', 'parameters', 'presets']) if (!Array.isArray(input[key]) || input[key].length > 128) fail(`${key}必须是有限数组`)
  if (!input.targets.length) fail('Runtime 必须声明执行目标')
  const targets = new Set()
  for (const target of input.targets) {
    keys(target, ['platform', 'agent'], '执行目标'); name(target.platform, 'platform')
    if (target.agent !== '*') text(target.agent, 'agent')
    const key = `${target.platform}/${target.agent}`
    if (targets.has(key)) fail('执行目标重复')
    targets.add(key)
  }
  const groups = new Set()
  for (const group of input.parameterGroups) {
    keys(group, ['key', 'label', 'description'], '参数组'); name(group.key, '参数组 key'); text(group.label, '参数组 label')
    if (groups.has(group.key)) fail('参数组 key 重复')
    if (group.description !== undefined) text(group.description, '参数组 description')
    groups.add(group.key)
  }
  const fields = new Set()
  for (const field of input.parameters) {
    keys(field, ['key', 'group', 'label', 'description', 'type', 'required', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'choices'], '参数字段')
    name(field.key, '参数 key'); text(field.label, '参数 label')
    if (fields.has(field.key)) fail('参数 key 重复')
    fields.add(field.key)
    if (!groups.has(field.group)) fail(`${field.key}参数组不存在`)
    if (!['integer', 'number', 'string', 'boolean', 'enum'].includes(field.type)) fail('参数类型不支持')
    if (field.description !== undefined) text(field.description, '参数 description')
    if (field.required !== undefined && typeof field.required !== 'boolean') fail('required 必须为布尔值')
    for (const key of ['minimum', 'maximum']) if (field[key] !== undefined && (!['integer', 'number'].includes(field.type) || typeof field[key] !== 'number' || !Number.isFinite(field[key]))) fail(`${key}必须为数值类型约束`)
    for (const key of ['minLength', 'maxLength']) if (field[key] !== undefined && (field.type !== 'string' || !Number.isSafeInteger(field[key]) || field[key] < 0)) fail(`${key}必须为非负字符串长度`)
    if (field.minimum > field.maximum || field.minLength > field.maxLength) fail('参数范围上下限冲突')
    if (field.type === 'enum') {
      if (!Array.isArray(field.choices) || !field.choices.length || field.choices.length > 128 || field.choices.some(value => !scalar(value) || (typeof value === 'string' && value.includes('\0'))) || new Set(field.choices.map(String)).size !== field.choices.length) fail('枚举选项不合法')
    } else if (field.choices !== undefined) fail('只有 enum 可以声明 choices')
    if (own(field, 'default')) fieldValue(field, field.default)
  }
  const presets = new Set()
  for (const preset of input.presets) {
    keys(preset, ['key', 'label', 'values'], '参数预设'); name(preset.key, '预设 key'); text(preset.label, '预设 label')
    if (presets.has(preset.key)) fail('预设 key 重复')
    presets.add(preset.key); validateValues(input, preset.values, false)
  }
  return JSON.parse(JSON.stringify(input))
}
function definitionsForTarget(definitions, platform, agent) {
  return definitions.filter(definition => definition.targets.some(target => target.platform === platform && (target.agent === '*' || target.agent === agent)))
}
function normalizeAgentOptions(value, definition) {
  if (value == null) return undefined
  keys(value, ['version', 'runtimeKey', 'definitionDigest', 'values'], 'Agent 参数')
  name(value.runtimeKey, 'runtimeKey')
  if (!/^sha256:[a-f0-9]{64}$/.test(value.definitionDigest)) fail('Runtime 定义摘要不合法')
  if (value.version !== undefined && value.version !== 2) fail('Agent 参数协议版本不支持', 'CLIENT_UPGRADE_REQUIRED')
  if (value.version === 2 && definition && definition.configuration?.version !== 2) fail('所选客户端不支持 JSON 参数协议，请升级客户端', 'CLIENT_UPGRADE_REQUIRED')
  if (definition?.configuration?.version === 2 && value.version !== 2) fail('Agent 参数需要 version: 2，请重新确认参数', 'AGENT_DEFINITION_CHANGED')
  record(value.values, '参数值')
  if (value.version === 2) validateParameterObject(value.values)
  else for (const [key, item] of Object.entries(value.values)) {
    name(key, '参数 key'); if (!scalar(item) || (typeof item === 'string' && item.includes('\0'))) fail('参数值必须是有限数值、字符串或布尔值')
  }
  if (definition && (value.runtimeKey !== definition.runtimeKey || value.definitionDigest !== definition.definitionDigest)) fail('执行器参数定义已变化，请刷新并重新确认参数', 'AGENT_DEFINITION_CHANGED')
  return { ...(value.version === 2 ? { version: 2 } : {}), runtimeKey: value.runtimeKey, definitionDigest: value.definitionDigest,
    values: definition ? validateValues(definition, value.values) : value.version === 2 ? validateParameterObject(value.values) : { ...value.values } }
}
function resolveAgentOptions(definitions, platform, agent, value) {
  const matches = definitionsForTarget(definitions, platform, agent)
  if (matches.length > 1) fail('执行目标匹配多个 Runtime 参数定义')
  const definition = matches[0]
  if (!definition) {
    if (value != null) fail('所选客户端未上报该执行目标的参数定义，请升级客户端', 'CLIENT_UPGRADE_REQUIRED')
    return { agentOptions: undefined, definition: undefined }
  }
  const options = value ?? { ...(definition.configuration?.version === 2 ? { version: 2 } : {}), runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest, values: definition.configuration?.defaults || {} }
  const agentOptions = definition.configuration || definition.parameters.length || value != null ? normalizeAgentOptions(options, definition) : undefined
  if (agentOptions) agentOptions.values = validateExecutionValues(definition, agentOptions.values)
  return { agentOptions, definition }
}
function optionsToInputs(definition, options) {
  if (definition.configuration?.version === 2) {
    const values = options ? normalizeAgentOptions(options, definition).values : validateValues(definition, definition.configuration.defaults)
    return { __json: formatParameterJson(values) }
  }
  const supplied = options ? normalizeAgentOptions(options) : undefined
  if (supplied && (supplied.runtimeKey !== definition.runtimeKey || supplied.definitionDigest !== definition.definitionDigest)) fail('执行器参数定义已变化，请刷新并重新确认参数', 'AGENT_DEFINITION_CHANGED')
  const values = { ...Object.fromEntries(definition.parameters.filter(field => own(field, 'default')).map(field => [field.key, field.default])),
    ...validateValues(definition, supplied?.values || {}, false) }
  return Object.fromEntries(definition.parameters.map(field => [field.key, values[field.key] === undefined ? '' : String(values[field.key])]))
}
function parseOptionInputs(definition, inputs) {
  if (definition.configuration?.version === 2) return normalizeAgentOptions({ version: 2, runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest, values: validateExecutionValues(definition, parseParameterJson(inputs.__json ?? '')) }, definition)
  const values = {}
  for (const field of definition.parameters) {
    if (!own(inputs, field.key)) continue
    const value = inputs[field.key]
    if (value === '') { if (field.required) fail(`${field.label}不能为空`); continue }
    if (field.type === 'boolean') { if (!['true', 'false'].includes(value)) fail(`${field.label}必须为布尔值`); values[field.key] = value === 'true' }
    else if (field.type === 'integer' || field.type === 'number') { if (!value.trim()) fail(`${field.label}不能为空`); values[field.key] = Number(value) }
    else if (field.type === 'enum') { const selected = field.choices.find(choice => String(choice) === value); if (selected === undefined) fail(`${field.label}必须为允许的选项`); values[field.key] = selected }
    else values[field.key] = value
  }
  return normalizeAgentOptions({ runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest, values }, definition)
}
function summarizeOptions(definition, options) {
  if (!definition || !options) return ''
  const normalized = normalizeAgentOptions(options, definition)
  if (normalized.version === 2) return JSON.stringify(normalized.values)
  return definition.parameters.filter(field => own(normalized.values, field.key)).map(field => `${field.label}：${String(normalized.values[field.key])}`).join('；')
}
module.exports = { parseParameterJson, validateParameterObject, formatParameterJson, validateDefinition, validateValues, validateExecutionValues, definitionsForTarget, normalizeAgentOptions, resolveAgentOptions, optionsToInputs, parseOptionInputs, summarizeOptions }

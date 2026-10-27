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

const MAX_BYTES = 256 * 1024
const MAX_DEPTH = 32
const MAX_NODES = 20000
const dangerous = new Set(['__proto__', 'prototype', 'constructor'])
const pointer = (path, key) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`
const fail = message => { throw Object.assign(new TypeError(message), { code: 'AGENT_OPTIONS_INVALID' }) }
const bytes = value => new TextEncoder().encode(value).length

function parseParameterJson(source) {
  if (typeof source !== 'string') fail('JSON 配置必须是文本')
  if (bytes(source) > MAX_BYTES) fail('JSON 配置不能超过 256 KiB')
  let index = 0
  let nodes = 0
  function error(message) {
    const before = source.slice(0, index)
    const lines = before.split('\n')
    fail(`${message}（第 ${lines.length} 行，第 ${lines.at(-1).length + 1} 列）`)
  }
  function space() { while (/\s/.test(source[index] || '') && index < source.length) { if (!' \t\n\r'.includes(source[index])) error('JSON 包含非法空白字符'); index++ } }
  function string() {
    const start = index++
    let escaped = false
    while (index < source.length) {
      const char = source[index++]
      if (!escaped && char === '"') {
        try { return JSON.parse(source.slice(start, index)) } catch { error('JSON 字符串不合法') }
      }
      if (!escaped && char === '\\') escaped = true
      else escaped = false
    }
    error('JSON 字符串未闭合')
  }
  function value(depth) {
    if (depth > MAX_DEPTH) error('JSON 嵌套不能超过 32 层')
    if (++nodes > MAX_NODES) error('JSON 配置节点过多')
    space()
    const char = source[index]
    if (char === '{') {
      index++; space()
      const result = {}; const seen = new Set()
      if (source[index] === '}') { index++; return result }
      while (index < source.length) {
        if (source[index] !== '"') error('JSON 对象字段名必须使用双引号')
        const key = string()
        if (seen.has(key)) error(`JSON 包含重复 key：${key}`)
        if (dangerous.has(key)) error(`不支持的参数 key：${key}`)
        seen.add(key); space()
        if (source[index++] !== ':') error('JSON 字段名后缺少冒号')
        result[key] = value(depth + 1); space()
        const separator = source[index++]
        if (separator === '}') return result
        if (separator !== ',') error('JSON 对象缺少逗号或右花括号')
        space()
      }
      error('JSON 对象未闭合')
    }
    if (char === '[') {
      index++; space()
      const result = []
      if (source[index] === ']') { index++; return result }
      while (index < source.length) {
        result.push(value(depth + 1)); space()
        const separator = source[index++]
        if (separator === ']') return result
        if (separator !== ',') error('JSON 数组缺少逗号或右方括号')
        space()
      }
      error('JSON 数组未闭合')
    }
    if (char === '"') return string()
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(token, index)) { index += token.length; return result }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))
    if (!match) error('JSON 值不合法')
    index += match[0].length
    const number = Number(match[0])
    if (!Number.isFinite(number)) error('JSON 数值必须为有限数值')
    return number
  }
  const result = value(0)
  space()
  if (index !== source.length) error('JSON 值后包含多余内容')
  return validateParameterObject(result)
}

const schemaKeys = new Set(['type', 'title', 'description', 'default', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', '$schema'])
function validateSchema(schema, depth = 0) {
  if (depth === 0) validateParameterObject({ schema })
  if (depth > MAX_DEPTH) fail('参数 Schema 嵌套过深')
  if (typeof schema === 'boolean') return
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) fail('参数 Schema 必须是对象或布尔值')
  for (const key of Object.keys(schema)) if (!schemaKeys.has(key)) fail(`不支持的参数 Schema 关键字：${key}`)
  const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type.length && schema.type.every(type => types.includes(type)) : types.includes(schema.type))) fail('参数 Schema type 不合法')
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) fail('参数 Schema properties 必须是对象')
    for (const [key, item] of Object.entries(schema.properties)) { if (dangerous.has(key)) fail(`不支持的参数 key：${key}`); validateSchema(item, depth + 1) }
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || dangerous.has(key)) || new Set(schema.required).size !== schema.required.length)) fail('参数 Schema required 不合法')
  if (schema.items !== undefined) validateSchema(schema.items, depth + 1)
  if (schema.additionalProperties !== undefined) validateSchema(schema.additionalProperties, depth + 1)
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) fail('参数 Schema enum 必须是非空数组')
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) fail(`参数 Schema ${key} 必须为有限数值`)
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) fail(`参数 Schema ${key} 必须为非负整数`)
}
function same(a, b) {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]))
}
function checkSchema(value, schema, path = '') {
  if (schema === true || schema === undefined) return
  const label = path || '/'
  if (schema === false) fail(`${label} 不允许该参数值`)
  const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matches)) fail(`${label} 类型应为 ${Array.isArray(schema.type) ? schema.type.join(' / ') : schema.type}`)
  if (schema.enum && !schema.enum.some(item => same(item, value))) fail(`${label} 必须为允许的选项`)
  if (Object.hasOwn(schema, 'const') && !same(schema.const, value)) fail(`${label} 必须为固定值`)
  if (typeof value === 'number') {
    if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) || (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)) fail(`${label} 超出允许范围`)
  }
  if (typeof value === 'string' && ((schema.minLength !== undefined && [...value].length < schema.minLength) || (schema.maxLength !== undefined && [...value].length > schema.maxLength))) fail(`${label} 长度超出允许范围`)
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) fail(`${label} 数组长度超出允许范围`)
    value.forEach((item, index) => checkSchema(item, schema.items, pointer(path, index)))
  } else if (value !== null && typeof value === 'object') {
    if ((schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) || (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties)) fail(`${label} 字段数量超出允许范围`)
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`${pointer(path, key)} 不能为空`)
    for (const [key, item] of Object.entries(value)) checkSchema(item, Object.hasOwn(schema.properties || {}, key) ? schema.properties[key] : schema.additionalProperties, pointer(path, key))
  }
}
function validateParameterObject(input, schema) {
  let nodes = 0
  const seen = new Set()
  function visit(value, path, depth) {
    if (depth > MAX_DEPTH) fail(`${path || '/'} 嵌套不能超过 32 层`)
    if (++nodes > MAX_NODES) fail('JSON 配置节点过多')
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) fail(`${path || '/'} 必须为合法 JSON 值`)
    if (seen.has(value)) fail(`${path || '/'} 不允许循环引用`)
    seen.add(value)
    let result
    if (Array.isArray(value)) {
      if (value.length > MAX_NODES - nodes) fail(`${path || '/'} 数组元素过多`)
      result = Array.from({ length: value.length }, (_, index) => visit(value[index], pointer(path, index), depth + 1))
      if (Object.keys(value).length !== value.length) fail(`${path || '/'} 数组不能包含额外属性`)
    } else {
      result = {}
      for (const key of Object.keys(value)) {
        if (dangerous.has(key)) fail(`${pointer(path, key)} 是不支持的参数 key`)
        result[key] = visit(value[key], pointer(path, key), depth + 1)
      }
    }
    seen.delete(value)
    return result
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('参数配置根节点必须是对象')
  const result = visit(input, '', 0)
  if (bytes(JSON.stringify(result)) > MAX_BYTES) fail('JSON 配置不能超过 256 KiB')
  if (schema !== undefined) { validateSchema(schema); checkSchema(result, schema) }
  return result
}
function formatParameterJson(value) {
  const normalized = validateParameterObject(value)
  const pretty = JSON.stringify(normalized, null, 2)
  return bytes(pretty) <= MAX_BYTES ? pretty : JSON.stringify(normalized)
}
module.exports = { parseParameterJson, validateParameterObject, validateSchema, formatParameterJson }

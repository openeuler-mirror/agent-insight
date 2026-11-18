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

const definitions = { xgovernor: require('./execution/xgovernor.cjs'), local: require('./execution/local.cjs') }
const LEGACY_BINDINGS = [{ benchmarks: ['swe-bench'], platforms: ['pi-agent', 'xiaoo'], profile: 'xgovernor-local-docker' }]
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const keyPattern = /^[a-z][a-z0-9-]{0,63}$/
function normalizeExecutionConfig(value = {}) {
  if (!object(value) || Object.keys(value).some(k => !['profiles', 'bindings'].includes(k))) throw new Error('执行环境包含未知字段或不是对象')
  if (value.profiles !== undefined && !object(value.profiles)) throw new Error('执行环境 profiles 必须是对象')
  const explicit = Object.values(value.profiles || {}).some(p => object(p) && p.backend !== undefined)
  const rawProfiles = explicit ? value.profiles : { 'xgovernor-local-docker': {}, ...value.profiles }
  const profiles = {}
  for (const [key, raw] of Object.entries(rawProfiles)) {
    if (!keyPattern.test(key) || !object(raw)) throw new Error('执行环境 Profile 不合法')
    const backend = raw.backend === undefined ? 'xgovernor' : raw.backend
    if (typeof backend !== 'string' || !Object.hasOwn(definitions, backend)) throw new Error(`执行后端不可用: ${backend}`)
    let options = raw
    if (raw.backend !== undefined) {
      if (Object.keys(raw).some(k => !['backend', 'options'].includes(k)) || !object(raw.options)) throw new Error('显式 Profile 只接受 backend 和 options')
      options = raw.options
    }
    profiles[key] = definitions[backend].normalize(key, options)
  }
  const bindings = value.bindings ?? (explicit ? [] : LEGACY_BINDINGS)
  if (!Array.isArray(bindings)) throw new Error('执行环境 bindings 必须为数组')
  const seen = new Set()
  for (const binding of bindings) {
    if (!object(binding) || Object.keys(binding).some(k => !['benchmarks', 'platforms', 'profile'].includes(k))
      || !keyPattern.test(binding.profile) || !profiles[binding.profile]
      || ![binding.benchmarks, binding.platforms].every(a => Array.isArray(a) && a.length && a.every(k => typeof k === 'string' && keyPattern.test(k)))) throw new Error('bindings 引用了不存在的 Profile 或选择器不合法')
    for (const benchmark of binding.benchmarks) for (const platform of binding.platforms) {
      const selector = `${benchmark}/${platform}`
      if (seen.has(selector)) throw new Error(`执行 Profile 绑定重复: ${selector}`)
      seen.add(selector)
    }
  }
  return { profiles, bindings: structuredClone(bindings) }
}
function describeProfile(key, config) {
  const backend = config.backend || 'xgovernor'
  if (!Object.hasOwn(definitions, backend)) throw new Error(`执行后端不可用: ${backend}`)
  return definitions[backend].describe(key, config)
}
module.exports = { normalizeExecutionConfig, describeProfile, LEGACY_BINDINGS }

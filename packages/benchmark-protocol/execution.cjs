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

const { createHash } = require('node:crypto')

const KEY = /^[a-z][a-z0-9-]{0,63}$/
const OCI_IMAGE = /^(?:[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/)?[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_.-]+|@sha256:[a-f0-9]{64})?$/
const DEFAULT_BINDINGS = [{ benchmarks: ['swe-bench'], platforms: ['pi-agent', 'xiaoo'], profile: 'xgovernor-local-docker' }]
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const canonical = value => JSON.stringify(sort(value))
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  return object(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : value
}
const digest = value => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
function fail(message) { throw Object.assign(new Error(message), { code: 'EXECUTION_PROFILE_INVALID' }) }
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('执行环境包含未知字段或不是对象')
}
function positive(value, maximum) { if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('执行环境资源或期限超出范围') }
function strings(value) { if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !KEY.test(item))) fail('执行环境选择器不合法') }

function validateProfile(value) {
  fields(value, ['key', 'backendKey', 'sandbox', 'sourceRevision', 'artifactDigest', 'implementationDigest', 'network', 'resources', 'timeouts', 'targets', 'models', 'definitionDigest'])
  if (!KEY.test(value.key) || !KEY.test(value.backendKey) || !KEY.test(value.sandbox)
    || !/^(?:[a-f0-9]{40}|unknown|unconfigured)$/.test(value.sourceRevision) || !/^sha256:[a-f0-9]{64}$/.test(value.implementationDigest) || !['deny', 'allow', 'client-default'].includes(value.network)
    || (value.artifactDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(value.artifactDigest))) fail('执行环境标识或隔离策略不合法')
  if (value.resources !== undefined) {
    fields(value.resources, ['cpu', 'memoryMiB', 'pids'])
    positive(value.resources.cpu, 1024); positive(value.resources.memoryMiB, 1048576); positive(value.resources.pids, 1048576)
  }
  fields(value.timeouts, ['prepareSeconds', 'cleanupSeconds'])
  positive(value.timeouts.prepareSeconds, 86400); positive(value.timeouts.cleanupSeconds, 3600)
  if (!Array.isArray(value.targets) || !value.targets.length) fail('执行环境缺少 Runtime')
  for (const target of value.targets) {
    fields(target, ['platform', 'agents'])
    if (!KEY.test(target.platform)) fail('Runtime 标识不合法')
    strings(target.agents)
  }
  if (!Array.isArray(value.models) || value.models.some(model => typeof model !== 'string' || !/^[^\s/]+\/.+$/.test(model))) fail('执行环境模型列表不合法')
  const { definitionDigest, ...description } = value
  if (definitionDigest !== digest(description)) fail('执行环境摘要不匹配')
  return structuredClone(value)
}

function validateExecution(value) {
  fields(value, ['profile', 'environment'])
  validateProfile(value.profile)
  if (value.environment?.kind === 'workspace') {
    fields(value.environment, ['kind'])
    return structuredClone(value)
  }
  fields(value.environment, ['kind', 'image', 'arch', 'workspaceRoot'])
  const env = value.environment
  if (env.kind !== 'oci-image' || !['amd64', 'arm64'].includes(env.arch)
    || typeof env.image !== 'string' || env.image.length > 512 || !OCI_IMAGE.test(env.image)
    || typeof env.workspaceRoot !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/?)+$/.test(env.workspaceRoot)) fail('执行环境镜像或目录不合法')
  return structuredClone(value)
}

function bindingFor(bindings, benchmark, platform) {
  const matches = bindings.filter(item => item.benchmarks.includes(benchmark) && item.platforms.includes(platform))
  if (matches.length > 1) throw Object.assign(new Error('执行 Profile 绑定不明确'), { code: 'EXECUTION_PROFILE_AMBIGUOUS' })
  return matches[0]
}

function createProfile(description) {
  return validateProfile({ ...description, definitionDigest: digest(description) })
}
// Compatibility exports for callers using the original flat xGovernor configuration.
function describeProfile(key, config) { return require('../project-config/execution.cjs').describeProfile(key, config) }
function normalizeExecutionConfig(value) { return require('../project-config/execution.cjs').normalizeExecutionConfig(value) }
module.exports = { bindingFor, canonical, digest, createProfile, describeProfile, normalizeExecutionConfig, validateProfile, validateExecution, DEFAULT_BINDINGS }

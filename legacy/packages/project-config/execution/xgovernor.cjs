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

function describeProfile(key, config) {
  const description = {
    key, backendKey: 'xgovernor', sandbox: 'docker', sourceRevision: config.managedRevision || (config.artifactDigest ? 'unknown' : config.sourceRevision || 'unconfigured'), network: 'deny',
    ...(config.artifactDigest ? { artifactDigest: config.artifactDigest } : {}),
    implementationDigest: digest({ server: config.serverExecutable, runtimes: config.runtimes, models: config.models, docker: config.dockerExecutable, socket: config.dockerSocket, trace: config.traceApiKeyEnv, ...(config.artifactDigest ? { artifacts: config.artifactDigest } : {}) }),
    resources: config.resources, timeouts: config.timeouts,
    targets: Object.entries(config.runtimes).map(([platform, runtime]) => ({ platform, agents: runtime.agents })),
    models: Object.keys(config.models).sort(),
  }
  return require('../../benchmark-protocol/execution.cjs').validateProfile({ ...description, definitionDigest: digest(description) })
}

function normalize(key, raw) {
    fields(raw, ['sourceRevision', 'serverExecutable', 'dockerExecutable', 'dockerSocket', 'resources', 'timeouts', 'runtimes', 'models', 'traceApiKeyEnv'])
    const config = {
      sourceRevision: null, serverExecutable: null, dockerExecutable: 'docker', dockerSocket: '/var/run/docker.sock',
      resources: { cpu: 2, memoryMiB: 4096, pids: 512 }, timeouts: { prepareSeconds: 1800, cleanupSeconds: 120 },
      models: {}, traceApiKeyEnv: 'AGENT_INSIGHT_API_KEY', ...raw,
    }
    config.resources = { cpu: 2, memoryMiB: 4096, pids: 512, ...raw.resources }
    config.timeouts = { prepareSeconds: 1800, cleanupSeconds: 120, ...raw.timeouts }
    const runtimes = raw.runtimes ?? {
      'pi-agent': { kind: 'pi', namespace: 'runtime_pi', agents: ['pi-agent'] },
      xiaoo: { kind: 'xiaoo', namespace: 'xiaoo', agents: ['defaultagent'] },
    }
    if (!object(runtimes) || !object(config.models)) fail('Runtime 和 models 必须为对象')
    config.runtimes = {}
    for (const [platform, runtime] of Object.entries(runtimes)) {
      fields(runtime, ['kind', 'namespace', 'agents', 'workerExecutable', 'workerEnvironment', 'executable', 'extensionDirectory', 'defaultModel', 'traceExporter', 'settings'])
      if (!KEY.test(platform) || !KEY.test(runtime.kind) || !/^[a-z][a-z0-9_]*$/.test(runtime.namespace)) fail('Runtime 注册不合法')
      strings(runtime.agents)
      if (runtime.workerEnvironment && !/^XGOVERNOR_[A-Z_]+_WORKER$/.test(runtime.workerEnvironment)) fail('workerEnvironment 必须为 xGovernor Worker 环境变量名')
      if (runtime.settings !== undefined && !object(runtime.settings)) fail('Runtime settings 必须是对象')
      for (const field of ['workerExecutable', 'executable', 'extensionDirectory', 'traceExporter']) {
        if (runtime[field] != null && (typeof runtime[field] !== 'string' || !runtime[field].startsWith('/') || /[\r\n]/.test(runtime[field]))) fail(`${field} 必须是绝对路径`)
      }
      config.runtimes[platform] = { ...runtime }
    }
    for (const [modelId, model] of Object.entries(config.models)) {
      fields(model, ['provider', 'model', 'api', 'apiBase', 'apiKeyEnv'])
      if (!/^[^\s/]+\/.+$/.test(modelId) || !model.provider || !model.model || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv)) fail('模型配置需提供 provider、model 和 apiKeyEnv')
      if (model.apiBase) { const url = new URL(model.apiBase); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('模型 endpoint 不合法') }
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.traceApiKeyEnv)
      || typeof config.dockerExecutable !== 'string' || !config.dockerExecutable || /[\r\n]/.test(config.dockerExecutable)
      || typeof config.dockerSocket !== 'string' || !config.dockerSocket.startsWith('/')
      || (config.serverExecutable != null && !/^\/[^\r\n]+$/.test(config.serverExecutable))) fail('执行驱动本机配置不合法')
    describeProfile(key, config)
    return { ...config, backend: 'xgovernor' }
}
module.exports = { normalize, describe: describeProfile }

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

class ExecutionBackendRegistry {
  constructor(entries = []) {
    this.backends = new Map()
    for (const [key, backend] of entries) {
      if (this.backends.has(key) || !['prepare', 'runAgent', 'collect', 'cancel', 'close', 'recover'].every(method => typeof backend[method] === 'function')) {
        throw new TypeError(`invalid or duplicate execution backend: ${key}`)
      }
      this.backends.set(key, backend)
    }
  }
  get(key) {
    const backend = this.backends.get(key)
    if (!backend) throw Object.assign(new Error(`执行后端不可用: ${key}`), { code: 'EXECUTOR_CAPABILITY_MISSING' })
    return backend
  }
}

class LocalExecutionBackend {
  constructor(components) { Object.assign(this, components) }
  validate(task) {
    if (!task.execution) return
    const { validateExecution, describeProfile, bindingFor } = require('./execution-protocol.cjs')
    const spec = validateExecution(task.execution)
    const config = this.configProvider?.() || this.executionConfig
    const binding = config && bindingFor(config.bindings, task.benchmark.key, task.agentConfig.platform)
    const local = config?.profiles[spec.profile.key]
    if (!binding || binding.profile !== spec.profile.key || local?.backend !== 'local'
      || describeProfile(spec.profile.key, local).definitionDigest !== spec.profile.definitionDigest) {
      throw Object.assign(new Error('冻结执行环境与本机配置不一致'), { code: 'EXECUTION_PROFILE_CHANGED' })
    }
    const target = spec.profile.targets.find(t => t.platform === task.agentConfig.platform)
    if (!target?.agents.includes(task.agentConfig.agent) || (task.agentConfig.model && spec.profile.models.length && !spec.profile.models.includes(task.agentConfig.model))) {
      throw Object.assign(new Error('本地 Profile 不支持所选 Agent 或模型'), { code: 'AGENT_OPTIONS_INVALID' })
    }
    if (spec.profile.backendKey !== 'local' || spec.environment.kind !== 'workspace' || spec.profile.sandbox !== 'none'
      || spec.profile.network !== 'client-default' || task.policy.network !== 'client-default' || spec.profile.resources) {
      throw Object.assign(new Error('本地执行不能兑现所选环境、网络或资源限制'), { code: 'POLICY_UNSUPPORTED' })
    }
    this.workspaceProviders.get(task.workspace.provider)
    this.agentRuntimes.get(task.agentConfig.platform)
    for (const artifact of task.submission.requiredArtifacts) this.collectors.get(artifact.collector)
  }
  async prepare(task, context) {
    this.validate(task)
    const provider = this.workspaceProviders.get(task.workspace.provider)
    const workspace = await provider.prepare(task.workspace, { ...context, benchmarkKey: task.benchmark.key, benchmarkPayload: task.task.benchmarkPayload })
    const handle = { backendKey: 'local', schemaVersion: 1, runId: context.runId, opaque: { workspace } }
    await context.persist(handle)
    const appliedPolicy = await this.policyEnforcer.apply(task.policy, context)
    handle.opaque.appliedPolicy = appliedPolicy
    await context.persist(handle)
    return handle
  }
  runAgent(handle, input, context) { return this.agentRuntimes.get(input.platform).run({ ...input, cwd: handle.opaque.workspace.path, onTraceId: context.onTraceId }) }
  collect(handle, contract, context) { return this.collectors.get(contract.collector).collect(contract, { workspace: handle.opaque.workspace, runFacts: context.runFacts }) }
  async cancel() {}
  async close(handle) {
    const result = await this.cleanupManager.cleanup(handle.opaque)
    if (handle.opaque.appliedPolicy) await this.policyEnforcer.release(handle.opaque.appliedPolicy)
    return result
  }
  async recover(record, context) {
    const handle = record.executionHandle || {
      backendKey: 'local', runId: context.runId,
      opaque: { workspace: { path: require('node:path').join(this.workspaceProviders.get(record.task.workspace.provider).rootDir, context.runId) } },
    }
    return this.close(handle)
  }
}

module.exports = { ExecutionBackendRegistry, LocalExecutionBackend }

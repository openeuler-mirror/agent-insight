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

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { inspectBenchmarkExecutionTargets } from '../src/lib/benchmark/execution-targets'
import { parseCapabilities, mergeCapabilities } from '../src/lib/reliability/client-registry'

const require = createRequire(import.meta.url)
const { normalizeExecutionConfig, describeProfile, digest, validateExecution } = require('../packages/benchmark-protocol/execution.cjs')
const { executionCapabilities } = require('../services/executor/src/execution-config.cjs')
const { LocalExecutionBackend } = require('../services/executor/src/execution-backend.cjs')
function configuration() {
  return normalizeExecutionConfig({ profiles: { native: { backend: 'local', options: { targets: [{ platform: 'pi-agent', agents: ['pi-agent'] }] } } },
    bindings: [{ benchmarks: ['fixture'], platforms: ['pi-agent'], profile: 'native' }] })
}
const runtimeProbe = () => ({ ready: true, canResolveTraceId: true })
function capability() { return executionCapabilities({ config: configuration(), runtimeProbe }) }
const row = (value: unknown) => ({ clientId: 'fixture', name: 'host', status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), unboundAt: null, capabilitiesJson: JSON.stringify(value) }) as never
const manifest = { adapterKey: 'fixture', requiredCapabilities: [] } as never

test('legacy and explicit xGovernor configuration preserve the previously frozen profile digest', () => {
  const legacy = normalizeExecutionConfig()
  assert.equal(describeProfile('xgovernor-local-docker', legacy.profiles['xgovernor-local-docker']).definitionDigest, 'sha256:73f46630ac8e8858090ba889fd1c0aed453a4ebd9683214ed4642cd363abfc02')
  const modern = normalizeExecutionConfig({ profiles: { 'xgovernor-local-docker': { backend: 'xgovernor', options: {} } }, bindings: legacy.bindings })
  assert.deepEqual(describeProfile('xgovernor-local-docker', modern.profiles['xgovernor-local-docker']), describeProfile('xgovernor-local-docker', legacy.profiles['xgovernor-local-docker']))
})

test('unknown backend, unknown backend option and ambiguous bindings are rejected', () => {
  assert.throws(() => normalizeExecutionConfig({ profiles: { bad: { backend: 'unknown', options: {} } } }), /后端不可用/)
  assert.throws(() => normalizeExecutionConfig({ profiles: { bad: { backend: 'local', options: { dockerSocket: '/tmp/docker' } } } }), /未知字段/)
  assert.throws(() => normalizeExecutionConfig({ profiles: { bad: { backend: 'xgovernor', options: { shell: 'anything' } } } }), /未知字段/)
  assert.throws(() => normalizeExecutionConfig({ profiles: { native: { backend: 'local', options: { targets: [{ platform: 'pi-agent', agents: ['pi-agent'] }] } } }, bindings: [...configuration().bindings, ...configuration().bindings] }), /绑定重复/)
})

test('local-only probe never loads xGovernor probing or checks Docker on an unsupported xGovernor OS', () => {
  const script = `const Module = require('module'); const original = Module._load;
    Module._load = function(id,...args) { if (/xgovernor\\/(profile|backend|installation|artifact-identity)/.test(id)) throw new Error('must not load xGovernor'); return original.call(this,id,...args) };
    const { executionCapabilities } = require('./services/executor/src/execution-config.cjs');
    const { normalizeExecutionConfig } = require('./packages/project-config/execution.cjs');
    const config = normalizeExecutionConfig(${JSON.stringify({ profiles: { native: { backend: 'local', options: { targets: [{ platform: 'pi-agent', agents: ['pi-agent'] }] } } }, bindings: [] })});
    const result = executionCapabilities({ config, os:'darwin', env:{}, runtimeProbe:()=>({ready:true,canResolveTraceId:true}) });
    if (!result.profiles[0].ready || result.profiles.length !== 1) process.exit(2);`
  const run = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve('.'), encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
})

test('unready xGovernor and missing native Trace do not produce false local readiness', () => {
  const config = configuration()
  config.profiles.unready = normalizeExecutionConfig().profiles['xgovernor-local-docker']
  const result = executionCapabilities({ config, os: 'darwin', env: {}, runtimeProbe })
  assert.equal(result.profiles.find((p: any) => p.profile.backendKey === 'local').ready, true)
  assert.equal(result.profiles.find((p: any) => p.profile.backendKey === 'xgovernor').ready, false)
  assert.equal(executionCapabilities({ config: configuration(), runtimeProbe: () => ({ ready: true, canResolveTraceId: false }) }).profiles[0].ready, false)
  assert.equal(executionCapabilities({ config: configuration(), runtimeProbe, nativePlatforms: [{ id: 'pi-agent', agents: ['different-agent'], models: [] }] }).profiles[0].ready, false)
})

test('default local probe reuses the native client probe and freezes Runtime version changes', () => {
  const client = require('../scripts/reliability-client.cjs')
  const previous = client.probeExperimentRuntime
  try {
    client.probeExperimentRuntime = () => ({ ready: true, canResolveTraceId: true, version: 'fixture-v1' })
    const first = executionCapabilities({ config: configuration() }).profiles[0]
    assert.equal(first.ready, true)
    client.probeExperimentRuntime = () => ({ ready: true, canResolveTraceId: true, version: 'fixture-v2' })
    assert.notEqual(executionCapabilities({ config: configuration() }).profiles[0].profile.definitionDigest, first.profile.definitionDigest)
  } finally { client.probeExperimentRuntime = previous }
})

test('local backend validates frozen binding and policy and executes through existing native lifecycle', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-profile-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cap = capability(); const profile = cap.profiles[0].profile
  const task = { benchmark: { key: 'fixture' }, task: { benchmarkPayload: {} }, execution: { profile, environment: { kind: 'workspace' } },
    workspace: { provider: 'fixture' }, policy: { network: 'client-default' }, agentConfig: { platform: 'pi-agent', agent: 'pi-agent' }, submission: { requiredArtifacts: [{ collector: 'file' }] } }
  const calls: string[] = []
  const backend = new LocalExecutionBackend({ executionConfig: cap.config,
    workspaceProviders: new Map([['fixture', { prepare: async () => { calls.push('prepare'); return { path: directory } } }]]),
    agentRuntimes: new Map([['pi-agent', { run: async ({ cwd }: any) => { calls.push('agent'); fs.writeFileSync(path.join(cwd, 'answer.txt'), 'native result'); return { traceId: 'native-trace' } } }]]),
    collectors: new Map([['file', { collect: async () => fs.readFileSync(path.join(directory, 'answer.txt'), 'utf8') }]]),
    policyEnforcer: { apply: async () => ({}), release: async () => {} }, cleanupManager: { cleanup: async () => { calls.push('cleanup'); return { status: 'succeeded' } } },
  })
  assert.doesNotThrow(() => validateExecution(task.execution))
  const context = { runId: 'fixture', persist: async () => {} }
  const handle = await backend.prepare(task, context)
  assert.equal((await backend.runAgent(handle, { platform: 'pi-agent' }, context)).traceId, 'native-trace')
  assert.equal(await backend.collect(handle, { collector: 'file' }, {}), 'native result')
  await backend.close(handle)
  assert.deepEqual(calls, ['prepare', 'agent', 'cleanup'])
  const changed = structuredClone(task); changed.execution.profile.implementationDigest = `sha256:${'a'.repeat(64)}`
  const { definitionDigest: _, ...description } = changed.execution.profile
  changed.execution.profile.definitionDigest = digest(description)
  assert.throws(() => backend.validate(changed), /冻结执行环境/)
  assert.throws(() => backend.validate({ ...task, policy: { network: 'deny' } }), /不能兑现/)
  assert.throws(() => backend.validate({ ...task, execution: { profile, environment: { kind: 'oci-image', image: 'fixture:v1', arch: 'amd64', workspaceRoot: '/app' } } }), /不能兑现/)
})

test('reported bindings override only legacy fallback and never silently downgrade a missing bound Profile', () => {
  const cap = capability()
  const common = { platforms: [{ id: 'pi-agent', agents: ['pi-agent'], models: ['provider/model'], runBenchmarkCase: { returnsTraceId: true } }], actions: ['RUN_BENCHMARK_CASE'], components: { 'execution-backend/v1': { ready: true } }, executionProfiles: cap.profiles, executionBindings: cap.config.bindings }
  assert.equal(inspectBenchmarkExecutionTargets(row(common), manifest)[0].ready, true)
  const missing = { ...common, executionProfiles: [] }
  assert.equal(inspectBenchmarkExecutionTargets(row(missing), manifest)[0].ready, false)
  assert.match(inspectBenchmarkExecutionTargets(row(missing), manifest)[0].unavailableReasons.join(' '), /执行 Profile/)
  const duplicated = { ...common, executionProfiles: [...cap.profiles, ...cap.profiles] }
  assert.equal(inspectBenchmarkExecutionTargets(row(duplicated), manifest)[0].ready, false)
  assert.match(inspectBenchmarkExecutionTargets(row(duplicated), manifest)[0].unavailableReasons.join(' '), /多个执行 Profile/)
  const parsed = parseCapabilities(JSON.stringify(common))
  assert.deepEqual(parsed.executionBindings, cap.config.bindings)
  assert.deepEqual(mergeCapabilities(parsed, { platforms: [] }).executionBindings, parsed.executionBindings)
})

test('platform registration considers all Profile readiness instead of the first unrelated failure', () => {
  const { benchmarkAgentPlatformsFromCapabilities } = require('../scripts/reliability-client.cjs')
  const cap = capability().profiles[0]
  const platforms = [{ id: 'pi-agent', runBenchmarkCase: { returnsTraceId: true } }]
  assert.deepEqual(benchmarkAgentPlatformsFromCapabilities({ platforms, executionProfiles: [{ ...cap, ready: false, targetReadiness: { 'pi-agent': { ready: false } } }, cap] }), ['pi-agent'])
})

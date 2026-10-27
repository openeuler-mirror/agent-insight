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
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  normalizeAgentOptions,
  resolveAgentOptions,
  validateDefinition,
  type AgentOptions,
} from '../packages/agent-runtime/index.cjs'
import { loadRuntimeDefinitions } from '../packages/agent-runtime/loader.cjs'
import {
  benchmarkDispatchDigest,
  canonicalJson,
  fingerprintJson,
  validateTaskEnvelope,
  type AgentTaskEnvelope,
} from '../packages/benchmark-protocol/src/contracts'
import { getBenchmarkAdapter } from '../src/lib/benchmark/adapter-registry'
import { createIsolatedDatabase } from './helpers/isolated-database'

const loadModule = createRequire(import.meta.url)
const { buildExecutionPlan, createBenchmarkExecutor } = loadModule('../services/executor/src/index.cjs')
const adapter = getBenchmarkAdapter('swe-bench')
const rawCase = {
  instance_id: 'json__fixture-1', repo: 'json/fixture', base_commit: 'a'.repeat(40),
  problem_statement: 'Repair the fixture issue', patch: 'private-gold-patch', test_patch: '',
  FAIL_TO_PASS: [], PASS_TO_PASS: [],
}

function runtimeFixture(settings?: { root: string; env: Record<string, string> }) {
  const definition = settings
    ? loadRuntimeDefinitions(settings).find(item => item.descriptor.runtimeKey === 'native-config-fixture')!.descriptor
    : validateDefinition({ runtimeKey: 'native-config-fixture', displayName: '原生配置测试 Runtime',
      definitionDigest: `sha256:${'a'.repeat(64)}`, targets: [{ platform: 'opencode', agent: 'build' }],
      parameterGroups: [], parameters: [], presets: [],
      configuration: { version: 2, structure: 'nested', defaults: {}, delivery: 'json-file' } })
  const options: AgentOptions = {
    version: 2, runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest,
    values: {
      ...definition.configuration!.defaults,
      search: { retry: { enabled: false, delays: [0, 100, null, { mode: 'adaptive' }] } },
      extension: { args: ['--business-value'], token: 'logical-token', command: 'data', shell: 'data' },
      'custom.key': { nested: [{ enabled: true }, '5', 5] },
    },
  }
  return { definition, options }
}

function taskFor(options: AgentOptions, runId = 'json_runtime_run') {
  const split = adapter.validateAndSplitCase(rawCase)
  return adapter.buildAgentTask({ publicPayload: split.publicPayload,
    runConfig: { platform: 'opencode', agent: 'build', timeoutSeconds: 60, agentOptions: options },
    context: { runId, experimentId: 'json_runtime_experiment', caseId: 'json_runtime_case' } })
}

function requestFor(task: AgentTaskEnvelope) {
  const body = { runId: task.context.runId, task, timeoutSeconds: 60,
    callbackBaseUrl: `http://127.0.0.1:3000/api/benchmark/v1/runs/${task.context.runId}` }
  return { ...body, requestDigest: benchmarkDispatchDigest(body) }
}

test('recursive JSON parameters survive task validation, executor dispatch and request persistence', async t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-json-dispatch-'))
  const root = path.join(baseDir, 'package')
  const runtimeDir = path.join(root, 'services/executor/runtimes/native-config-fixture')
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'runtime.yaml'), JSON.stringify({ key: 'native-config-fixture', displayName: 'JSON fixture',
    targets: [{ platform: 'opencode', agent: 'build' }],
    configuration: { version: 2, structure: 'nested', defaults: {}, delivery: 'json-file', binding: { env: 'AGENT_INSIGHT_PARAMETERS_FILE' } } }))
  const settings = { root, env: {} }
  const loader = loadModule('../packages/agent-runtime/loader.cjs')
  const invoke = loader.runtimeInvocationOptions
  t.mock.method(loader, 'runtimeInvocationOptions', (platform: string, agent: string, value: AgentOptions) =>
    invoke(platform, agent, value, settings))
  const { options } = runtimeFixture(settings)
  const task = taskFor(options)
  validateTaskEnvelope(task, task.context, adapter.manifest)
  const registry = { get: () => ({}) }
  assert.deepEqual(buildExecutionPlan(task, { workspaceProviders: registry, agentRuntimes: registry,
    collectors: registry }).agent.agentOptions, options)
  let executed!: (value: AgentTaskEnvelope) => void
  const execution = new Promise<AgentTaskEnvelope>(resolve => { executed = resolve })
  const executor = createBenchmarkExecutor({ clientId: 'json-client', deviceCredential: 'json-fixture',
    insightBaseUrl: 'http://127.0.0.1:3000', baseDir, agentPlatforms: ['opencode'],
    runner: { async execute(request: { task: AgentTaskEnvelope }) { executed(request.task) }, async resume() {} } })
  try {
    await executor.accept(requestFor(task))
    assert.deepEqual((await execution).agentConfig.agentOptions, options)
    const persisted = JSON.parse(fs.readFileSync(path.join(baseDir, 'benchmark-runs', task.context.runId, 'request.json'), 'utf8'))
    assert.deepEqual(persisted.task.agentConfig.agentOptions, options)
    assert.equal(JSON.stringify(persisted).includes('private-gold-patch'), false)

    const forbiddenTasks = [
      { ...task, shell: 'unexpected' },
      { ...task, task: { ...task.task, benchmarkPayload: { nested: { token: 'unexpected' } } } },
      { ...task, agentConfig: { ...task.agentConfig, extra: [{ args: ['unexpected'] }] } },
      { ...task, 'agentConfig.agentOptions.values': { command: 'unexpected' } },
    ]
    for (const invalid of forbiddenTasks) {
      assert.throws(() => validateTaskEnvelope(invalid, invalid.context, adapter.manifest), { code: 'TASK_FORBIDDEN_FIELD' })
      await assert.rejects(executor.accept(requestFor(invalid)), { code: 'TASK_FORBIDDEN_FIELD' })
    }
    const unsafeValues = JSON.parse('{"nested":{"constructor":{"prototype":{"polluted":true}}}}')
    const unsafe = { ...task, agentConfig: { ...task.agentConfig, agentOptions: { ...options, values: unsafeValues } } }
    assert.throws(() => validateTaskEnvelope(unsafe, unsafe.context, adapter.manifest), { code: 'AGENT_OPTIONS_INVALID' })
    await assert.rejects(executor.accept(requestFor(unsafe)), { code: 'AGENT_OPTIONS_INVALID' })
  } finally {
    await executor.close()
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
})

test('v2 business fields are accepted only in the validated JSON namespace and by v2 definitions', () => {
  const { definition, options } = runtimeFixture()
  assert.deepEqual(normalizeAgentOptions(options, definition), options)
  const legacyDefinition = validateDefinition({ runtimeKey: 'legacy', displayName: 'Legacy',
    definitionDigest: `sha256:${'b'.repeat(64)}`, targets: [{ platform: 'legacy', agent: '*' }],
    parameterGroups: [], parameters: [], presets: [] })
  assert.throws(() => resolveAgentOptions([legacyDefinition], 'legacy', 'build', {
    ...options, runtimeKey: legacyDefinition.runtimeKey, definitionDigest: legacyDefinition.definitionDigest,
  }), { code: 'CLIENT_UPGRADE_REQUIRED' })
  assert.throws(() => normalizeAgentOptions({ ...options, version: undefined, values: { args: 'unexpected' } }),
    { code: 'AGENT_OPTIONS_INVALID' })
  assert.throws(() => normalizeAgentOptions({ ...options, version: 3 }), { code: 'CLIENT_UPGRADE_REQUIRED' })
  assert.throws(() => normalizeAgentOptions({ ...options, values: { nested: undefined } }), { code: 'AGENT_OPTIONS_INVALID' })
})

test('platform freezes recursive parameters and retains them through details, cloning and benchmark dispatch', async t => {
  const database = createIsolatedDatabase()
  const { prisma } = await import('../src/lib/storage/prisma')
  const { POST: create } = await import('../src/app/api/experiments/route')
  const { GET: detail } = await import('../src/app/api/experiments/[id]/route')
  const { cloneExperimentFromFrozenConfig } = await import('../src/lib/engine/experiment/reuse-config')
  const { prepareNextBenchmarkCaseRun } = await import('../src/lib/benchmark/orchestrator')
  const { normalizeCapabilities } = await import('../src/lib/reliability/client-registry')
  t.after(async () => { await prisma.$disconnect(); database.dispose() })
  const { definition, options } = runtimeFixture()
  const capabilities = { actions: ['RUN_BENCHMARK_CASE'], platforms: [{ id: 'opencode', agents: ['build'],
    parameterDefinitions: [definition], runBenchmarkCase: { version: 1, returnsTraceId: true } }],
    components: { 'git-workspace/v1': true, 'git-patch/v1': true, 'agent-runtime/opencode/v1': true } }
  assert.deepEqual(normalizeCapabilities(capabilities).platforms[0].parameterDefinitions![0].configuration,
    definition.configuration)
  const split = adapter.validateAndSplitCase(rawCase)
  const catalog = await prisma.agentEvalDataset.create({ data: { id: 'json-catalog', user: 'json-user', name: 'JSON parameters', datasetKind: 'benchmark' } })
  const dataset = await prisma.benchmarkDataset.create({ data: { user: 'json-user', name: 'JSON parameters',
    agentEvalDatasetId: catalog.id, adapterKey: 'swe-bench', contentHash: 'json-fixture', caseCount: 1 } })
  await prisma.benchmarkDatasetCase.create({ data: { datasetId: dataset.id, externalCaseId: split.externalCaseId,
    ordinal: 0, rawCaseJson: canonicalJson(rawCase), sourceFingerprint: fingerprintJson(rawCase),
    publicPayloadJson: canonicalJson(split.publicPayload), privatePayloadJson: canonicalJson(split.privatePayload),
    publicFingerprint: split.publicFingerprint, privateFingerprint: split.privateFingerprint } })
  await prisma.reliabilityClient.create({ data: { clientId: 'json-platform-client', user: 'json-user', name: 'JSON client',
    hostname: 'fixture', status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), capabilitiesJson: JSON.stringify(capabilities) } })
  const response = await create(new Request('http://fixture.invalid/api/experiments', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'json-user', name: 'Recursive parameters',
      agentName: 'build', datasetId: catalog.id, traceSource: 'generate',
      executionTarget: { workerId: 'json-platform-client', platform: 'opencode', agent: 'build', agentOptions: options } }) }))
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
  const experimentId = (await response.json()).id
  const binding = await prisma.benchmarkExperimentBinding.findUniqueOrThrow({ where: { experimentId } })
  assert.deepEqual(JSON.parse(binding.runConfigJson).agentOptions, options)
  const viewResponse = await detail(new Request(`http://fixture.invalid/api/experiments/${experimentId}?user=json-user`),
    { params: Promise.resolve({ id: experimentId }) })
  assert.equal(viewResponse.status, 200)
  const view = await viewResponse.json()
  assert.deepEqual(view.executionAgentOptions, options)
  assert.deepEqual(view.executionParameterDefinition.configuration, definition.configuration)
  assert.deepEqual(view.reusableConfig.executionTarget.agentOptions, options)
  const clone = await cloneExperimentFromFrozenConfig({ sourceExperimentId: experimentId, user: 'json-user' })
  const cloneBinding = await prisma.benchmarkExperimentBinding.findUniqueOrThrow({ where: { experimentId: clone.id } })
  assert.deepEqual(JSON.parse(cloneBinding.runConfigJson).agentOptions, options)
  await prisma.experiment.update({ where: { id: experimentId }, data: { status: 'running' } })
  const prepared = await prepareNextBenchmarkCaseRun({ experimentId, callbackOrigin: 'http://fixture.invalid' })
  const run = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: prepared!.runId } })
  const dispatchedTask = JSON.parse(run.taskEnvelopeJson!)
  assert.deepEqual(dispatchedTask.agentConfig.agentOptions, options)
  validateTaskEnvelope(dispatchedTask, dispatchedTask.context, adapter.manifest)
})

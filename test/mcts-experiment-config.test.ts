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
import test from 'node:test'
import { createRequire } from 'node:module'
import { createIsolatedDatabase } from './helpers/isolated-database'
import { loadRuntimeDefinitions, runtimeInvocationOptions } from '../packages/agent-runtime/loader.cjs'
const definition = loadRuntimeDefinitions().find(item => item.descriptor.runtimeKey === 'mcts')!.descriptor

test('MCTS options survive experiment creation, details, clone, dispatch and Case retry', async t => {
  const database = createIsolatedDatabase()
  const { prisma } = await import('../src/lib/storage/prisma')
  const { POST: create } = await import('../src/app/api/experiments/route')
  const { GET: detail } = await import('../src/app/api/experiments/[id]/route')
  const { POST: retry } = await import('../src/app/api/experiments/[id]/cases/[caseId]/retry/route')
  const { cloneExperimentFromFrozenConfig } = await import('../src/lib/engine/experiment/reuse-config')
  const { prepareNextBenchmarkCaseRun } = await import('../src/lib/benchmark/orchestrator')
  const scheduler = await import('../src/lib/benchmark/scheduler')
  const { refreshBenchmarkImagePreparation } = await import('../src/lib/benchmark/image-preparation')
  const { getBenchmarkAdapter } = await import('../src/lib/benchmark/adapter-registry')
  const { canonicalJson, fingerprintJson } = await import('../packages/benchmark-protocol/src/contracts')
  const { buildExecutionPlan } = createRequire(import.meta.url)('../services/executor/src/index.cjs')
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 }))
  scheduler.setBenchmarkCommandDispatcherForTest(async () => ({ commandId: 'fixture-command', status: 'rejected' }))
  t.after(async () => {
    await refreshBenchmarkImagePreparation()
    scheduler.setBenchmarkCommandDispatcherForTest()
    await prisma.$disconnect()
    database.dispose()
  })
  const adapter = getBenchmarkAdapter('swe-bench')
  const raw = { instance_id: 'example__project-1', repo: 'example/project', base_commit: 'a'.repeat(40),
    problem_statement: 'Repair the fixture issue', patch: 'hidden-gold', test_patch: '', FAIL_TO_PASS: [], PASS_TO_PASS: [] }
  const split = adapter.validateAndSplitCase(raw)
  const catalog = await prisma.agentEvalDataset.create({ data: { id: 'options-catalog', user: 'options-user', name: 'options', datasetKind: 'benchmark' } })
  const dataset = await prisma.benchmarkDataset.create({ data: { user: 'options-user', name: 'options',
    agentEvalDatasetId: catalog.id, adapterKey: 'swe-bench', contentHash: 'options-fixture', caseCount: 1 } })
  await prisma.benchmarkDatasetCase.create({ data: { datasetId: dataset.id, externalCaseId: split.externalCaseId,
    ordinal: 0, rawCaseJson: canonicalJson(raw), sourceFingerprint: fingerprintJson(raw),
    publicPayloadJson: canonicalJson(split.publicPayload), privatePayloadJson: canonicalJson(split.privatePayload),
    publicFingerprint: split.publicFingerprint, privateFingerprint: split.privateFingerprint } })
  const options = { version: 2, runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest, values: { ...definition.configuration!.defaults, 'new-business-option': 'literal value' } }
  const capabilities = { actions: ['RUN_BENCHMARK_CASE'], platforms: [{ id: 'pi-mcts', agents: ['pi-mcts'],
    parameterDefinitions: [definition], runBenchmarkCase: { version: 1, returnsTraceId: true } }],
    components: { 'git-workspace/v1': true, 'git-patch/v1': true, 'agent-runtime/pi-mcts/v1': true } }
  await prisma.reliabilityClient.create({ data: { clientId: 'options-client', user: 'options-user', name: 'options',
    hostname: 'fixture', status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), capabilitiesJson: JSON.stringify(capabilities) } })
  const body = { user: 'options-user', name: 'MCTS options', agentName: 'mcts-coordinator', datasetId: catalog.id, agentTimeoutSeconds: 900,
    traceSource: 'generate', executionTarget: { workerId: 'options-client', platform: 'pi-mcts', agent: 'pi-mcts', agentOptions: options } }
  const response = await create(new Request('http://fixture.invalid/api/experiments', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
  const experimentId = (await response.json()).id
  const binding = await prisma.benchmarkExperimentBinding.findUniqueOrThrow({ where: { experimentId } })
  assert.deepEqual(JSON.parse(binding.runConfigJson).agentOptions, options)
  const detailResponse = await detail(new Request(`http://fixture.invalid/api/experiments/${experimentId}?user=options-user`),
    { params: Promise.resolve({ id: experimentId }) })
  assert.equal(detailResponse.status, 200)
  const view = await detailResponse.json()
  assert.deepEqual(view.executionAgentOptions, options)
  assert.deepEqual(view.executionParameterDefinition, definition)
  assert.deepEqual(JSON.parse(binding.runConfigJson).agentParameterDefinition, definition)
  assert.deepEqual(view.reusableConfig.executionTarget.agentOptions, options)
  assert.equal(view.reusableConfig.executionTarget.timeoutSeconds, 900)
  const clone = await cloneExperimentFromFrozenConfig({ sourceExperimentId: experimentId, user: 'options-user' })
  assert.deepEqual(JSON.parse((await prisma.benchmarkExperimentBinding.findUniqueOrThrow({ where: { experimentId: clone.id } })).runConfigJson).agentOptions, options)
  await prisma.experiment.update({ where: { id: experimentId }, data: { status: 'running' } })
  const prepared = await prepareNextBenchmarkCaseRun({ experimentId, callbackOrigin: 'http://fixture.invalid' })
  const run = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: prepared!.runId } })
  const task = JSON.parse(run.taskEnvelopeJson!)
  assert.deepEqual(task.agentConfig.agentOptions, options)
  const fakeRegistry = { get: () => ({}) }
  assert.deepEqual(buildExecutionPlan(task, { workspaceProviders: fakeRegistry, policyEnforcers: fakeRegistry,
    agentRuntimes: fakeRegistry, collectors: fakeRegistry }).agent.agentOptions, options)
  assert.equal(JSON.stringify(task).includes('hidden-gold'), false)
  await prisma.benchmarkCaseRun.update({ where: { id: run.id }, data: { status: 'execution_failed' } })
  await prisma.experimentEvalResult.updateMany({ where: { experimentId }, data: { status: 'failed' } })
  const retryResponse = await retry(new Request(`http://fixture.invalid/api/experiments/${experimentId}/cases/${run.experimentCaseId}/retry?user=options-user`,
    { method: 'POST' }), { params: Promise.resolve({ id: experimentId, caseId: run.experimentCaseId }) })
  assert.equal(retryResponse.status, 202, JSON.stringify(await retryResponse.clone().json()))
  const retriedId = (await retryResponse.json()).runId
  let retried
  for (let attempt = 0; attempt < 200; attempt++) {
    retried = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: retriedId } })
    if (['dispatch_failed', 'blocked'].includes(retried.status)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(retried?.status, 'dispatch_failed')
  assert.equal(retried?.retryOfRunId, run.id)
  assert.deepEqual(JSON.parse(retried!.taskEnvelopeJson!).agentConfig.agentOptions, options)

  const nestedOptions = { ...options, values: { permission: { external_directory: { '~/.agent-insight/example/**': 'allow' } },
    routes: [null, false, { label: '5' }] } }
  const nestedResponse = await create(new Request('http://fixture.invalid/api/experiments', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, name: 'MCTS independent nested draft',
      executionTarget: { ...body.executionTarget, agentOptions: nestedOptions } }) }))
  assert.equal(nestedResponse.status, 201, JSON.stringify(await nestedResponse.clone().json()))
  const nestedId = (await nestedResponse.json()).id
  const nestedBinding = await prisma.benchmarkExperimentBinding.findUniqueOrThrow({ where: { experimentId: nestedId } })
  assert.deepEqual(JSON.parse(nestedBinding.runConfigJson).agentOptions, nestedOptions)
  const nestedDetail = await detail(new Request(`http://fixture.invalid/api/experiments/${nestedId}?user=options-user`),
    { params: Promise.resolve({ id: nestedId }) })
  assert.deepEqual((await nestedDetail.json()).executionAgentOptions, nestedOptions)
  await prisma.experiment.update({ where: { id: nestedId }, data: { status: 'running' } })
  const nestedPrepared = await prepareNextBenchmarkCaseRun({ experimentId: nestedId, callbackOrigin: 'http://fixture.invalid' })
  const nestedRun = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: nestedPrepared!.runId } })
  const nestedTask = JSON.parse(nestedRun.taskEnvelopeJson!)
  assert.deepEqual(nestedTask.agentConfig.agentOptions, nestedOptions)
  assert.deepEqual(buildExecutionPlan(nestedTask, { workspaceProviders: fakeRegistry, policyEnforcers: fakeRegistry,
    agentRuntimes: fakeRegistry, collectors: fakeRegistry }).agent.agentOptions, nestedOptions)
  assert.throws(() => runtimeInvocationOptions(nestedTask.agentConfig.platform, nestedTask.agentConfig.agent,
    nestedTask.agentConfig.agentOptions), /不能拆分嵌套参数/)
  assert.deepEqual(nestedTask.agentConfig.agentOptions, nestedOptions)
  assert.equal((await prisma.benchmarkExperimentBinding.findUniqueOrThrow({ where: { experimentId: nestedId } })).runConfigJson, nestedBinding.runConfigJson)

  await prisma.reliabilityClient.update({ where: { clientId: 'options-client' }, data: { capabilitiesJson: JSON.stringify({
    ...capabilities, platforms: [{ ...capabilities.platforms[0], runBenchmarkCase: { version: 1, returnsTraceId: true }, parameterDefinitions: [] }],
  }) } })
  await prisma.experiment.update({ where: { id: clone.id }, data: { status: 'running' } })
  await assert.rejects(prepareNextBenchmarkCaseRun({ experimentId: clone.id, callbackOrigin: 'http://fixture.invalid' }), { code: 'CLIENT_UPGRADE_REQUIRED' })
})

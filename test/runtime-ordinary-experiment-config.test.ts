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
import { createIsolatedDatabase } from './helpers/isolated-database'
import { validateDefinition } from '../packages/agent-runtime/index.cjs'

test('ordinary runtime parameters are frozen, dispatched, displayed, cloned and retained by retries', async t => {
  const database = createIsolatedDatabase()
  const { prisma } = await import('../src/lib/storage/prisma')
  const { POST: create } = await import('../src/app/api/experiments/route')
  const { GET: detail } = await import('../src/app/api/experiments/[id]/route')
  const { generateExperimentTraces, loadTraceGenerationRetryRequest, assertTraceGenerationTarget } = await import('../src/lib/engine/experiment/trace-generation')
  const { cloneExperimentFromFrozenConfig } = await import('../src/lib/engine/experiment/reuse-config')
  const definition = validateDefinition({ runtimeKey: 'opencode', displayName: 'OpenCode', definitionDigest: `sha256:${'a'.repeat(64)}`,
    targets: [{ platform: 'opencode', agent: '*' }], parameterGroups: [{ key: 'execution', label: '执行参数' }],
    parameters: [{ key: 'steps', group: 'execution', label: '轮数', type: 'integer', minimum: 1, default: 10 }], presets: [] })
  const options = { runtimeKey: 'opencode', definitionDigest: definition.definitionDigest, values: { steps: 4 } }
  t.after(async () => { await prisma.$disconnect(); database.dispose() })
  await prisma.reliabilityClient.create({ data: { clientId: 'ordinary-options-client', user: 'ordinary-options', name: 'options',
    status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), capabilitiesJson: JSON.stringify({
      platforms: [{ id: 'opencode', agents: ['build'], parameterDefinitions: [definition],
        runExperimentCase: { version: 2, returnsTraceId: true }, actions: ['RUN_EXPERIMENT_CASE'] }], actions: ['RUN_EXPERIMENT_CASE'],
    }) } })
  const body = { user: 'ordinary-options', name: 'runtime parameters', agentName: 'build', traceSource: 'generate',
    evaluatorIds: ['preset-agent-trace-quality'], cases: [{ input: 'fixture', actualOutput: '' }],
    configSnapshot: { traceSource: 'generate', agentName: 'build', executionTarget: { timeoutSeconds: 60 } },
    executionTarget: { workerId: 'ordinary-options-client', platform: 'opencode', agent: 'build', agentOptions: options } }
  const submit = (value: unknown) => create(new Request('http://fixture.invalid/api/experiments', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }))
  const response = await submit(body)
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  const experimentId = (await response.json()).id
  const experiment = await prisma.experiment.findUniqueOrThrow({ where: { id: experimentId }, include: { cases: true } })
  const snapshot = JSON.parse(experiment.configSnapshotJson!)
  assert.deepEqual(snapshot.executionTarget.agentOptions, options)
  assert.deepEqual(snapshot.executionTarget.agentParameterDefinition, definition)
  assert.equal(snapshot.executionTarget.timeoutSeconds, 60)
  const view = await (await detail(new Request(`http://fixture.invalid/api/experiments/${experimentId}?user=ordinary-options`),
    { params: Promise.resolve({ id: experimentId }) })).json()
  assert.deepEqual(view.executionAgentOptions, options)
  assert.deepEqual(view.executionParameterDefinition, definition)
  const clone = await cloneExperimentFromFrozenConfig({ sourceExperimentId: experimentId, user: 'ordinary-options' })
  assert.deepEqual(JSON.parse((await prisma.experiment.findUniqueOrThrow({ where: { id: clone.id } })).configSnapshotJson!).executionTarget.agentOptions, options)
  const invalid = await submit({ ...body, executionTarget: { ...body.executionTarget, agentOptions: { mcts: { maxIters: 2 } } } })
  assert.equal(invalid.status, 400)
  await prisma.experiment.update({ where: { id: experimentId }, data: { status: 'running' } })
  const controller = new AbortController()
  const work = generateExperimentTraces({ user: 'ordinary-options', experimentId, workerId: 'ordinary-options-client',
    platform: 'opencode', agent: 'build', agentOptions: options, timeoutSeconds: 60, signal: controller.signal,
    cases: experiment.cases.map((row: { id: string; input: string }) => ({ caseId: row.id, input: row.input })) })
  try {
    let command
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      command = await prisma.reliabilityCommand.findFirst({ where: { clientId: 'ordinary-options-client', action: 'RUN_EXPERIMENT_CASE' } })
      if (command) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(command)
    assert.deepEqual(JSON.parse(command.payloadJson).agentOptions, options)
    await prisma.reliabilityCommand.update({ where: { commandId: command.commandId }, data: { status: 'FAILED', errorCode: 'AGENT_DEFINITION_CHANGED' } })
    assert.equal((await work).failedCaseIds.length, 1)
    assert.equal(await prisma.experimentTraceAttempt.count({ where: { experimentId } }), 1)
    const retry = await loadTraceGenerationRetryRequest({ user: 'ordinary-options', experimentId, caseId: experiment.cases[0].id })
    assert.deepEqual(retry!.agentOptions, options)
    await assert.rejects(assertTraceGenerationTarget({ ...retry!, agentOptions: { ...options, definitionDigest: `sha256:${'b'.repeat(64)}` } }), { code: 'AGENT_DEFINITION_CHANGED' })
  } finally { controller.abort(); await work.catch(() => undefined) }
})

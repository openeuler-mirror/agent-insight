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
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizeAgentOptions, optionsToInputs, validateDefinition, type AgentOptions } from '../packages/agent-runtime/index.cjs'
import { loadRuntimeDefinitions } from '../packages/agent-runtime/loader.cjs'
import { proposeOptionMigration } from '../packages/agent-runtime/option-migration.cjs'
import { RuntimeOptionMigration } from '../src/components/eval/RuntimeOptionMigration'
import { RuntimeParameterSnapshot } from '../src/components/eval/RuntimeParameterSnapshot'
import { readSavedDefinition, runtimeOptionsState, savedOptionsToInputs } from '../src/lib/engine/experiment/runtime-options'
import { createIsolatedDatabase } from './helpers/isolated-database'

const current = loadRuntimeDefinitions().find(item => item.descriptor.runtimeKey === 'mcts')!.descriptor
const legacy = validateDefinition({
  runtimeKey: 'mcts', displayName: 'MCTS', definitionDigest: `sha256:${'a'.repeat(64)}`,
  targets: [{ platform: 'pi-mcts', agent: 'pi-mcts' }], parameterGroups: [{ key: 'search', label: '搜索' }],
  parameters: [
    { key: 'maxIters', label: '迭代', group: 'search', type: 'integer', default: 5 },
    { key: 'branching', label: '分支', group: 'search', type: 'integer', default: 3 },
    { key: 'tokenFuseLimit', label: '阈值', group: 'search', type: 'integer', default: 30000000 },
  ], presets: [],
})
const target = { platform: 'pi-mcts', agent: 'pi-mcts', parameterDefinitions: [current] }

test('historical configurations require confirmation of the original values without field-name conversion', () => {
  const saved: AgentOptions = { runtimeKey: 'mcts', definitionDigest: legacy.definitionDigest, values: { maxIters: 1, branching: 1, tokenFuseLimit: 0 } }
  const frozen = JSON.stringify({ agentParameterDefinition: legacy, agentOptions: saved })
  const inputs = savedOptionsToInputs(saved)
  const before = runtimeOptionsState(target, inputs, 'host', 'host', saved, legacy)
  assert.equal(before.agentOptions, undefined)
  assert.match(before.error!, /确认原配置/)
  assert.deepEqual(JSON.parse(before.inputs.__json), saved.values)
  assert.deepEqual(before.migration!.options.values, saved.values)
  const preview = renderToStaticMarkup(createElement(RuntimeOptionMigration, { migration: before.migration!, onConfirm() {} }))
  assert.match(preview, /确认原配置并用于新实验/)
  assert.match(preview, /原实验快照不变/)
  const confirmed = runtimeOptionsState(target, optionsToInputs(current, before.migration!.options), 'host', 'host')
  assert.equal(confirmed.error, null)
  assert.deepEqual(confirmed.agentOptions?.values, before.migration!.options.values)
  assert.equal(confirmed.migration, undefined)
  assert.equal(JSON.stringify({ agentParameterDefinition: legacy, agentOptions: saved }), frozen)
  assert.deepEqual(normalizeAgentOptions(saved, legacy), saved)
  assert.equal(readSavedDefinition(legacy)?.definitionDigest, legacy.definitionDigest)
})

test('v2 historical scalar snapshots retain deletions and old names in the details view', () => {
  const prior = validateDefinition({ ...legacy,
    configuration: { version: 2, delivery: 'argv', defaults: { maxIters: 5, branching: 3, tokenFuseLimit: 30000000 } },
  })
  const saved: AgentOptions = { version: 2, runtimeKey: 'mcts', definitionDigest: prior.definitionDigest, values: { maxIters: 2, tokenFuseLimit: 0 } }
  const proposal = proposeOptionMigration(prior, current, saved)!
  assert.deepEqual(proposal.options.values, saved.values)
  const rendered = renderToStaticMarkup(createElement(RuntimeParameterSnapshot, { definition: prior, options: saved }))
  assert.match(rendered, /maxIters/)
  assert.doesNotMatch(rendered, /max-iters/)
  assert.equal(Object.hasOwn(proposal.options.values, 'branching'), false)
})

test('confirmation is generic across runtimes and never guesses aliases, flattens objects or merges fields', () => {
  const saved = { version: 2 as const, runtimeKey: 'mcts', definitionDigest: legacy.definitionDigest,
    values: { maxIters: 1, 'max-iters': 2, solver: { rows: [false, null] }, mode: 'business-data' } }
  const proposal = proposeOptionMigration(legacy, current, saved)!
  assert.deepEqual(proposal.options.values, saved.values)
  for (const candidate of [{ ...saved, definitionDigest: `sha256:${'b'.repeat(64)}` }, { ...saved, runtimeKey: 'other' }]) {
    assert.equal(proposeOptionMigration(legacy, current, candidate), undefined)
  }
  assert.equal(proposeOptionMigration(undefined, current, saved), undefined)
  const otherCurrent = { ...current, runtimeKey: 'other' }
  const otherLegacy = { ...legacy, runtimeKey: 'other' }
  assert.deepEqual(proposeOptionMigration(otherLegacy, otherCurrent, { ...saved, runtimeKey: 'other' })!.options.values, saved.values)
  assert.equal(readSavedDefinition({ runtimeKey: 'mcts' }), undefined)
})

test('historical experiment API still displays its frozen names and reading or previewing reuse never rewrites stored snapshots', async t => {
  const database = createIsolatedDatabase()
  const { prisma } = await import('../src/lib/storage/prisma')
  const { GET } = await import('../src/app/api/experiments/[id]/route')
  t.after(async () => { await prisma.$disconnect(); database.dispose() })
  const saved: AgentOptions = { runtimeKey: 'mcts', definitionDigest: legacy.definitionDigest,
    values: { maxIters: 1, branching: 1, tokenFuseLimit: 0 } }
  const frozen = JSON.stringify({ traceSource: 'generate', executionTarget: {
    workerId: 'historical-client', platform: 'pi-mcts', agent: 'pi-mcts',
    agentOptions: saved, agentParameterDefinition: legacy,
  } })
  const experiment = await prisma.experiment.create({ data: { user: 'history-parameters', name: 'Historical parameters',
    agentName: 'mcts-coordinator', type: 'single', evaluatorIdsJson: '[]', configSnapshotJson: frozen } })
  const response = await GET(new Request(`http://fixture.invalid/api/experiments/${experiment.id}?user=history-parameters`),
    { params: Promise.resolve({ id: experiment.id }) })
  assert.equal(response.status, 200)
  const detail = await response.json()
  assert.deepEqual(detail.executionAgentOptions, saved)
  assert.deepEqual(detail.executionParameterDefinition, legacy)
  const reused = detail.reusableConfig.executionTarget
  const state = runtimeOptionsState(target, savedOptionsToInputs(reused.agentOptions), 'host', 'host', reused.agentOptions,
    readSavedDefinition(detail.executionParameterDefinition))
  assert.equal(state.agentOptions, undefined)
  assert.ok(state.migration)
  assert.deepEqual(state.migration.options.values, saved.values)
  assert.equal((await prisma.experiment.findUniqueOrThrow({ where: { id: experiment.id } })).configSnapshotJson, frozen)
})

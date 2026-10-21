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

test('historical alias conversion is previewed and requires explicit confirmation without modifying the original snapshot', () => {
  const saved: AgentOptions = { runtimeKey: 'mcts', definitionDigest: legacy.definitionDigest, values: { maxIters: 1, branching: 1, tokenFuseLimit: 0 } }
  const frozen = JSON.stringify({ agentParameterDefinition: legacy, agentOptions: saved })
  const inputs = savedOptionsToInputs(saved)
  const before = runtimeOptionsState(target, inputs, 'host', 'host', saved, legacy)
  assert.equal(before.agentOptions, undefined)
  assert.match(before.error!, /预览.*确认/)
  assert.deepEqual(JSON.parse(before.inputs.__json), saved.values)
  assert.deepEqual(before.migration!.options.values, { 'max-iters': 1, branching: 1, 'token-fuse-limit': 0 })
  assert.deepEqual(before.migration!.changes.map(change => [change.from, change.to]), [
    ['maxIters', 'max-iters'], ['tokenFuseLimit', 'token-fuse-limit'],
  ])
  const preview = renderToStaticMarkup(createElement(RuntimeOptionMigration, { migration: before.migration!, onConfirm() {} }))
  assert.match(preview, /确认转换并用于新实验/)
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
  assert.deepEqual(proposal.options.values, { 'max-iters': 2, 'token-fuse-limit': 0 })
  const rendered = renderToStaticMarkup(createElement(RuntimeParameterSnapshot, { definition: prior, options: saved }))
  assert.match(rendered, /maxIters/)
  assert.doesNotMatch(rendered, /max-iters/)
  assert.equal(Object.hasOwn(proposal.options.values, 'branching'), false)
})

test('conversion only recognizes declared historical aliases and never flattens native objects or merges conflicting names', () => {
  const saved = { version: 2 as const, runtimeKey: 'mcts', definitionDigest: legacy.definitionDigest,
    values: { maxIters: 1 } }
  const prior = validateDefinition({ ...legacy, configuration: { version: 2, delivery: 'argv', defaults: {} } })
  for (const options of [
    { ...saved, values: { maxIters: 1, 'max-iters': 2 } },
    { ...saved, values: { maxIters: 1, solver: { turns: 2 } } },
    { ...saved, values: { maxIters: 1, mode: 'override' } },
    { ...saved, values: { 'max-iters': 1 } },
    { ...saved, definitionDigest: `sha256:${'b'.repeat(64)}` },
    { ...saved, runtimeKey: 'opencode' },
  ]) assert.equal(proposeOptionMigration(prior, current, options), undefined)
  assert.equal(proposeOptionMigration(undefined, current, saved), undefined)
  assert.equal(proposeOptionMigration({ ...legacy, parameters: [] }, current, saved), undefined)
  const originalNames = proposeOptionMigration(prior, current, { ...saved,
    values: { maxIters: 1, myPrivateKey: 2, native_key: 3, 'plugin.retry': 4 } })!
  assert.deepEqual(originalNames.options.values, { 'max-iters': 1, myPrivateKey: 2, native_key: 3, 'plugin.retry': 4 })
  assert.deepEqual(originalNames.changes.map(change => change.from), ['maxIters'])
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
  assert.deepEqual(state.migration.options.values, { 'max-iters': 1, branching: 1, 'token-fuse-limit': 0 })
  assert.equal((await prisma.experiment.findUniqueOrThrow({ where: { id: experiment.id } })).configSnapshotJson, frozen)
})

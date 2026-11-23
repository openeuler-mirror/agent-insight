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
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeAgentOptions, optionsToInputs, parseOptionInputs, validateDefinition, validateValues, type JsonObject } from '../packages/agent-runtime/index.cjs'
import { loadRuntimeDefinitions, prepareRuntimeInvocation, runtimeInvocationOptions } from '../packages/agent-runtime/loader.cjs'

function fixture(t: test.TestContext, configuration: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-native-argv-'))
  const directory = path.join(root, 'services/executor/runtimes/native')
  fs.mkdirSync(directory, { recursive: true })
  const manifest = { key: 'native', displayName: 'Native', targets: [{ platform: 'native', agent: '*' }],
    parameters: [], parameterGroups: [], presets: [],
    configuration: { version: 2, delivery: 'argv', structure: 'flat', defaults: {}, binding: { mode: 'passthrough' }, ...configuration } }
  const file = path.join(directory, 'runtime.yaml')
  fs.writeFileSync(file, JSON.stringify(manifest))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const settings = { root, env: {} }
  return { root, settings, file, manifest }
}

test('MCTS advertises flat CLI-native defaults and new parameters need no mapping or schema edit', () => {
  const runtime = loadRuntimeDefinitions().find(item => item.descriptor.runtimeKey === 'mcts')!
  const definition = runtime.descriptor
  assert.equal(definition.configuration?.structure, undefined)
  assert.equal(definition.configuration?.schema, undefined)
  assert.equal(definition.configuration?.delivery, undefined)
  assert.deepEqual(runtime.deliveryBinding, { mode: 'passthrough' })
  assert.deepEqual(definition.parameters, [])
  assert.deepEqual(Object.keys(definition.configuration!.defaults), ['max-iters', 'branching', 'max-turns-init', 'max-turns-step', 'max-turns-author', 'max-turns-author-step', 'token-fuse-limit'])
  const values = { 'future-runtime-option': 7, branching: 0 + 1 }
  const options = { version: 2 as const, runtimeKey: 'mcts', definitionDigest: definition.definitionDigest, values }
  for (const target of definition.targets) {
    const plan = runtimeInvocationOptions(target.platform, target.agent, options)
    assert.deepEqual(plan.args, ['--future-runtime-option', '7', '--branching', '1'])
    assert.deepEqual(plan.agentOptions?.values, values)
  }
  assert.deepEqual(parseOptionInputs(definition, optionsToInputs(definition, options)), options)
  assert.equal(JSON.stringify(definition).includes('binding'), false)
})

test('native argv preserves scalar values, empty strings and literal values without interpreting shell text', t => {
  const { settings } = fixture(t)
  const definition = loadRuntimeDefinitions(settings)[0].descriptor
  const values = { count: 0, enabled: false, 'empty-value': '', label: 'a b;$(touch unsafe)', 'numeric-text': '05' }
  const plan = runtimeInvocationOptions('native', 'agent', { version: 2, runtimeKey: 'native', definitionDigest: definition.definitionDigest, values }, settings)
  assert.deepEqual(plan.args, ['--count', '0', '--enabled', 'false', '--empty-value', '', '--label', 'a b;$(touch unsafe)', '--numeric-text', '05'])
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...plan.args], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), plan.args)
  assert.deepEqual(plan.agentOptions?.values, values)
})

test('native argv preserves camelCase, snake_case and dotted CLI keys without renaming or splitting', t => {
  const { settings } = fixture(t)
  const definition = loadRuntimeDefinitions(settings)[0].descriptor
  const values = { futureOption: 5, future_option: false, 'plugin.retry': 2 }
  const options = { version: 2 as const, runtimeKey: 'native', definitionDigest: definition.definitionDigest, values }
  assert.deepEqual(normalizeAgentOptions(options, definition)?.values, values)
  assert.deepEqual(parseOptionInputs(definition, { __json: JSON.stringify(values) }).values, values)
  assert.deepEqual(runtimeInvocationOptions('native', 'agent', options, settings).args, ['--futureOption', '5', '--future_option', 'false', '--plugin.retry', '2'])
})

test('native values beginning with a dash remain bound to their own key', t => {
  const { settings } = fixture(t)
  const definition = loadRuntimeDefinitions(settings)[0].descriptor
  const plan = runtimeInvocationOptions('native', 'agent', { version: 2, runtimeKey: 'native', definitionDigest: definition.definitionDigest,
    values: { label: '--mode', delta: -5, 'other-label': '-x=1' } }, settings)
  assert.deepEqual(plan.args, ['--label=--mode', '--delta=-5', '--other-label=-x=1'])
  assert.equal(plan.args.includes('--mode'), false)
})

test('platform preserves nested drafts while the native argv client rejects unsupported final values', t => {
  const { settings, file, manifest } = fixture(t)
  const definition = loadRuntimeDefinitions(settings)[0].descriptor
  for (const values of [{ search: { count: 1 } }, { rows: [1] }, { optional: null }] as JsonObject[]) {
    const options = { version: 2 as const, runtimeKey: 'native', definitionDigest: definition.definitionDigest, values }
    assert.deepEqual(validateValues(definition, values), values)
    assert.deepEqual(normalizeAgentOptions(options, definition)?.values, values)
    assert.deepEqual(parseOptionInputs(definition, { __json: JSON.stringify(values) }).values, values)
    assert.throws(() => runtimeInvocationOptions('native', 'agent', options, settings), /不能拆分嵌套参数/)
    assert.deepEqual(validateDefinition({ ...definition, configuration: { ...definition.configuration!, defaults: values } }).configuration!.defaults, values)
  }
  fs.writeFileSync(file, JSON.stringify({ ...manifest, configuration: { ...manifest.configuration, defaults: { nested: {} } } }))
  assert.deepEqual(loadRuntimeDefinitions(settings)[0].descriptor.configuration!.defaults, { nested: {} })
  assert.throws(() => runtimeInvocationOptions('native', 'agent', undefined, settings), /不能拆分嵌套参数/)
})

test('native argv rejects reserved context flags and never renames invalid keys', t => {
  const { settings } = fixture(t)
  const definition = loadRuntimeDefinitions(settings)[0].descriptor
  const options = (values: JsonObject) => ({ version: 2 as const, runtimeKey: 'native', definitionDigest: definition.definitionDigest, values })
  const invoke = (values: JsonObject) => runtimeInvocationOptions('native', 'agent', options(values), settings)
  for (const key of ['mode', 'runtime', 'testbench', 'instance-id', 'task-id', 'split', 'output-dir', 'model', 'config', 'command', 'help', 'version']) {
    assert.throws(() => invoke({ [key]: 'override' }), /保留/)
    assert.deepEqual(normalizeAgentOptions(options({ [key]: 'override' }), definition)?.values, { [key]: 'override' })
    assert.deepEqual(parseOptionInputs(definition, { __json: JSON.stringify({ [key]: 'override' }) }).values, { [key]: 'override' })
  }
  for (const key of ['--max-iters', 'max-iters=value', 'space key', '', '-x', 'count\0', '.count', '_count', 'line\nkey']) {
    assert.throws(() => invoke({ [key]: 1 }), /启动参数/)
    assert.deepEqual(normalizeAgentOptions(options({ [key]: 1 }), definition)?.values, { [key]: 1 })
    assert.deepEqual(validateValues(definition, { [key]: 1 }), { [key]: 1 })
  }
  assert.throws(() => invoke({ label: 'a\0b' }), /空字符/)
  assert.deepEqual(normalizeAgentOptions(options({ label: 'a\0b' }), definition)?.values, { label: 'a\0b' })
  assert.deepEqual(invoke({}).args, [])
})

test('flat JSON channels preserve native keys without imposing CLI naming or reserved flags', t => {
  const values = { camelCase: 1, snake_case: false, 'native.key': '', mode: 'business-value' }
  const { settings } = fixture(t, { delivery: 'json-file', defaults: values, binding: {} })
  const definition = loadRuntimeDefinitions(settings)[0].descriptor
  assert.deepEqual(validateValues(definition, values), values)
  assert.deepEqual(parseOptionInputs(definition, { __json: JSON.stringify(values) }).values, values)
  assert.deepEqual(JSON.parse(runtimeInvocationOptions('native', 'agent', undefined, settings).parameterFile!.contents), values)
})

test('passthrough has no structure declaration requirement and cannot also declare mappings', t => {
  const { settings, file, manifest } = fixture(t)
  for (const structure of [undefined, 'nested', 'flat']) {
    fs.writeFileSync(file, JSON.stringify({ ...manifest, configuration: { ...manifest.configuration, structure } }))
    assert.deepEqual(loadRuntimeDefinitions(settings)[0].descriptor.configuration, { version: 2, defaults: {} })
  }
  fs.writeFileSync(file, JSON.stringify({ ...manifest, configuration: { ...manifest.configuration, binding: { mode: 'passthrough', mappings: [] } } }))
  assert.throws(() => loadRuntimeDefinitions(settings), /passthrough/)
})

test('declared nested JSON channel keeps native keys, arrays and depth unchanged', t => {
  const values = { plugin: { 'native.key': [{ 'retry_count': 2, enabled: false }, null] }, 'existing-name': 'value' }
  const { settings, root } = fixture(t, { structure: 'nested', delivery: 'json-file', defaults: values, binding: { env: 'NATIVE_CONFIG_FILE' } })
  const descriptor = loadRuntimeDefinitions(settings)[0].descriptor
  const plan = runtimeInvocationOptions('native', 'agent', undefined, settings)
  const prepared = prepareRuntimeInvocation(plan, root)
  try {
    assert.deepEqual(plan.agentOptions?.values, values)
    assert.deepEqual(plan.args, [])
    assert.deepEqual(JSON.parse(fs.readFileSync(prepared.env.NATIVE_CONFIG_FILE, 'utf8')), values)
    const flat = { ...descriptor, configuration: { ...descriptor.configuration!, structure: 'flat' as const, defaults: {} } }
    assert.deepEqual(validateValues(flat, values), values)
  } finally { prepared.cleanup() }
})

test('structure declarations do not affect contracts while default-only updates change the template revision', t => {
  const { settings, file, manifest } = fixture(t, { delivery: 'json-file', structure: undefined, binding: {} })
  const before = loadRuntimeDefinitions(settings)[0].descriptor
  fs.writeFileSync(file, JSON.stringify({ ...manifest, configuration: { ...manifest.configuration, defaults: { added: 2 } } }))
  const updated = loadRuntimeDefinitions(settings)[0].descriptor
  assert.equal(before.definitionDigest, updated.definitionDigest)
  assert.notEqual(before.templateRevision, updated.templateRevision)
  fs.writeFileSync(file, JSON.stringify({ ...manifest, configuration: { ...manifest.configuration, structure: 'nested' } }))
  assert.equal(before.definitionDigest, loadRuntimeDefinitions(settings)[0].descriptor.definitionDigest)
})

test('client schemas validate final execution only and never restrict platform drafts', () => {
  const definition = loadRuntimeDefinitions().find(item => item.descriptor.runtimeKey === 'mcts')!.descriptor
  const values = { 'max-iters': -1, permission: { enabled: true } }
  const options = { version: 2 as const, runtimeKey: 'mcts', definitionDigest: definition.definitionDigest, values }
  assert.deepEqual(normalizeAgentOptions(options, definition)?.values, values)
  assert.throws(() => runtimeInvocationOptions('pi-mcts', 'pi-mcts', options), /允许范围/)
  assert.deepEqual(options.values, values)
})

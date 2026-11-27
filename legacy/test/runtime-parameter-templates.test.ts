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
import { RuntimeParameterSnapshot } from '../src/components/eval/RuntimeParameterSnapshot'
import { GET, POST } from '../src/app/api/eval/settings/route'
import { db } from '../src/lib/storage/prisma'
import { saveUserSettings } from '../src/lib/storage/server-config'
import { appendRuntimeParameterTemplate } from '../src/lib/engine/experiment/runtime-parameter-templates'
import { runtimeOptionsState, savedOptionsToInputs } from '../src/lib/engine/experiment/runtime-options'
import { normalizeAgentOptions, parseParameterJson, validateDefinition, type JsonObject } from '../packages/agent-runtime/index.cjs'

const definition = validateDefinition({
  runtimeKey: 'fixture', displayName: 'Fixture', definitionDigest: `sha256:${'a'.repeat(64)}`,
  targets: [{ platform: 'fixture', agent: '*' }], parameterGroups: [], parameters: [], presets: [],
  configuration: { version: 2, defaults: { addedDefault: true }, delivery: 'json-file', structure: 'nested' },
})
const values: JsonObject = { solver: { retry: { enabled: false, max_attempts: 0 } }, list: [null, '5', 5], token: null }
const options = normalizeAgentOptions({ version: 2, runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest, values }, definition)!
const templateInput = { name: '联调参数', runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest, values }

test('restoring nested experiment options preserves types, deletions and an empty object without new defaults', () => {
  const restored = savedOptionsToInputs(options)
  const target = { platform: 'fixture', agent: 'build', parameterDefinitions: [definition] }
  const state = runtimeOptionsState(target, restored, 'host1', 'host1', options)
  assert.equal(state.active, true)
  assert.equal(state.error, null)
  assert.deepEqual(state.agentOptions?.values, values)
  assert.equal(Object.hasOwn(state.agentOptions!.values, 'addedDefault'), false)
  assert.deepEqual(runtimeOptionsState(target, { __json: '{}' }, 'host1', 'host1').agentOptions?.values, {})
  assert.match(runtimeOptionsState(target, { __json: '{"value":' }, 'host1', 'host1').error!, /JSON/)
  assert.deepEqual(runtimeOptionsState(target, restored, 'host1', 'host2').agentOptions?.values, { addedDefault: true })
  const markup = renderToStaticMarkup(createElement(RuntimeParameterSnapshot, { definition, options }))
  assert.match(markup, /查看配置快照/)
  assert.match(markup, /max_attempts/)
  assert.match(markup, /false/)
  assert.match(markup, /null/)
  assert.doesNotMatch(markup, /\[object Object\]|addedDefault/)
  const large = { ...options, values: { rows: Array.from({ length: 7000 }, () => 'x'.repeat(30)) } }
  assert.deepEqual(parseParameterJson(savedOptionsToInputs(large).__json), large.values)
})

test('templates append immutable revisions scoped to Runtime and keep values as a complete snapshot', () => {
  const input = structuredClone(templateInput)
  const first = appendRuntimeParameterTemplate([], input, '1')
  input.values.solver = null
  assert.deepEqual(first.template.values, values)
  const second = appendRuntimeParameterTemplate(first.templates, { ...templateInput, values: {} }, '2')
  assert.equal(second.template.revision, 2)
  assert.deepEqual(second.template.values, {})
  assert.deepEqual(first.templates[0].values, values)
  const otherRuntime = appendRuntimeParameterTemplate(second.templates, { ...templateInput, runtimeKey: 'other' }, '3')
  assert.equal(otherRuntime.template.revision, 1)
  for (const bad of [{ ...templateInput, name: '' }, { ...templateInput, values: [] }, { ...templateInput, values: { x: Infinity } }]) {
    assert.throws(() => appendRuntimeParameterTemplate([], bad, 'bad'))
  }
})

test('an undeclared structure permits nested submission without changing historical snapshot values', () => {
  const legacyDefinition = validateDefinition({ ...definition, configuration: { version: 2, defaults: {}, delivery: 'json-file' } })
  const historical = normalizeAgentOptions({ ...options, definitionDigest: legacyDefinition.definitionDigest }, legacyDefinition)!
  const raw = savedOptionsToInputs(historical)
  const before = structuredClone(historical)
  const target = { platform: 'fixture', agent: 'build', parameterDefinitions: [legacyDefinition] }
  const state = runtimeOptionsState(target, raw, 'host1', 'host1', historical)
  assert.equal(state.error, null)
  assert.deepEqual(state.agentOptions?.values, values)
  assert.deepEqual(state.inputs, raw)
  assert.deepEqual(historical, before)
  assert.deepEqual(runtimeOptionsState(target, { __json: '{"native-key":0}' }, 'host1', 'host1').agentOptions?.values, { 'native-key': 0 })
})

test('template API saves versions without overwriting model settings, survives unrelated saves and isolates users', async t => {
  const records = new Map<string, string>([['alice', JSON.stringify({
    activeConfigId: 'model', configs: [{ id: 'model', name: 'Model', provider: 'custom', apiKey: 'private-model-key' }],
    searchProvider: 'none', searchApiKey: '',
  })]])
  t.mock.method(db, 'findUserSettings', async (user: string) => records.has(user) ? { settingsJson: records.get(user) } : null)
  t.mock.method(db, 'upsertUserSettings', async (user: string, json: string) => { records.set(user, json) })
  const save = async () => POST(new Request('http://localhost/api/eval/settings', {
    method: 'POST', body: JSON.stringify({ user: 'alice', action: 'save-runtime-parameter-template', template: templateInput }),
  }))
  const responses = await Promise.all([save(), save()])
  assert.deepEqual(responses.map(response => response.status), [200, 200])
  const revisions = await Promise.all(responses.map(async response => (await response.json()).template.revision))
  assert.deepEqual(revisions, [1, 2])
  assert.equal(JSON.parse(records.get('alice')!).configs[0].apiKey, 'private-model-key')
  await saveUserSettings('alice', { activeConfigId: null, configs: [], autoEvaluationEnabled: false })
  const response = await GET(new Request('http://localhost/api/eval/settings?user=alice&section=runtime-parameters'))
  const body = await response.json()
  assert.equal(body.templates.length, 2)
  assert.deepEqual(body.templates[0].values, values)
  assert.deepEqual(Object.keys(body), ['templates'])
  assert.doesNotMatch(JSON.stringify(body), /private-model-key/)
  const other = await GET(new Request('http://localhost/api/eval/settings?user=bob&section=runtime-parameters'))
  assert.deepEqual(await other.json(), { templates: [] })
  const before = records.get('alice')
  const invalid = await POST(new Request('http://localhost/api/eval/settings', {
    method: 'POST', body: JSON.stringify({ user: 'alice', action: 'save-runtime-parameter-template', template: { ...templateInput, values: [] } }),
  }))
  assert.equal(invalid.status, 400)
  assert.equal(records.get('alice'), before)
})

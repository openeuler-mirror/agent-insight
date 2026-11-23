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
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import test from 'node:test'
import { formatParameterJson, parseParameterJson, validateDefinition, validateValues } from '../packages/agent-runtime/index.cjs'
import {
  changeParameterType, diffParameterObjects, isParameterNumber, moveParameterNode, newParameterNode, parameterNodesFromObject,
  parameterEditorTypes, readParameterDraft, removeParameterNode, serializeParameterNodes, updateParameterNode,
} from '../src/lib/client/json-parameter-editor'
import { JsonParameterEditor } from '../src/components/eval/JsonParameterEditor'
import { RuntimeOptionsFields } from '../src/components/eval/RuntimeOptionsFields'
import { RuntimeParameterTemplates } from '../src/components/eval/RuntimeParameterTemplates'
import { initializeRuntimeDraft, optionsToInputs, runtimeOptionsState } from '../src/lib/engine/experiment/runtime-options'

test('parameter tree retains nested typed values through rename, insertion, deletion and array reorder', () => {
  const initial = { solver: { retry: { enabled: false, count: 2 }, models: ['fast', { name: 'accurate', args: [null, true, 5, '5'] }] }, empty: {}, list: [] }
  let nodes = parameterNodesFromObject(initial)
  assert.deepEqual(parseParameterJson(serializeParameterNodes(nodes)), initial)
  const solver = nodes[0]
  const retry = solver.children[0]
  const models = solver.children[1]
  nodes = updateParameterNode(nodes, retry.children[1].id, node => ({ ...node, key: 'max_attempts', text: '3' }))
  nodes = moveParameterNode(nodes, models.children[1].id, -1)
  nodes = removeParameterNode(nodes, retry.children[0].id)
  nodes = updateParameterNode(nodes, solver.id, node => ({ ...node, children: [...node.children, { ...newParameterNode('null', 'cache'), text: '' }] }))
  assert.deepEqual(parseParameterJson(serializeParameterNodes(nodes)), {
    solver: { retry: { max_attempts: 3 }, models: [{ name: 'accurate', args: [null, true, 5, '5'] }, 'fast'], cache: null }, empty: {}, list: [],
  })
  assert.deepEqual(parseParameterJson(serializeParameterNodes(parameterNodesFromObject(initial))), initial)
})

test('tree drafts retain incomplete numbers and duplicate keys until corrected', () => {
  let nodes = parameterNodesFromObject({ attempts: 3, max: 5 })
  nodes = updateParameterNode(nodes, nodes[0].id, node => ({ ...node, text: '-' }))
  const incomplete = serializeParameterNodes(nodes)
  assert.match(incomplete, /"attempts": !"-"/)
  assert.throws(() => parseParameterJson(incomplete))
  nodes = updateParameterNode(nodes, nodes[0].id, node => ({ ...node, text: '', key: 'max' }))
  assert.match(serializeParameterNodes(nodes), /"max": !""/)
  nodes = updateParameterNode(nodes, nodes[0].id, node => ({ ...node, text: '4' }))
  assert.throws(() => parseParameterJson(serializeParameterNodes(nodes)), /重复|duplicate/i)
  nodes = updateParameterNode(nodes, nodes[0].id, node => ({ ...node, key: 'attempts' }))
  assert.deepEqual(parseParameterJson(serializeParameterNodes(nodes)), { attempts: 4, max: 5 })
})

test('near-limit imported configuration roundtrips through formatting and tree editing without added whitespace overflow', () => {
  const values = { rows: Array.from({ length: 7000 }, () => 'x'.repeat(30)) }
  const compact = JSON.stringify(values)
  assert.ok(Buffer.byteLength(compact) < 256 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(values, null, 2)) > 256 * 1024)
  const imported = parseParameterJson(compact)
  const formatted = formatParameterJson(imported)
  assert.ok(Buffer.byteLength(formatted) <= 256 * 1024)
  assert.deepEqual(parseParameterJson(formatted), values)
  let nodes = parameterNodesFromObject(imported)
  assert.deepEqual(parseParameterJson(serializeParameterNodes(nodes)), values)
  const first = nodes[0].children[0]
  nodes = updateParameterNode(nodes, first.id, node => ({ ...node, text: 'changed' }))
  assert.deepEqual(parseParameterJson(serializeParameterNodes(nodes)), { rows: ['changed', ...values.rows.slice(1)] })
  const duplicate = [...nodes, { ...newParameterNode('number', 'rows'), text: '1' }]
  assert.throws(() => parseParameterJson(serializeParameterNodes(duplicate)), /重复|duplicate/i)
  const invalid = updateParameterNode(nodes, first.id, node => ({ ...node, type: 'number', text: 'true' }))
  assert.throws(() => parseParameterJson(serializeParameterNodes(invalid)))
})

test('number fields cannot change value type or inject extra fields using valid JSON fragments', () => {
  const initial = parameterNodesFromObject({ nested: { numeric: 3 }, next: true })
  const numeric = initial[0].children[0]
  for (const text of ['', '-', '1.', '1e', '01', '+1', 'true', 'null', '"text"', '{}', '[]', '1, "extra": true', '1e400']) {
    assert.equal(isParameterNumber(text), false, text)
    const nodes = updateParameterNode(initial, numeric.id, node => ({ ...node, text }))
    assert.equal(nodes[0].children[0].text, text)
    assert.throws(() => parseParameterJson(serializeParameterNodes(nodes)), { name: 'TypeError' }, text)
  }
  for (const text of ['0', '-0', '1.5', '-1.5e+2', '2E-3']) {
    assert.equal(isParameterNumber(text), true, text)
    const nodes = updateParameterNode(initial, numeric.id, node => ({ ...node, text }))
    assert.deepEqual(parseParameterJson(serializeParameterNodes(nodes)), { nested: { numeric: Number(text) }, next: true })
  }
})

test('runtime configuration uses template controls without exposing client preset shortcut buttons', () => {
  const generic = validateDefinition({ runtimeKey: 'custom', displayName: 'Custom Agent', definitionDigest: `sha256:${'a'.repeat(64)}`,
    targets: [{ platform: 'custom', agent: '*' }], parameters: [], parameterGroups: [],
    presets: [{ key: 'quick', label: '客户端专用快捷配置', values: { attempts: 1 } }],
    configuration: { version: 2, delivery: 'json-file', structure: 'nested', defaults: {} } })
  const html = renderToStaticMarkup(createElement(RuntimeOptionsFields, { definition: generic,
    value: { __json: '{}' }, error: null, onChange() {},
    templateControls: createElement(RuntimeParameterTemplates, { user: 'fixture', definition: generic,
      options: { version: 2, runtimeKey: generic.runtimeKey, definitionDigest: generic.definitionDigest, values: {} }, error: null, onApply() {} }),
  }))
  assert.match(html, /参数模板/)
  assert.match(html, /保存为模板/)
  assert.match(html, /恢复默认/)
  assert.doesNotMatch(html, /客户端专用快捷配置|填入联调参数/)
})

test('type changes preserve string/number distinction and initialize containers explicitly', () => {
  const string = { ...newParameterNode('string', 'value'), text: '5' }
  const number = changeParameterType(string, 'number')
  assert.deepEqual(parseParameterJson(serializeParameterNodes([number])), { value: 5 })
  assert.deepEqual(parseParameterJson(serializeParameterNodes([changeParameterType(number, 'string')])), { value: '5' })
  assert.deepEqual(parseParameterJson(serializeParameterNodes([changeParameterType(number, 'array')])), { value: [] })
  assert.deepEqual(parseParameterJson(serializeParameterNodes([changeParameterType(number, 'object')])), { value: {} })
  assert.deepEqual(parseParameterJson(serializeParameterNodes([changeParameterType(number, 'null')])), { value: null })
})

test('import diff distinguishes removal from null, escaped paths, nested values and type changes', () => {
  const changes = diffParameterObjects(
    { solver: { retry: 2 }, 'a/b~c': true, removed: null, type: 5, values: [1, 2] },
    { solver: { retry: 3 }, 'a/b~c': false, added: null, type: '5', values: [1] },
  )
  assert.deepEqual(changes, [
    { path: '/solver/retry', before: 2, after: 3 },
    { path: '/a~1b~0c', before: true, after: false },
    { path: '/removed', before: null, after: undefined },
    { path: '/type', before: 5, after: '5' },
    { path: '/values/1', before: 2, after: undefined },
    { path: '/added', before: undefined, after: null },
  ])
  assert.deepEqual(diffParameterObjects({ first: 1, second: 2 }, { second: 2, first: 1 }), [])
})

test('generic runtime renders nested editing controls with typed values and accessible actions', () => {
  const definition = validateDefinition({ runtimeKey: 'custom', displayName: 'Custom Agent', definitionDigest: `sha256:${'a'.repeat(64)}`,
    targets: [{ platform: 'custom', agent: '*' }], parameters: [], parameterGroups: [], presets: [],
    configuration: { version: 2, delivery: 'json-file', structure: 'nested', defaults: { solver: { retries: 2, enabled: false }, models: ['fast', null] } } })
  const html = renderToStaticMarkup(createElement(RuntimeOptionsFields, { definition,
    value: { __json: JSON.stringify(definition.configuration!.defaults) }, error: null, onChange() {} }))
  assert.match(html, /树形编辑/)
  assert.match(html, /JSON 编辑/)
  assert.match(html, /导入 JSON/)
  assert.match(html, /查看最终配置/)
  assert.match(html, /aria-label="参数值 \/solver\/retries"[^>]*value="2"/)
  assert.match(html, /aria-label="添加子字段 \/solver"/)
  assert.match(html, /aria-label="上移 \/models\/0" disabled/)
  assert.match(html, /aria-label="下移 \/models\/0"/)
  assert.match(html, /aria-label="折叠 \/solver" aria-expanded="true"/)
  assert.match(html, /JSON 格式正确/)
})

test('tree string values preserve line breaks using multiline controls and nested names retain room for indentation', () => {
  const initial = { outer: { inner: { text: 'first\nsecond' } } }
  const nodes = parameterNodesFromObject(initial)
  assert.deepEqual(parseParameterJson(serializeParameterNodes(nodes)), initial)
  const html = renderToStaticMarkup(createElement(JsonParameterEditor, { value: JSON.stringify(initial), error: null, onChange() {} }))
  assert.match(html, /textarea[^>]*aria-label="参数值 \/outer\/inner\/text"[^>]*>first\nsecond<\/textarea>/)
  assert.match(html, /grid-template-columns:minmax\(232px, 1\.2fr\)/)
  assert.match(html, /左右滑动查看参数类型、值和操作/)
})

test('invalid raw JSON stays visible and prevents import, preview and export', () => {
  const invalid = renderToStaticMarkup(createElement(JsonParameterEditor, { value: '{"attempts":', error: null, onChange() {} }))
  assert.match(invalid, /textarea[^>]*aria-invalid="true"/)
  assert.match(invalid, /\{&quot;attempts&quot;:/)
  assert.match(invalid, /role="alert"/)
  assert.match(invalid, /disabled=""[^>]*>查看最终配置/)
})

const genericMcts = validateDefinition({ runtimeKey: 'mcts', displayName: 'MCTS', definitionDigest: `sha256:${'a'.repeat(64)}`,
  targets: [{ platform: 'pi-mcts', agent: 'pi-mcts' }], parameters: [], parameterGroups: [], presets: [],
  configuration: { version: 2, delivery: 'argv', structure: 'flat', defaults: { 'max-iters': 5, 'token-fuse-limit': 0 },
    schema: { type: 'object', additionalProperties: false, properties: { 'max-iters': { type: 'integer', minimum: 1 }, 'token-fuse-limit': { type: 'integer' } } } } })
const mctsTarget = { platform: 'pi-mcts', agent: 'pi-mcts', parameterDefinitions: [genericMcts] }

test('all runtime editors offer generic types and preserve flat defaults without grouping them', () => {
  const raw = JSON.stringify(genericMcts.configuration!.defaults)
  const html = renderToStaticMarkup(createElement(RuntimeOptionsFields, { definition: genericMcts, value: { __json: raw }, error: null, onChange() {} }))
  assert.deepEqual(parameterEditorTypes, ['string', 'number', 'boolean', 'object', 'array', 'null'])
  for (const type of parameterEditorTypes) assert.match(html, new RegExp(`option value="${type}"`))
  assert.match(html, /树形编辑/)
  assert.match(html, /添加对象/)
  assert.match(html, /需要子字段时，将类型设为 Object/)
  assert.doesNotMatch(html, /aria-label="添加子字段|aria-label="添加元素|search|solver/)
  assert.deepEqual(readParameterDraft(raw), { value: genericMcts.configuration!.defaults, error: null })
})

test('MCTS nested drafts can be imported, edited, previewed, saved and submitted independently of default structure', () => {
  for (const item of [{ retries: 2 }, [1, null, false], null]) {
    const values = { 'max-iters': -1, 'new-option': item }
    const raw = JSON.stringify(values)
    assert.deepEqual(readParameterDraft(raw), { value: values, error: null })
    const state = runtimeOptionsState(mctsTarget, { __json: raw }, 'host', 'host')
    assert.equal(state.error, null)
    assert.deepEqual(state.agentOptions?.values, values)
    const html = renderToStaticMarkup(createElement(RuntimeOptionsFields, { definition: genericMcts, value: state.inputs, error: state.error, onChange() {} }))
    assert.match(html, /JSON 格式正确/)
    assert.doesNotMatch(html, /role="alert"|disabled=""[^>]*>查看最终配置|disabled=""[^>]*>[\s\S]*?导出/)
    if (item !== null) assert.match(html, Array.isArray(item) ? /aria-label="添加元素 \/new-option"/ : /aria-label="添加子字段 \/new-option"/)
    assert.deepEqual(parseParameterJson(serializeParameterNodes(parameterNodesFromObject(values))), values)
  }
})

test('manual object creation leaves defaults unchanged and submission keeps the exact user values', () => {
  const before = JSON.stringify(genericMcts.configuration!.defaults)
  let nodes = [...parameterNodesFromObject(genericMcts.configuration!.defaults), newParameterNode('object', 'permission')]
  nodes = updateParameterNode(nodes, nodes[2].id, node => ({ ...node, children: [{ ...newParameterNode('string', 'example'), text: 'allow' }] }))
  const raw = serializeParameterNodes(nodes)
  const state = runtimeOptionsState(mctsTarget, { __json: raw }, 'host', 'host')
  assert.equal(state.error, null)
  assert.deepEqual(state.agentOptions?.values, { ...genericMcts.configuration!.defaults, permission: { example: 'allow' } })
  const html = renderToStaticMarkup(createElement(RuntimeOptionsFields, { definition: genericMcts, value: state.inputs, error: state.error, onChange() {} }))
  assert.match(html, /aria-label="添加子字段 \/permission"/)
  assert.match(html, /aria-label="参数值 \/permission\/example"/)
  assert.equal(JSON.stringify(genericMcts.configuration!.defaults), before)
})

test('native permission JSON keeps path keys literal without splitting or renaming any levels', () => {
  const values = { permission: { external_directory: { '~/.agent-insight/example/**': 'allow' } }, tools: ['read', null], 'plugin.retry': '5' }
  const raw = serializeParameterNodes(parameterNodesFromObject(values))
  const state = runtimeOptionsState(mctsTarget, { __json: raw }, 'host', 'host')
  const html = renderToStaticMarkup(createElement(RuntimeOptionsFields, { definition: genericMcts, value: state.inputs, error: state.error, onChange() {} }))
  assert.match(html, /aria-label="添加子字段 \/permission"/)
  assert.match(html, /aria-label="添加子字段 \/permission\/external_directory"/)
  assert.match(html, /value="~\/\.agent-insight\/example\/\*\*"/)
  assert.deepEqual(state.agentOptions?.values, values)
  assert.equal(state.error, null)
  assert.deepEqual(validateValues(genericMcts, values), values)
})

test('JSON keys remain business data on the platform rather than being interpreted as CLI options', () => {
  for (const values of [{ ' mode ': 'data' }, { mode: 'data' }, { '--max-iters': 1 }, { 'model-name': 'literal\0value' }]) {
    const raw = JSON.stringify(values)
    assert.deepEqual(readParameterDraft(raw), { value: values, error: null })
    const state = runtimeOptionsState(mctsTarget, { __json: raw }, 'host', 'host')
    assert.equal(state.error, null)
    assert.deepEqual(state.agentOptions?.values, values)
  }
})

test('draft initialization copies defaults once, keeps deletion and isolates targets from later default updates', () => {
  const initial = initializeRuntimeDraft({}, 'host', genericMcts)
  assert.deepEqual(JSON.parse(initial.host.inputs.__json), genericMcts.configuration!.defaults)
  const next = validateDefinition({ ...genericMcts, configuration: { version: 2, defaults: { 'max-iters': 99, newDefault: true } } })
  assert.equal(initializeRuntimeDraft(initial, 'host', next), initial)
  const edited = { ...initial, host: { inputs: { __json: '{"permission":{"external_directory":{"~/example/**":"allow"}}}' } } }
  assert.equal(initializeRuntimeDraft(edited, 'host', next), edited)
  const state = runtimeOptionsState({ ...mctsTarget, parameterDefinitions: [next] }, edited.host.inputs, 'host', 'host')
  assert.deepEqual(state.agentOptions?.values, JSON.parse(edited.host.inputs.__json))
  assert.equal(Object.hasOwn(state.agentOptions!.values, 'max-iters'), false)
  const empty = { host: { inputs: { __json: '{}' } } }
  assert.equal(initializeRuntimeDraft(empty, 'host', next), empty)
  assert.deepEqual(runtimeOptionsState(mctsTarget, empty.host.inputs, 'host', 'host').agentOptions?.values, {})
  const other = initializeRuntimeDraft(edited, 'other-host', next)
  assert.deepEqual(other.host, edited.host)
  assert.deepEqual(JSON.parse(other['other-host'].inputs.__json), next.configuration!.defaults)
  assert.deepEqual(JSON.parse(optionsToInputs(next).__json), next.configuration!.defaults)
})

test('a runtime without defaults starts empty and accepts nested additions without a structure declaration', () => {
  const definition = validateDefinition({ runtimeKey: 'empty', displayName: 'Empty', definitionDigest: `sha256:${'b'.repeat(64)}`,
    targets: [{ platform: 'empty', agent: '*' }], parameters: [], parameterGroups: [], presets: [], configuration: { version: 2 } })
  const draft = initializeRuntimeDraft({}, 'host', definition)
  assert.deepEqual(JSON.parse(draft.host.inputs.__json), {})
  const values = { rows: [1, false, null, { enabled: true }], native: { child: 'value' } }
  const state = runtimeOptionsState({ platform: 'empty', agent: 'build', parameterDefinitions: [definition] }, { __json: JSON.stringify(values) }, 'host', 'host')
  assert.equal(state.error, null)
  assert.deepEqual(state.agentOptions?.values, values)
  assert.deepEqual(definition.configuration!.defaults, {})
})

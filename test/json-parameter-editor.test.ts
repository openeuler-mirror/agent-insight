import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import test from 'node:test'
import { formatParameterJson, parseParameterJson, validateDefinition, validateValues } from '../packages/agent-runtime/index.cjs'
import {
  changeParameterType, diffParameterObjects, isParameterNumber, moveParameterNode, newParameterNode, parameterNodesFromObject,
  parameterTypesForStructure, readParameterDraft, removeParameterNode, serializeParameterNodes, updateParameterNode,
} from '../src/lib/client/json-parameter-editor'
import { JsonParameterEditor } from '../src/components/eval/JsonParameterEditor'
import { RuntimeOptionsFields, runtimePresetInputs } from '../src/components/eval/RuntimeOptionsFields'

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

test('v2 preset actions include the protocol version and legacy presets retain flat inputs', () => {
  const generic = validateDefinition({ runtimeKey: 'custom', displayName: 'Custom Agent', definitionDigest: `sha256:${'a'.repeat(64)}`,
    targets: [{ platform: 'custom', agent: '*' }], parameters: [], parameterGroups: [], presets: [],
    configuration: { version: 2, delivery: 'json-file', defaults: {} } })
  const preset = { solver: { retry: { enabled: false, max_attempts: 0 } }, list: [null, 5, '5'] }
  assert.deepEqual(parseParameterJson(runtimePresetInputs(generic, preset).__json), preset)
  const legacy = validateDefinition({ runtimeKey: 'legacy', displayName: 'Legacy Agent', definitionDigest: `sha256:${'b'.repeat(64)}`,
    targets: [{ platform: 'legacy', agent: '*' }], parameterGroups: [{ key: 'main', label: 'Main' }],
    parameters: [{ key: 'steps', group: 'main', label: 'Steps', type: 'integer', default: 2 }], presets: [] })
  assert.deepEqual(runtimePresetInputs(legacy, { steps: 5 }), { steps: '5' })
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
  assert.match(html, /aria-label="添加子项 \/solver"/)
  assert.match(html, /aria-label="上移 \/models\/0" disabled/)
  assert.match(html, /aria-label="下移 \/models\/0"/)
  assert.match(html, /aria-label="折叠 \/solver" aria-expanded="true"/)
  assert.match(html, /配置格式正确/)
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

test('invalid raw JSON stays visible and prevents preview/export while schema errors retain editable tree', () => {
  const invalid = renderToStaticMarkup(createElement(JsonParameterEditor, { value: '{"attempts":', error: null, onChange() {} }))
  assert.match(invalid, /textarea[^>]*aria-invalid="true"/)
  assert.match(invalid, /\{&quot;attempts&quot;:/)
  assert.match(invalid, /role="alert"/)
  assert.match(invalid, /disabled=""[^>]*>查看最终配置/)
  const schema = renderToStaticMarkup(createElement(JsonParameterEditor, { value: '{"attempts":-1}',
    schema: { type: 'object', properties: { attempts: { type: 'integer', minimum: 0 } } }, error: null, onChange() {} }))
  assert.match(schema, /aria-label="参数值 \/attempts"/)
  assert.match(schema, /role="alert"/)
  assert.match(schema, /disabled=""[^>]*>查看最终配置/)
})

test('flat runtime editor preserves CLI names and only offers executable scalar types', () => {
  const values = { 'max-iters': 1, 'max-turns-author-step': 10, 'token-fuse-limit': 0, 'new-cli-flag': false, 'model-name': '5' }
  const definition = validateDefinition({ runtimeKey: 'mcts', displayName: 'MCTS', definitionDigest: `sha256:${'a'.repeat(64)}`,
    targets: [{ platform: 'pi-mcts', agent: 'pi-mcts' }], parameters: [], parameterGroups: [], presets: [],
    configuration: { version: 2, delivery: 'argv', structure: 'flat', defaults: values } })
  const raw = serializeParameterNodes(parameterNodesFromObject(values))
  assert.deepEqual(readParameterDraft(raw, undefined, 'flat'), { value: values, error: null })
  assert.deepEqual(parameterTypesForStructure('flat'), ['string', 'number', 'boolean'])
  const html = renderToStaticMarkup(createElement(RuntimeOptionsFields, { definition, value: { __json: raw }, error: null, onChange() {} }))
  assert.match(html, /参数编辑/)
  assert.match(html, /aria-label="参数名 \/max-turns-author-step"/)
  assert.match(html, /value="new-cli-flag"/)
  assert.match(html, /按执行端原名填写平铺参数/)
  assert.doesNotMatch(html, /option value="(?:object|array|null)"/)
  assert.doesNotMatch(html, /添加子项|添加元素|search|solver/)
})

test('flat JSON edits and imports retain incompatible drafts without an applicable value', () => {
  for (const item of [{ retries: 2 }, [1, 2], null]) {
    const raw = JSON.stringify({ 'max-iters': 1, 'native-option': item }, null, 2)
    const draft = readParameterDraft(raw, undefined, 'flat')
    assert.equal(draft.value, undefined)
    assert.match(draft.error!, /执行端只支持平铺参数/)
    assert.match(draft.error!, /\/native-option/)
    const html = renderToStaticMarkup(createElement(JsonParameterEditor, { value: raw, structure: 'flat', error: null, onChange() {} }))
    assert.match(html, /textarea[^>]*aria-invalid="true"/)
    assert.match(html, /&quot;native-option&quot;/)
    assert.match(html, /执行端只支持平铺参数/)
    assert.match(html, /disabled=""[^>]*>查看最终配置/)
    assert.match(html, /disabled=""[^>]*>[\s\S]*?导出/)
    assert.doesNotMatch(html, /aria-label="添加子项|aria-label="添加元素/)
    assert.ok(html.includes(raw.replaceAll('"', '&quot;')), 'the complete incompatible JSON remains visible for correction')
  }
})

test('nested editor keeps execution-native configuration without adding or renaming levels', () => {
  const native = { provider: { custom: { options: { baseURL: 'https://example.invalid', retry: false } } }, tools: ['read', 'edit'], disabled: null }
  const raw = JSON.stringify(native)
  assert.deepEqual(readParameterDraft(raw, undefined, 'nested'), { value: native, error: null })
  assert.deepEqual(readParameterDraft(raw), { value: native, error: null })
  assert.deepEqual(parameterTypesForStructure('nested'), ['string', 'number', 'boolean', 'object', 'array', 'null'])
  assert.deepEqual(parseParameterJson(serializeParameterNodes(parameterNodesFromObject(native))), native)
  const html = renderToStaticMarkup(createElement(JsonParameterEditor, { value: raw, structure: 'nested', error: null, onChange() {} }))
  assert.match(html, /按执行端原始结构编辑/)
  assert.match(html, /aria-label="添加子项 \/provider\/custom\/options"/)
  assert.match(html, /aria-label="参数名 \/provider\/custom\/options\/baseURL"/)
  assert.match(html, /option value="object"/)
  assert.match(html, /option value="array"/)
  assert.match(html, /option value="null"/)
})

test('draft and import preflight reject execution-invalid CLI keys while retaining editable values', () => {
  const definition = validateDefinition({ runtimeKey: 'mcts', displayName: 'MCTS', definitionDigest: `sha256:${'a'.repeat(64)}`,
    targets: [{ platform: 'pi-mcts', agent: 'pi-mcts' }], parameters: [], parameterGroups: [], presets: [],
    configuration: { version: 2, delivery: 'argv', structure: 'flat', defaults: {} } })
  for (const values of [{ ' mode ': 'sweverified' }, { mode: 'sweverified' }, { '--max-iters': 1 }, { 'model-name': 'invalid\0value' }]) {
    const raw = JSON.stringify(values)
    const draft = readParameterDraft(raw, undefined, 'flat', value => { validateValues(definition, value) })
    assert.ok(draft.error, 'the import cannot be applied when execution would reject the parameter')
    assert.deepEqual(draft.value, values, 'the editor keeps original keys and values for correction')
    const html = renderToStaticMarkup(createElement(RuntimeOptionsFields, { definition, value: { __json: raw }, error: null, onChange() {} }))
    assert.match(html, /role="alert"/)
    assert.match(html, /disabled=""[^>]*>查看最终配置/)
  }
})

test('execution preflight preserves frozen CLI snapshots and native nested file shapes', () => {
  const base = { runtimeKey: 'custom', displayName: 'Custom', definitionDigest: `sha256:${'a'.repeat(64)}`,
    targets: [{ platform: 'custom', agent: '*' }], parameters: [], parameterGroups: [], presets: [] }
  const snapshot = Object.freeze({ 'max-iters': 1, 'new-cli-flag': false, 'model-name': '5' })
  const cli = validateDefinition({ ...base, configuration: { version: 2, delivery: 'argv', structure: 'flat', defaults: {} } })
  const before = JSON.stringify(snapshot)
  const cliDraft = readParameterDraft(before, undefined, 'flat', value => { validateValues(cli, value) })
  assert.equal(cliDraft.error, null)
  assert.deepEqual(cliDraft.value, snapshot)
  assert.equal(JSON.stringify(snapshot), before)

  const file = validateDefinition({ ...base, configuration: { version: 2, delivery: 'json-file', structure: 'nested', defaults: {} } })
  const native = { ' mode ': { '--max-iters': 1 }, mode: ['literal', null], 'model-name': '5' }
  const nativeRaw = JSON.stringify(native)
  assert.deepEqual(readParameterDraft(nativeRaw, undefined, 'nested', value => { validateValues(file, value) }), { value: native, error: null })
})

test('runtime editors without an explicit native structure stay flat while preserving incompatible drafts', () => {
  const definition = validateDefinition({ runtimeKey: 'older', displayName: 'Older client', definitionDigest: `sha256:${'a'.repeat(64)}`,
    targets: [{ platform: 'older', agent: '*' }], parameters: [], parameterGroups: [], presets: [],
    configuration: { version: 2, delivery: 'json-file', defaults: { 'max-iters': 1 } } })
  const scalarHtml = renderToStaticMarkup(createElement(RuntimeOptionsFields, { definition, value: { __json: '{"max-iters":1}' }, error: null, onChange() {} }))
  assert.match(scalarHtml, /按执行端原名填写平铺参数/)
  assert.doesNotMatch(scalarHtml, /option value="(?:object|array|null)"/)
  const raw = '{"native":{"option":1},"values":[1,2]}'
  const html = renderToStaticMarkup(createElement(RuntimeOptionsFields, { definition, value: { __json: raw }, error: null, onChange() {} }))
  assert.ok(html.includes(raw.replaceAll('"', '&quot;')))
  assert.match(html, /执行端只支持平铺参数/)
  assert.match(html, /disabled=""[^>]*>查看最终配置/)
  const imported = readParameterDraft(raw, definition.configuration!.schema,
    definition.configuration!.structure === 'nested' ? 'nested' : 'flat', value => { validateValues(definition, value) })
  assert.equal(imported.value, undefined)
  assert.match(imported.error!, /执行端只支持平铺参数/)
})

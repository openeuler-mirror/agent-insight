import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RuntimeOptionsFields } from '../src/components/eval/RuntimeOptionsFields'
import { normalizeAgentOptions, optionsToInputs, parseOptionInputs, resolveAgentOptions, validateDefinition } from '../packages/agent-runtime/index.cjs'
import { loadRuntimeDefinitions, runtimeInvocationOptions } from '../packages/agent-runtime/loader.cjs'
import { readSavedOptions, runtimeOptionsState } from '../src/lib/engine/experiment/runtime-options'
import { normalizeBenchmarkAgentOptions } from '../packages/benchmark-protocol/src/contracts'
import { assertBenchmarkExecutionTarget } from '../src/lib/benchmark/execution-targets'

const definition = loadRuntimeDefinitions().find(item => item.descriptor.runtimeKey === 'mcts')!.descriptor
const runtimeRequire = createRequire(import.meta.url)
const defaults = definition.configuration!.defaults
const options = (values: Record<string, unknown> = defaults) => ({ version: 2 as const, runtimeKey: 'mcts', definitionDigest: definition.definitionDigest, values })

function configurationFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-parameters-'))
  fs.cpSync(path.resolve('services/executor/runtimes'), path.join(root, 'services/executor/runtimes'), { recursive: true })
  fs.mkdirSync(path.join(root, 'config/benchmark'), { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, env: {} }
}

test('YAML defines all MCTS fields, presets and startup flags; zero is retained', () => {
  const quick = options(definition.presets[0].values)
  const markup = renderToStaticMarkup(createElement(RuntimeOptionsFields, {
    definition, value: optionsToInputs(definition, quick), error: '参数不合法', onChange: () => {},
  }))
  assert.equal((markup.match(/aria-label="参数值 /g) || []).length, 7)
  assert.match(markup, /aria-label="参数值 \/token-fuse-limit"[^>]+value="0"/)
  assert.match(markup, /role="alert">参数不合法/)
  assert.match(markup, /填入联调参数/)
  assert.match(markup, /恢复默认/)
  for (const platform of ['pi-mcts', 'xiao-mcts']) {
    assert.deepEqual(runtimeInvocationOptions(platform, platform, quick).args, ['--max-iters', '1', '--branching', '1',
      '--max-turns-init', '20', '--max-turns-step', '10', '--max-turns-author', '20', '--max-turns-author-step', '10', '--token-fuse-limit', '0'])
  }
  assert.equal(JSON.stringify(definition).includes('binding'), false)
})

test('form follows target identity, preserves full JSON and blocks malformed JSON and stale definitions', () => {
  const target = { platform: 'pi-mcts', agent: 'pi-mcts', parameterDefinitions: [definition] }
  const inputs = optionsToInputs(definition)
  assert.deepEqual(JSON.parse(inputs.__json), defaults)
  assert.deepEqual(runtimeOptionsState(target, {}, '', 'host1').agentOptions, options())
  assert.match(runtimeOptionsState(target, { __json: '' }, 'host1', 'host1').error!, /JSON/)
  assert.deepEqual(runtimeOptionsState(target, { __json: '{"branching":1.5}' }, 'host1', 'host1').agentOptions?.values, { branching: 1.5 })
  assert.deepEqual(runtimeOptionsState(target, { __json: '{"branching":10}' }, 'host1', 'host2').agentOptions, options())
  assert.deepEqual(runtimeOptionsState(target, { __json: '{}' }, 'host1', 'host1').agentOptions, options({}))
  const stale = { ...options(), definitionDigest: `sha256:${'f'.repeat(64)}` }
  assert.match(runtimeOptionsState(target, inputs, 'host1', 'host1', stale as never).error!, /定义已变化/)
  assert.equal(runtimeOptionsState({ platform: 'opencode', agent: 'build' }, inputs, 'host1', 'host2').active, false)
})

test('platform accepts generic values while the MCTS client validates its native CLI inputs', () => {
  for (const value of [[], 'flags', { mcts: { 'max-iters': 5 } }, { other: {} }, { ...options(), args: [] }]) {
    assert.throws(() => normalizeAgentOptions(value))
    assert.throws(() => normalizeBenchmarkAgentOptions(value), { code: 'AGENT_OPTIONS_INVALID' })
    assert.equal(readSavedOptions(value), undefined)
  }
  for (const values of [{ 'max-iters': 0 }, { branching: -1 }, { 'max-turns-init': 1.5 },
    { 'max-turns-step': '20' }, { 'token-fuse-limit': -1 }, { 'max-iters': Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.deepEqual(normalizeAgentOptions(options(values), definition)?.values, values)
    assert.throws(() => runtimeInvocationOptions('pi-mcts', 'pi-mcts', options(values)))
  }
  assert.deepEqual(normalizeAgentOptions(options({ 'token-fuse-limit': 0 }), definition)?.values, { 'token-fuse-limit': 0 })
  for (const value of [{ nested: 1 }, [1], null]) {
    assert.deepEqual(normalizeAgentOptions(options({ unknown: value }), definition)?.values, { unknown: value })
    assert.throws(() => runtimeInvocationOptions('pi-mcts', 'pi-mcts', options({ unknown: value })))
  }
  const added = options({ 'new-business-option': 'literal value', enabled: false, empty: '' })
  assert.deepEqual(runtimeInvocationOptions('pi-mcts', 'pi-mcts', added).args,
    ['--new-business-option', 'literal value', '--enabled', 'false', '--empty', ''])
  for (const key of ['mode', 'runtime', 'testbench', 'instance-id', 'split', 'output-dir']) {
    assert.deepEqual(normalizeAgentOptions(options({ [key]: 'override' }), definition)?.values, { [key]: 'override' })
    assert.throws(() => runtimeInvocationOptions('pi-mcts', 'pi-mcts', options({ [key]: 'override' })))
  }
  assert.throws(() => runtimeInvocationOptions('opencode', 'build', options()), { code: 'AGENT_DEFINITION_CHANGED' })
})

test('execution target requires a matching client definition and rejects changed digests', () => {
  const manifest = { requiredCapabilities: ['git-workspace/v1', 'git-patch/v1'] }
  for (const platform of ['pi-mcts', 'xiao-mcts']) {
    for (const supported of [false, true]) {
      const client = { clientId: 'fixture', status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), unboundAt: null,
        capabilitiesJson: JSON.stringify({ actions: ['RUN_BENCHMARK_CASE'], platforms: [{ id: platform, agents: [platform],
          parameterDefinitions: supported ? [definition] : [], runBenchmarkCase: { version: 1, returnsTraceId: true } }],
        components: { 'git-workspace/v1': true, 'git-patch/v1': true, [`agent-runtime/${platform}/v1`]: true } }) }
      const target = { platform, agent: platform, agentOptions: options() }
      if (supported) {
        assert.deepEqual(assertBenchmarkExecutionTarget(client as never, manifest as never, target).parameterDefinitions, [definition])
        assert.throws(() => assertBenchmarkExecutionTarget(client as never, manifest as never, { ...target,
          agentOptions: { ...options(), definitionDigest: `sha256:${'f'.repeat(64)}` } }), { code: 'AGENT_DEFINITION_CHANGED' })
      } else assert.throws(() => assertBenchmarkExecutionTarget(client as never, manifest as never, target), { code: 'CLIENT_UPGRADE_REQUIRED' })
    }
  }
})

test('local templates preserve null, final client validation rejects it and template revisions preserve frozen options', t => {
  const settings = configurationFixture(t)
  const config = path.join(settings.root, 'config/benchmark')
  fs.writeFileSync(path.join(config, 'executor.yaml'), 'runtimes:\n  mcts:\n    defaults: { max-iters: 8, branching: 4 }\n')
  fs.writeFileSync(path.join(config, 'executor.local.yaml'), 'runtimes:\n  mcts:\n    defaults: { max-iters: null, token-fuse-limit: 0 }\n')
  assert.equal(loadRuntimeDefinitions(settings).find(item => item.descriptor.runtimeKey === 'mcts')!.descriptor.configuration!.defaults['max-iters'], null)
  assert.throws(() => runtimeInvocationOptions('pi-mcts', 'pi-mcts', undefined, settings), /max-iters.*integer/)
  fs.writeFileSync(path.join(config, 'executor.local.yaml'), 'runtimes:\n  mcts:\n    defaults: { max-iters: 5, token-fuse-limit: 0 }\n')
  const runtime = loadRuntimeDefinitions(settings).find(item => item.descriptor.runtimeKey === 'mcts')!
  const effective = resolveAgentOptions([runtime.descriptor], 'pi-mcts', 'pi-mcts').agentOptions!
  assert.deepEqual(effective.values, { ...defaults, branching: 4, 'token-fuse-limit': 0 })
  assert.equal(effective.definitionDigest, definition.definitionDigest)
  assert.notEqual(runtime.descriptor.templateRevision, definition.templateRevision)
  assert.deepEqual(runtimeInvocationOptions('pi-mcts', 'pi-mcts', options(), settings).agentOptions, options())
  assert.deepEqual(runtimeInvocationOptions('pi-mcts', 'pi-mcts', effective, settings).agentOptions, effective)
})

test('configuration errors fail before startup and identify the YAML file', t => {
  const settings = configurationFixture(t)
  const local = path.join(settings.root, 'config/benchmark/executor.local.yaml')
  for (const content of ['runtimes: { mcts: { defaults: { branching: 0 } } }', 'runtimes: { missing: { defaults: {} } }',
    'runtimes: { mcts: { defaults: { max-iters: "5" } } }']) {
    fs.writeFileSync(local, content)
    assert.throws(() => runtimeInvocationOptions('pi-mcts', 'pi-mcts', undefined, settings), /Runtime|runtime|未知|范围|整数|integer/)
  }
  fs.writeFileSync(local, '{}')
  const file = path.join(settings.root, 'services/executor/runtimes/mcts/runtime.yaml')
  const original = fs.readFileSync(file, 'utf8')
  for (const modified of [original.replace('mode: passthrough', 'mode: missing'), original.replace('type: integer', 'type: shell'), original + '\nunknown: true\n']) {
    fs.writeFileSync(file, modified)
    assert.throws(() => loadRuntimeDefinitions(settings), /runtime.yaml/)
  }
})

test('a new OpenCode parameter definition drives controls and argv without frontend changes', t => {
  const settings = configurationFixture(t)
  const file = path.join(settings.root, 'services/executor/runtimes/opencode/runtime.yaml')
  fs.writeFileSync(file, `key: opencode
displayName: OpenCode
targets: [{ platform: opencode, agent: '*' }]
parameterGroups: [{ key: execution, label: 执行参数 }]
parameters:
  - { key: count, group: execution, label: 次数, type: integer, minimum: 1, default: 2, binding: { kind: argv, flag: --fixture-count } }
  - { key: ratio, group: execution, label: 比例, type: number, minimum: 0, maximum: 1, default: 0.5, binding: { kind: argv, flag: --fixture-ratio } }
  - { key: label, group: execution, label: 标签, type: string, maxLength: 100, default: 'a b;$(echo unsafe)', binding: { kind: argv, flag: --fixture-label } }
  - { key: enabled, group: execution, label: 开关, type: boolean, default: false, binding: { kind: argv, flag: --fixture-enable, falseFlag: --fixture-disable } }
  - { key: mode, group: execution, label: 模式, type: enum, choices: [fast, slow], default: fast, binding: { kind: argv, flag: --fixture-mode } }
  - { key: optional, group: execution, label: 可选, type: string, binding: { kind: argv, flag: --fixture-optional } }
presets: []
`)
  const descriptor = loadRuntimeDefinitions(settings).find(item => item.descriptor.runtimeKey === 'opencode')!.descriptor
  const inputs = optionsToInputs(descriptor)
  const parsed = parseOptionInputs(descriptor, { ...inputs, count: '3' })
  const invocation = runtimeInvocationOptions('opencode', 'build', parsed, settings)
  assert.deepEqual(invocation.args, ['--fixture-count', '3', '--fixture-ratio', '0.5', '--fixture-label', 'a b;$(echo unsafe)', '--fixture-disable', '--fixture-mode', 'fast'])
  const markup = renderToStaticMarkup(createElement(RuntimeOptionsFields, { definition: descriptor, value: inputs, error: null, onChange: () => {} }))
  assert.match(markup, /OpenCode 运行参数/)
  assert.equal((markup.match(/<select/g) || []).length, 2)
  assert.throws(() => parseOptionInputs(descriptor, { ...inputs, ratio: '2' }), /范围/)
  assert.throws(() => parseOptionInputs(descriptor, { ...inputs, enabled: 'yes' }), /布尔值/)
  assert.throws(() => validateDefinition({ ...descriptor, parameters: [{ ...descriptor.parameters[0], unknown: true }] }), /未知字段/)
  assert.ok(!JSON.stringify(descriptor).includes('binding'))
})

test('ordinary client execution passes configured OpenCode argv as literal arguments', async t => {
  const settings = configurationFixture(t)
  const file = path.join(settings.root, 'services/executor/runtimes/opencode/runtime.yaml')
  fs.writeFileSync(file, `key: opencode
displayName: OpenCode
targets: [{ platform: opencode, agent: '*' }]
parameterGroups: [{ key: execution, label: 执行参数 }]
parameters:
  - { key: label, group: execution, label: 标签, type: string, default: 'a b;$(touch should-not-exist)', binding: { kind: argv, flag: --fixture-label } }
presets: []
`)
  const loader = runtimeRequire('../packages/agent-runtime/loader.cjs')
  const invoke = loader.runtimeInvocationOptions
  t.mock.method(loader, 'runtimeInvocationOptions', (platform: string, agent: string, value: unknown) => invoke(platform, agent, value, settings))
  const descriptor = loadRuntimeDefinitions(settings).find(item => item.descriptor.runtimeKey === 'opencode')!.descriptor
  const parsed = parseOptionInputs(descriptor, {})
  const bin = path.join(settings.root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'opencode'), `#!${process.execPath}
const fs = require('node:fs')
if (process.argv.includes('--help')) process.exit(0)
fs.writeFileSync('actual-args.json', JSON.stringify(process.argv.slice(2)))
for (const kind of ['ready', 'session']) fs.writeSync(3, JSON.stringify({ protocol: 1, token: process.env.AGENT_INSIGHT_EVENT_TOKEN, kind, sessionId: 'ses_runtime_parameters' }) + '\\n')
console.log(JSON.stringify({ type: 'text', sessionID: 'ses_runtime_parameters', part: { type: 'text', text: 'done' } }))
`, { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`
  t.after(() => { process.env.PATH = previousPath })
  const client = runtimeRequire('../scripts/reliability-client.cjs')
  const result = await client.runExperimentCase({ clientId: 'runtime-test', workspaceBase: settings.root }, {
    platform: 'opencode', agent: 'build', input: 'fixture', cwd: settings.root, timeoutSeconds: 10, agentOptions: parsed,
  })
  assert.equal(result.traceId, 'ses_runtime_parameters')
  const actual = JSON.parse(fs.readFileSync(path.join(settings.root, 'actual-args.json'), 'utf8'))
  assert.deepEqual(actual.slice(-2), ['--fixture-label', 'a b;$(touch should-not-exist)'])
  assert.equal(fs.existsSync(path.join(settings.root, 'should-not-exist')), false)
})

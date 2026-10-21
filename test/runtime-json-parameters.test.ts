import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { normalizeAgentOptions, formatParameterJson, optionsToInputs, parseOptionInputs, parseParameterJson, resolveAgentOptions, validateDefinition, validateParameterObject, type JsonObject } from '../packages/agent-runtime/index.cjs'
import { loadRuntimeDefinitions, prepareRuntimeInvocation, runtimeInvocationOptions } from '../packages/agent-runtime/loader.cjs'

const runtimeRequire = createRequire(import.meta.url)

function fixture(t: test.TestContext, delivery = 'json-file', binding: object = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-json-'))
  const directory = path.join(root, 'services/executor/runtimes/fixture')
  fs.mkdirSync(directory, { recursive: true })
  const manifest = {
    key: 'fixture', displayName: 'Fixture', targets: [{ platform: 'fixture', agent: '*' }],
    parameterGroups: [], parameters: [], presets: [],
    configuration: { version: 2, structure: 'nested', defaults: { solver: { retry: { enabled: true, attempts: 2 } } }, delivery, binding },
  }
  const file = path.join(directory, 'runtime.yaml')
  const write = () => fs.writeFileSync(file, JSON.stringify(manifest))
  write()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { settings: { root, env: {} }, root, manifest, write }
}

test('strict JSON import preserves nested types and detects duplicate, unsafe, oversized and deep inputs', () => {
  const expected = { object: { child: [{ enabled: false }, null, 0, '0', true] }, empty: {} }
  assert.deepEqual(parseParameterJson(JSON.stringify(expected)), expected)
  for (const text of ['{"a":1,"a":2}', '{"nested":{"\\u0061":1,"a":2}}', '{"a":1,}', '[]', 'null', '{"__proto__":{}}', '{"constructor":1}', '{"a":1e999}', '{"a":NaN}', '{"a":01}']) {
    assert.throws(() => parseParameterJson(text), { code: 'AGENT_OPTIONS_INVALID' })
  }
  assert.throws(() => parseParameterJson('{\n "a":1,\n "a":2\n}'), /第 3 行/)
  assert.throws(() => parseParameterJson(JSON.stringify({ value: 'x'.repeat(256 * 1024) })), /256 KiB/)
  let deep = '{}'
  for (let i = 0; i < 34; i++) deep = `{"child":${deep}}`
  assert.throws(() => parseParameterJson(deep), /32 层/)
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  for (const value of [cyclic, { bad: undefined }, { bad: Infinity }, { bad: new Date() }, { bad: () => {} }]) assert.throws(() => validateParameterObject(value))
})

test('recursive schema validates required fields, arrays, primitives, enum and extension policy', () => {
  const schema = { type: 'object' as const, required: ['solver'], additionalProperties: false, properties: {
    solver: { type: 'object' as const, required: ['retries'], additionalProperties: false, properties: {
      retries: { type: 'integer' as const, minimum: 0, maximum: 3 }, enabled: { type: 'boolean' as const },
      labels: { type: 'array' as const, minItems: 1, items: { type: 'string' as const, minLength: 1, enum: ['fast', 'safe'] } },
      optional: { type: ['null', 'number'] as Array<'null' | 'number'> },
    } },
  } }
  const input = { solver: { retries: 0, enabled: false, labels: ['safe'], optional: null } }
  const output = validateParameterObject(input, schema)
  assert.deepEqual(output, input)
  assert.notEqual(output.solver, input.solver)
  for (const value of [{}, { extra: 1, solver: { retries: 1 } }, { solver: { retries: 1.1 } }, { solver: { retries: 4 } }, { solver: { retries: 1, enabled: 'true' } }, { solver: { retries: 1, labels: ['unknown'] } }]) assert.throws(() => validateParameterObject(value, schema))
  assert.throws(() => validateParameterObject({ solver: {} }, schema), /\/solver\/retries/)
})

test('v2 values are complete snapshots and editor round trips preserve deletion, null and extra business keys', t => {
  const { settings } = fixture(t)
  const definition = loadRuntimeDefinitions(settings)[0].descriptor
  const supplied = { version: 2 as const, runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest,
    values: { solver: { attempts: null }, command: 'business data', nested: { token: { value: ['x', 0, false] } } } }
  assert.deepEqual(normalizeAgentOptions(supplied, definition), supplied)
  assert.deepEqual(parseOptionInputs(definition, optionsToInputs(definition, supplied)), supplied)
  assert.deepEqual(resolveAgentOptions([definition], 'fixture', 'build', { ...supplied, values: {} }).agentOptions?.values, {})
  assert.deepEqual(resolveAgentOptions([definition], 'fixture', 'build').agentOptions?.values, definition.configuration?.defaults)
  const legacy = { ...definition, configuration: undefined }
  assert.throws(() => normalizeAgentOptions(supplied, legacy), { code: 'CLIENT_UPGRADE_REQUIRED' })
  assert.throws(() => resolveAgentOptions([], 'fixture', 'build', supplied), { code: 'CLIENT_UPGRADE_REQUIRED' })
})

test('live manifests without a declared structure reject nested defaults, overrides and presets', t => {
  const current = fixture(t)
  const file = path.join(current.root, 'services/executor/runtimes/fixture/runtime.yaml')
  const directory = path.join(current.root, 'config/benchmark')
  fs.mkdirSync(directory, { recursive: true })
  const override = path.join(directory, 'executor.local.yaml')
  const configuration = { ...current.manifest.configuration, structure: undefined, defaults: {} }
  const manifest = { ...current.manifest, configuration }
  for (const values of [{ native: { count: 1 } }, { native: [1] }, { native: null }] as JsonObject[]) {
    fs.writeFileSync(override, JSON.stringify({ runtimes: {} }))
    fs.writeFileSync(file, JSON.stringify({ ...manifest, configuration: { ...configuration, defaults: values } }))
    assert.throws(() => loadRuntimeDefinitions(current.settings), /未声明嵌套/)
    fs.writeFileSync(file, JSON.stringify({ ...manifest, presets: [{ key: 'fixture', label: 'Fixture', values }] }))
    assert.throws(() => loadRuntimeDefinitions(current.settings), /未声明嵌套/)
    fs.writeFileSync(file, JSON.stringify(manifest))
    fs.writeFileSync(override, JSON.stringify({ runtimes: { fixture: { defaults: values } } }))
    assert.throws(() => loadRuntimeDefinitions(current.settings), /未声明嵌套/)
  }
})

test('undeclared structure blocks direct execution while frozen nested snapshots still normalize unchanged', t => {
  const current = fixture(t)
  const manifest = { ...current.manifest, configuration: { ...current.manifest.configuration, structure: undefined, defaults: {} } }
  fs.writeFileSync(path.join(current.root, 'services/executor/runtimes/fixture/runtime.yaml'), JSON.stringify(manifest))
  const definition = loadRuntimeDefinitions(current.settings)[0].descriptor
  for (const values of [{ native: { count: 1 } }, { native: [1] }, { native: null }] as JsonObject[]) {
    const saved = { version: 2 as const, runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest, values }
    const frozen = validateDefinition({ ...definition, configuration: { ...definition.configuration!, defaults: values } })
    const snapshot = JSON.stringify({ definition: frozen, options: saved })
    assert.deepEqual(normalizeAgentOptions(saved, frozen), saved)
    assert.equal(JSON.stringify({ definition: frozen, options: saved }), snapshot)
    assert.throws(() => parseOptionInputs(definition, optionsToInputs(frozen, saved)), /未声明嵌套/)
    assert.throws(() => resolveAgentOptions([definition], 'fixture', 'build', saved), /未声明嵌套/)
    assert.throws(() => resolveAgentOptions([frozen], 'fixture', 'build'), /未声明嵌套/)
    assert.throws(() => runtimeInvocationOptions('fixture', 'build', saved, current.settings), /未声明嵌套/)
  }
  const values = { count: 0, enabled: false, empty: '' }
  const options = { version: 2 as const, runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest, values }
  assert.deepEqual(resolveAgentOptions([definition], 'fixture', 'build', options).agentOptions?.values, values)
  assert.deepEqual(JSON.parse(runtimeInvocationOptions('fixture', 'build', options, current.settings).parameterFile!.contents), values)
})

test('contract digest survives template edits and local nested defaults while binding changes invalidate it', t => {
  const current = fixture(t)
  const before = loadRuntimeDefinitions(current.settings)[0].descriptor
  current.manifest.displayName = 'Renamed'
  current.manifest.configuration.defaults.solver.retry.attempts = 7
  current.write()
  const after = loadRuntimeDefinitions(current.settings)[0].descriptor
  assert.equal(before.definitionDigest, after.definitionDigest)
  assert.notEqual(before.templateRevision, after.templateRevision)
  assert.deepEqual(normalizeAgentOptions({ version: 2, runtimeKey: before.runtimeKey, definitionDigest: before.definitionDigest, values: { frozen: null } }, after)?.values, { frozen: null })
  const config = path.join(current.root, 'config/benchmark')
  fs.mkdirSync(config, { recursive: true })
  fs.writeFileSync(path.join(config, 'executor.local.yaml'), 'runtimes: { fixture: { defaults: { newFeature: { rows: [1, false, null] } } } }')
  const local = loadRuntimeDefinitions(current.settings)[0].descriptor
  assert.equal(local.definitionDigest, before.definitionDigest)
  assert.deepEqual(local.configuration?.defaults.newFeature, { rows: [1, false, null] })
  current.manifest.configuration.binding = { flag: '--parameters-file' }
  current.write()
  const changed = loadRuntimeDefinitions(current.settings)[0].descriptor
  assert.notEqual(changed.definitionDigest, local.definitionDigest)
  assert.throws(() => normalizeAgentOptions({ version: 2, runtimeKey: before.runtimeKey, definitionDigest: before.definitionDigest, values: {} }, changed), { code: 'AGENT_DEFINITION_CHANGED' })
  assert.equal(JSON.stringify(changed).includes('binding'), false)
})

test('json-file delivers new nested fields to real subprocesses and isolates concurrent files', t => {
  const { settings, root } = fixture(t, 'json-file', { flag: '--parameters-file', env: 'FIXTURE_PARAMETERS_FILE' })
  const descriptor = loadRuntimeDefinitions(settings)[0].descriptor
  const values: JsonObject = { solver: { retry: { enabled: false, newlyAdded: [0, null, { custom: 'a b;$(false)' }] } }, empty: {}, token: 'data' }
  const options = { version: 2 as const, runtimeKey: descriptor.runtimeKey, definitionDigest: descriptor.definitionDigest, values }
  const plan = runtimeInvocationOptions('fixture', 'agent', options, settings)
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.agent-insight-parameters-')), false)
  const first = prepareRuntimeInvocation(plan, path.relative(process.cwd(), root))
  const second = prepareRuntimeInvocation(plan, root)
  const file = first.env.FIXTURE_PARAMETERS_FILE
  assert.equal(path.isAbsolute(file), true)
  assert.notEqual(file, second.env.FIXTURE_PARAMETERS_FILE)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const result = spawnSync(process.execPath, ['-e', 'const fs=require("node:fs");const file=process.argv[process.argv.indexOf("--parameters-file")+1];if(file!==process.env.FIXTURE_PARAMETERS_FILE)process.exit(3);process.stdout.write(fs.readFileSync(file,"utf8"))', '--', ...first.args], { cwd: root, env: { ...process.env, ...first.env }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), values)
  first.cleanup(); first.cleanup()
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(second.env.FIXTURE_PARAMETERS_FILE), true)
  second.cleanup()
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.agent-insight-parameters-')), false)
})

test('json-arg delivers complete nested JSON as one literal argument', t => {
  const { settings, root } = fixture(t, 'json-arg', { flag: '--parameters-json' })
  const descriptor = loadRuntimeDefinitions(settings)[0].descriptor
  const values = { nested: { newlyAdded: { rows: [1, false, null, 'a b;$(touch unsafe)'] } } }
  const plan = runtimeInvocationOptions('fixture', 'agent', { version: 2, runtimeKey: descriptor.runtimeKey, definitionDigest: descriptor.definitionDigest, values }, settings)
  const prepared = prepareRuntimeInvocation(plan, root)
  try {
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.argv[process.argv.indexOf("--parameters-json")+1])', '--', ...prepared.args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), values)
    assert.equal(prepared.args.length, 2)
  } finally { prepared.cleanup() }
})

test('argv mapping supports nested JSON Pointers and explicit encodings and refuses to drop any unmapped value', t => {
  const { settings } = fixture(t, 'argv', { mappings: [
    { path: '/solver/retry/enabled', flag: '--retry', falseFlag: '--no-retry', booleanStyle: 'switch' },
    { path: '/solver/retry/attempts', flag: '--attempts' },
    { path: '/a~1b/~0key', flag: '--escaped', encoding: 'json' },
    { path: '/labels', flag: '--label', encoding: 'repeat' },
    { path: '/joined', flag: '--joined', encoding: 'join', separator: ':' },
  ] })
  const descriptor = loadRuntimeDefinitions(settings)[0].descriptor
  const options = (values: JsonObject) => ({ version: 2, runtimeKey: descriptor.runtimeKey, definitionDigest: descriptor.definitionDigest, values })
  const invocation = runtimeInvocationOptions('fixture', 'agent', options({ solver: { retry: { enabled: false, attempts: 0 } }, 'a/b': { '~key': [null, { a: 1 }] }, labels: ['a', 'b'], joined: [1, 2] }), settings)
  assert.deepEqual(invocation.args, ['--no-retry', '--attempts', '0', '--escaped', '[null,{"a":1}]', '--label', 'a', '--label', 'b', '--joined', '1:2'])
  assert.deepEqual(runtimeInvocationOptions('fixture', 'agent', options({}), settings).args, [])
  for (const value of [{ extra: { nested: 1 } }, { extra: {} }, { labels: [] }, { solver: { retry: { attempts: null } } }] as JsonObject[]) assert.throws(() => runtimeInvocationOptions('fixture', 'agent', options(value), settings))
})

test('ordinary client removes parameter files after successful execution and before-spawn failure', async t => {
  const current = fixture(t, 'json-file', { flag: '--parameters-file' })
  current.manifest.key = 'opencode'
  current.manifest.targets = [{ platform: 'opencode', agent: '*' }]
  const oldDirectory = path.join(current.root, 'services/executor/runtimes/fixture')
  const directory = path.join(current.root, 'services/executor/runtimes/opencode')
  fs.renameSync(oldDirectory, directory)
  fs.writeFileSync(path.join(directory, 'runtime.yaml'), JSON.stringify(current.manifest))
  const loader = runtimeRequire('../packages/agent-runtime/loader.cjs')
  const invoke = loader.runtimeInvocationOptions
  t.mock.method(loader, 'runtimeInvocationOptions', (platform: string, agent: string, options: unknown) => invoke(platform, agent, options, current.settings))
  const definition = loadRuntimeDefinitions(current.settings)[0].descriptor
  const values = { newFeature: { values: [null, false, { command: 'business' }] } }
  const options = { version: 2, runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest, values }
  const bin = path.join(current.root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'opencode'), `#!${process.execPath}
const fs = require('node:fs')
if (process.argv.includes('--help')) process.exit(0)
fs.writeFileSync('received.json', fs.readFileSync(process.env.AGENT_INSIGHT_PARAMETERS_FILE))
for (const kind of ['ready', 'session']) fs.writeSync(3, JSON.stringify({ protocol: 1, token: process.env.AGENT_INSIGHT_EVENT_TOKEN, kind, sessionId: 'ses_json_parameters' }) + '\\n')
console.log(JSON.stringify({ type: 'text', sessionID: 'ses_json_parameters', part: { type: 'text', text: 'done' } }))
`, { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`
  t.after(() => { process.env.PATH = previousPath })
  const client = runtimeRequire('../scripts/reliability-client.cjs')
  const payload = { platform: 'opencode', agent: 'build', input: 'fixture', cwd: current.root, timeoutSeconds: 10, agentOptions: options }
  const result = await client.runExperimentCase({ clientId: 'runtime-test', workspaceBase: current.root }, payload)
  assert.equal(result.traceId, 'ses_json_parameters')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(current.root, 'received.json'), 'utf8')), values)
  assert.equal(fs.readdirSync(current.root).some(name => name.startsWith('.agent-insight-parameters-')), false)
  await assert.rejects(client.runExperimentCase({ clientId: 'runtime-test', workspaceBase: current.root }, { ...payload, onBeforeChildSpawn: () => { throw new Error('fixture spawn failure') } }), /fixture spawn failure/)
  assert.equal(fs.readdirSync(current.root).some(name => name.startsWith('.agent-insight-parameters-')), false)
})

test('MCTS prepares the same JSON channel in its run directory and cleans up on success and failure', async t => {
  const current = fixture(t, 'json-file', { flag: '--parameters-file' })
  current.manifest.targets = [{ platform: 'pi-mcts', agent: 'pi-mcts' }]
  current.write()
  const loader = runtimeRequire('../packages/agent-runtime/loader.cjs')
  const invoke = loader.runtimeInvocationOptions
  t.mock.method(loader, 'runtimeInvocationOptions', (platform: string, agent: string, options: unknown) => invoke(platform, agent, options, current.settings))
  const descriptor = loadRuntimeDefinitions(current.settings)[0].descriptor
  const repo = path.join(current.root, 'MCTS')
  const collector = path.join(current.root, 'collector')
  const files: Record<string, string> = {
    [path.join(repo, 'testcases_union/run_union.sh')]: '#!/bin/sh\nexit 0\n',
    [path.join(repo, 'testcases_union/config.env')]: '',
    [path.join(repo, 'testcases_union/core/main.py')]: '--output-dir',
    [path.join(repo, '.venv/bin/python')]: '#!/bin/sh\necho 3.11\n',
    [path.join(collector, 'run.cjs')]: '', [path.join(collector, 'core.cjs')]: '', [path.join(collector, 'gateway.cjs')]: '',
    [path.join(collector, 'config.json')]: '{"proxyEnabled":true,"apiKey":"fixture"}',
    [path.join(current.root, 'shared/trace-transport.cjs')]: '', [path.join(current.root, 'shared/collaboration-transport.cjs')]: '',
  }
  for (const [file, contents] of Object.entries(files)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents, { mode: 0o700 }) }
  const runtime = runtimeRequire('../services/executor/src/mcts-runtime.cjs')
  const values = { nested: { newParameter: [null, false, { x: 3 }] } }
  const config = { mctsRepoDir: repo, mctsTraceLauncher: path.join(collector, 'run.cjs') }
  let counter = 0
  for (const fail of [false, true]) {
    const runId = `erun_${String(++counter).repeat(32)}`
    const output = path.join(repo, 'testcases_union/output/sweverified', runId)
    const payload = { platform: 'pi-mcts', agent: 'pi-mcts', benchmarkKey: 'swe-bench',
      benchmarkPayload: { instanceId: 'test-1', repo: 'fixture/repo', baseCommit: 'a'.repeat(40) },
      workspace: { repository: 'https://github.com/fixture/repo.git', revision: 'a'.repeat(40) },
      correlation: { caseRunId: runId }, cwd: current.root, timeoutSeconds: 60,
      agentOptions: { version: 2, runtimeKey: descriptor.runtimeKey, definitionDigest: descriptor.definitionDigest, values },
    }
    let parameterFile = ''
    const run = runtime.runMctsBenchmarkCase(config, payload, async (command: string, args: string[], options: { env: Record<string, string> }) => {
      if (command !== process.execPath) return { stdout: '', stderr: '' }
      parameterFile = options.env.AGENT_INSIGHT_PARAMETERS_FILE
      assert.ok(parameterFile.startsWith(output + path.sep))
      assert.equal(args[args.indexOf('--parameters-file') + 1], parameterFile)
      const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.env.AGENT_INSIGHT_PARAMETERS_FILE,"utf8"))'], { env: { ...process.env, ...options.env }, encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr)
      assert.deepEqual(JSON.parse(child.stdout), values)
      if (fail) throw new Error('fixture MCTS failure')
      fs.writeFileSync(path.join(output, 'artifact.patch'), 'fixture patch')
      const ledger = path.join(output, '.agent-insight/otel_data/mcts-xgovernor/fixture/runtime-ledger.json')
      fs.mkdirSync(path.dirname(ledger), { recursive: true })
      fs.writeFileSync(ledger, JSON.stringify({ runs: [{ sessionId: `mcts.run.${'b'.repeat(32)}` }] }))
      return { stdout: '', stderr: '' }
    })
    if (fail) await assert.rejects(run, /fixture MCTS failure/)
    else assert.deepEqual((await run).agentOptions.values, values)
    assert.ok(parameterFile)
    assert.equal(fs.existsSync(parameterFile), false)
    assert.equal(fs.readdirSync(output).some(name => name.startsWith('.agent-insight-parameters-')), false)
  }
})


test('near-limit compact JSON remains editable and deliverable when pretty formatting would exceed the limit', t => {
  const current = fixture(t, 'json-arg', { flag: '--parameters-json' })
  const values = { rows: Array.from({ length: 6000 }, () => 'x'.repeat(40)) }
  const compact = JSON.stringify(values)
  assert.ok(Buffer.byteLength(compact) < 256 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(values, null, 2)) > 256 * 1024)
  const formatted = formatParameterJson(values)
  assert.equal(formatted, compact)
  const manifest = { ...current.manifest, configuration: { ...current.manifest.configuration, defaults: values } }
  fs.writeFileSync(path.join(current.root, 'services/executor/runtimes/fixture/runtime.yaml'), JSON.stringify(manifest))
  const definition = loadRuntimeDefinitions(current.settings)[0].descriptor
  const inputs = optionsToInputs(definition)
  assert.equal(inputs.__json, compact)
  assert.deepEqual(parseOptionInputs(definition, inputs).values, values)
  const plan = runtimeInvocationOptions('fixture', 'agent', undefined, current.settings)
  assert.equal(plan.args[1], compact)
  assert.deepEqual(parseParameterJson(plan.args[1]), values)
})


test('MCTS task identity flags cannot be overridden by a parameter mapping', t => {
  const current = fixture(t, 'argv', { mappings: [{ path: '/solver', flag: '--task-id', encoding: 'json' }] })
  assert.throws(() => loadRuntimeDefinitions(current.settings), /task-id/)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

const { generate } = require('../scripts/benchmark/generate-catalog.cjs')
const { createBenchmarkExecutor } = require('../services/executor/src/index.cjs')

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-catalog-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageDir = path.join(root, 'benchmarks', 'fixture')
  for (const directory of ['adapter', 'evaluator', 'schemas', 'executor']) {
    fs.mkdirSync(path.join(packageDir, directory), { recursive: true })
  }
  const write = (file: string, content: string) => fs.writeFileSync(path.join(packageDir, file), content)
  write('adapter/index.ts', 'export const fixtureAdapter = {}\n')
  write('evaluator/entrypoint.cjs', 'module.exports = {}\n')
  write('evaluator/evaluator.yaml', `
key: fixture
runtime: script-package
entrypoint: ./entrypoint.cjs
command: node
network: deny
resources: { cpu: 1, memoryMiB: 128, timeoutSeconds: 30 }
`)
  write('schemas/case.schema.json', '{"type":"object"}')
  write('schemas/result.schema.json', '{"type":"object"}')
  write('executor/policy.cjs', `
const { remote } = require('./remote.cjs')
module.exports.createGitSourcePolicy = ({ home, readLocalSetting }) => ({
  home, resolve: () => ({ remotes: [remote], configured: readLocalSetting('FIXTURE_GIT_SOURCE', home, {}) }),
})
`)
  write('executor/remote.cjs', "module.exports.remote = 'fixture-remote'\n")
  const manifest = `
key: fixture
displayName: Fixture
protocols: { agentTask: agent-task/v1, evaluation: benchmark-evaluation/v1 }
implementation:
  adapter: ./adapter/index.ts
  adapterExport: fixtureAdapter
  evaluator: ./evaluator/evaluator.yaml
schemas: { case: ./schemas/case.schema.json, rawResult: ./schemas/result.schema.json }
executor:
  gitSourcePolicy: ./executor/policy.cjs
  requiredCapabilities: [git-workspace/v1, file/v1]
  defaultTimeoutSeconds: 30
submission:
  artifacts:
    - { name: answer.txt, mediaType: text/plain, collector: file/v1, maxBytes: 1024 }
evaluation:
  evaluatorKey: fixture
  defaultTimeoutSeconds: 30
  resources: { cpu: 1, memoryMiB: 128 }
result:
  primaryMetric: { key: passed, aggregation: boolean-rate }
`
  write('benchmark.yaml', manifest)
  return { root, packageDir, write, manifest }
}

test('catalog discovers policy files, preserves dependencies and fingerprints implementation changes', t => {
  const f = fixture(t)
  assert.deepEqual(generate(f.root), ['fixture'])
  const generated = path.join(f.root, 'generated', 'benchmark-catalog')
  const original = fs.readFileSync(path.join(generated, 'executors.cjs'), 'utf8')
  generate(f.root)
  assert.equal(fs.readFileSync(path.join(generated, 'executors.cjs'), 'utf8'), original)
  const catalog = require(path.join(generated, 'executors.cjs'))
  assert.deepEqual(catalog.generatedExecutorPackageFiles, [
    'benchmarks/fixture/executor/policy.cjs', 'benchmarks/fixture/executor/remote.cjs',
  ])
  const digest = JSON.parse(fs.readFileSync(path.join(generated, 'catalog-lock.json'), 'utf8')).packages[0]
  f.write('executor/remote.cjs', "module.exports.remote = 'updated-remote'\n")
  generate(f.root)
  const updated = JSON.parse(fs.readFileSync(path.join(generated, 'catalog-lock.json'), 'utf8')).packages[0]
  assert.notEqual(updated.digest, digest.digest)
  assert.equal(updated.evaluatorDigest, digest.evaluatorDigest)

  const installed = path.join(f.root, 'installed')
  fs.mkdirSync(path.join(installed, 'generated', 'benchmark-catalog'), { recursive: true })
  fs.copyFileSync(path.join(generated, 'executors.cjs'), path.join(installed, 'generated', 'benchmark-catalog', 'executors.cjs'))
  for (const file of catalog.generatedExecutorPackageFiles) {
    const target = path.join(installed, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(f.root, file), target)
  }
  for (const file of ['source-policy-registry.cjs', 'git-source.cjs']) {
    fs.copyFileSync(path.resolve(__dirname, '../services/executor/src', file), path.join(installed, file))
  }
  fs.renameSync(f.packageDir, `${f.packageDir}-moved`)
  fs.writeFileSync(path.join(installed, '.env'), 'FIXTURE_GIT_SOURCE=/fixture-cache\n')
  const policies = require(path.join(installed, 'source-policy-registry.cjs')).createGitSourcePolicies({ home: installed })
  assert.deepEqual([...policies.keys()], ['fixture'])
  assert.deepEqual(policies.get('fixture').resolve(), { remotes: ['updated-remote'], configured: '/fixture-cache' })
})

test('packages without a policy produce an empty registry', t => {
  const f = fixture(t)
  f.write('benchmark.yaml', f.manifest.replace('  gitSourcePolicy: ./executor/policy.cjs\n', ''))
  generate(f.root)
  const catalog = require(path.join(f.root, 'generated', 'benchmark-catalog', 'executors.cjs'))
  assert.deepEqual(catalog.generatedGitSourcePolicyDescriptors, [])
  assert.deepEqual(catalog.generatedExecutorPackageFiles, [])
})

test('environment modules are distributed and fingerprinted without a Git source policy', t => {
  const f = fixture(t)
  f.write('executor/environment.cjs', 'module.exports = { checkEnvironment() {}, prepareEnvironment() {} }\n')
  f.write('benchmark.yaml', f.manifest.replace('  gitSourcePolicy: ./executor/policy.cjs\n', '  environmentPreparation:\n    protocol: execution-environment/v1\n    implementation: ./executor/environment.cjs\n'))
  generate(f.root)
  const generated = path.join(f.root, 'generated/benchmark-catalog')
  const catalog = require(path.join(generated, 'executors.cjs'))
  assert.deepEqual(catalog.generatedGitSourcePolicyDescriptors, [])
  assert.equal(catalog.generatedEnvironmentPreparationDescriptors[0].datasetAdapterKey, 'fixture')
  assert(catalog.generatedExecutorPackageFiles.includes('benchmarks/fixture/executor/environment.cjs'))
  const digest = fs.readFileSync(path.join(generated, 'catalog-lock.json'), 'utf8')
  f.write('executor/environment.cjs', 'module.exports = { checkEnvironment() { return "updated" }, prepareEnvironment() {} }\n')
  generate(f.root)
  assert.notEqual(fs.readFileSync(path.join(generated, 'catalog-lock.json'), 'utf8'), digest)
})

test('catalog rejects invalid policy paths, formats and incompatible capabilities', t => {
  const f = fixture(t)
  const invalid = [
    ['../outside.cjs', /包内/],
    ['./executor/missing.cjs', /不存在/],
    ['./adapter/index.ts', /CommonJS/],
  ] as const
  for (const [entrypoint, expected] of invalid) {
    f.write('benchmark.yaml', f.manifest.replace('./executor/policy.cjs', entrypoint))
    assert.throws(() => generate(f.root), expected)
  }
  f.write('benchmark.yaml', f.manifest.replace('git-workspace/v1, ', ''))
  assert.throws(() => generate(f.root), /git-workspace/)
  f.write('benchmark.yaml', f.manifest.replace('executor:\n', 'executor:\n  supported: false\n'))
  assert.throws(() => generate(f.root), /执行能力/)
  f.write('benchmark.yaml', f.manifest)
  const outside = path.join(f.root, 'outside.cjs')
  fs.writeFileSync(outside, 'module.exports = {}')
  fs.symlinkSync(outside, path.join(f.packageDir, 'executor', 'escape.cjs'))
  assert.throws(() => generate(f.root), /越出接入包/)
})

test('explicit policy overrides and empty maps bypass default registration', t => {
  const f = fixture(t)
  for (const sourcePolicies of [new Map(), new Map([['fixture', { resolve() {} }]])]) {
    const executor = createBenchmarkExecutor({
      clientId: 'fixture', deviceCredential: 'fixture', insightBaseUrl: 'http://localhost',
      baseDir: path.join(f.root, 'client'), sourcePolicies,
      runAgent: async () => { throw new Error('Agent must not execute') },
    })
    t.after(() => executor.close())
    assert.equal(executor.runner.workspaceProviders.get('git').sourcePolicies, sourcePolicies)
  }
})

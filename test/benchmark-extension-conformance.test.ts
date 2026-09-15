import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { getBenchmarkAdapter, listBenchmarkAdapters } from '@/lib/benchmark/adapter-registry'

const repositoryRoot = path.resolve(__dirname, '..')
const generator = require('../scripts/benchmark/generate-catalog.cjs') as {
  generate(rootDir?: string): string[]
}
const executorModule = require('../services/executor/src/index.cjs') as any
const evaluatorModule = require('../services/evaluator/src/evaluator-registry.cjs') as any

test('benchmark package catalog is reproducible and registers SWE-bench without core imports', () => {
  const generatedDir = path.join(repositoryRoot, 'generated', 'benchmark-catalog')
  generator.generate(repositoryRoot)
  const first = ['manifests.ts', 'adapters.ts', 'evaluators.cjs', 'catalog-lock.json']
    .map((name) => fs.readFileSync(path.join(generatedDir, name), 'utf8'))
  assert.deepEqual(generator.generate(repositoryRoot), ['swe-bench'])
  const second = ['manifests.ts', 'adapters.ts', 'evaluators.cjs', 'catalog-lock.json']
    .map((name) => fs.readFileSync(path.join(generatedDir, name), 'utf8'))
  assert.deepEqual(second, first)
  assert.equal(getBenchmarkAdapter('swe-bench').manifest.adapterKey, 'swe-bench')
  assert.deepEqual(getBenchmarkAdapter('swe-bench').manifest.result.primaryMetric, {
    key: 'resolved', aggregation: 'boolean-rate',
  })
  assert.deepEqual(getBenchmarkAdapter('swe-bench').manifest.dataset?.profiles, [{
    key: 'verified',
    displayName: 'SWE-bench Verified',
    acceptedExtensions: ['.parquet'],
    expectedCaseCount: 500,
  }])
  assert.equal(
    getBenchmarkAdapter('swe-bench').manifest.presentation?.caseTable.columns[1]?.label,
    'Instance ID',
  )
  assert.match(
    fs.readFileSync(path.join(generatedDir, 'dataset-loaders.ts'), 'utf8'),
    /sweBenchDatasetLoader/,
  )
  assert.deepEqual(listBenchmarkAdapters().map((item) => item.adapterKey), ['swe-bench'])
  assert.doesNotMatch(fs.readFileSync(path.join(repositoryRoot, 'src/lib/benchmark/adapter-registry.ts'), 'utf8'), /sweBenchAdapter/)
  assert.doesNotMatch(fs.readFileSync(path.join(repositoryRoot, 'services/executor/src/index.cjs'), 'utf8'), /SweBench/)
  assert.doesNotMatch(fs.readFileSync(path.join(repositoryRoot, 'services/evaluator/src/service.cjs'), 'utf8'), /SweBench/)
})

test('a new benchmark is discovered by adding only its package directory', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'benchmark-catalog-extension-'))
  const packageDir = path.join(root, 'benchmarks', 'fixture')
  await fsp.mkdir(path.join(packageDir, 'adapter'), { recursive: true })
  await fsp.mkdir(path.join(packageDir, 'evaluator'), { recursive: true })
  await fsp.mkdir(path.join(packageDir, 'schemas'), { recursive: true })
  await fsp.writeFile(path.join(packageDir, 'adapter', 'index.ts'), 'export const fixtureAdapter = {}\n')
  await fsp.writeFile(path.join(packageDir, 'evaluator', 'entrypoint.cjs'), 'process.exit(0)\n')
  await fsp.writeFile(path.join(packageDir, 'evaluator', 'evaluator.yaml'), `
key: fixture
runtime: script-package
entrypoint: ./entrypoint.cjs
command: node
network: deny
resources: { cpu: 1, memoryMiB: 128, timeoutSeconds: 30 }
`)
  await fsp.writeFile(path.join(packageDir, 'schemas', 'case.schema.json'), '{"type":"object"}\n')
  await fsp.writeFile(path.join(packageDir, 'schemas', 'result.schema.json'), '{"type":"object"}\n')
  await fsp.writeFile(path.join(packageDir, 'benchmark.yaml'), `
key: fixture
displayName: Fixture
protocols:
  agentTask: agent-task/v1
  evaluation: benchmark-evaluation/v1
implementation:
  adapter: ./adapter/index.ts
  adapterExport: fixtureAdapter
  evaluator: ./evaluator/evaluator.yaml
schemas:
  case: ./schemas/case.schema.json
  rawResult: ./schemas/result.schema.json
executor:
  requiredCapabilities: [git-workspace/v1, agent-runtime/opencode/v1, file/v1]
  defaultTimeoutSeconds: 30
submission:
  artifacts:
    - name: answer.txt
      mediaType: text/plain
      collector: file/v1
      maxBytes: 1024
evaluation:
  evaluatorKey: fixture
  defaultTimeoutSeconds: 30
  resources: { cpu: 1, memoryMiB: 128 }
result:
  primaryMetric: { key: passed, aggregation: boolean-rate }
`)
  assert.deepEqual(generator.generate(root), ['fixture'])
  assert.match(
    await fsp.readFile(path.join(root, 'generated', 'benchmark-catalog', 'adapters.ts'), 'utf8'),
    /fixtureAdapter/,
  )
  await fsp.rm(root, { recursive: true, force: true })
})

test('generic executor selects capabilities and collects multiple artifacts without a Benchmark profile', async () => {
  const states: Record<string, unknown>[] = []
  const uploaded: string[] = []
  let agentInput = ''
  const collector = (content: string) => ({
    async collect(contract: { name: string; mediaType: string }) {
      const bytes = Buffer.from(content)
      return {
        name: contract.name,
        mediaType: contract.mediaType,
        bytes,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      }
    },
  })
  const runner = new executorModule.BenchmarkExecutionRunner({
    store: {
      async writeState(_runId: string, state: Record<string, unknown>) { states.push(state) },
      async writeArtifact(_runId: string, name: string) { return `/tmp/${name}` },
    },
    workspaceProviders: new executorModule.WorkspaceProviderRegistry([['fixture', {
      rootDir: '/tmp',
      async prepare() { return { path: '/tmp/workspace', baseCommit: 'a'.repeat(40) } },
    }]]),
    agentRuntimes: new executorModule.AgentRuntimeRegistry([['fixture-agent', {
      async run(input: { input: string }) {
        agentInput = input.input
        return { traceId: 'trace_fixture', exitCode: 0 }
      },
    }]]),
    policyEnforcer: { async apply() { return {} }, async release() {} },
    collectors: new executorModule.ArtifactCollectorRegistry([
      ['answer/v1', collector('answer')],
      ['trace/v1', collector('trace')],
    ]),
    cleanupManager: { async cleanup() { return { status: 'succeeded' } } },
    callback: {
      async progress() {},
      async uploadArtifact(_request: unknown, artifact: { name: string }) {
        uploaded.push(artifact.name)
        return { artifactId: `artifact_${artifact.name}` }
      },
      async complete(_request: unknown, completion: { artifacts: unknown[] }) {
        assert.equal(completion.artifacts.length, 2)
      },
    },
  })
  await runner.execute({
    runId: 'run_fixture',
    timeoutSeconds: 30,
    callbackBaseUrl: 'https://example.test/callback',
    task: {
      benchmark: { key: 'new-benchmark' },
      context: { runId: 'run_fixture', experimentId: 'exp_fixture' },
      workspace: { provider: 'fixture' },
      policy: {},
      task: { instruction: 'Use this complete adapter-rendered instruction.' },
      agentConfig: { platform: 'fixture-agent', agent: 'build', timeoutSeconds: 30 },
      submission: { requiredArtifacts: [
        { name: 'answer.json', mediaType: 'application/json', collector: 'answer/v1', maxBytes: 1024 },
        { name: 'trace.json', mediaType: 'application/json', collector: 'trace/v1', maxBytes: 1024 },
      ] },
    },
  })
  assert.equal(agentInput, 'Use this complete adapter-rendered instruction.')
  assert.deepEqual(uploaded, ['answer.json', 'trace.json'])
  assert.ok(states.some((state) => state.stage === 'terminal'))
})

test('file Evaluator Entrypoint honors doctor, request/result and evidence contracts', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'benchmark-entrypoint-'))
  const entrypoint = path.join(root, 'fixture-evaluator.cjs')
  await fsp.writeFile(entrypoint, `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === 'doctor') { process.stdout.write(JSON.stringify({ ready: true, runtimeFacts: { fixture: true } })); process.exit(0) }
const requestPath = args[args.indexOf('--request') + 1]
const outputPath = args[args.indexOf('--output') + 1]
const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
const evidenceDir = path.join(path.dirname(outputPath), 'evidence')
fs.mkdirSync(evidenceDir, { recursive: true })
fs.writeFileSync(path.join(evidenceDir, 'report.json'), JSON.stringify({ artifactCount: request.artifacts.length }))
fs.writeFileSync(outputPath, JSON.stringify({
  protocolVersion: 'evaluator-output/v1',
  completion: { status: 'completed', rawResult: { passed: true }, runtimeFacts: {}, cleanup: { status: 'succeeded' } },
  evidenceFiles: [{ name: 'report.json', kind: 'report', mediaType: 'application/json', path: 'evidence/report.json' }]
}))
`, { mode: 0o700 })
  const descriptor = {
    key: 'fixture',
    benchmarkKey: 'fixture',
    runtime: 'script-package',
    command: 'node',
    entrypoint,
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    requiredArtifacts: [{ name: 'answer.txt', mediaType: 'text/plain', collector: 'file/v1', maxBytes: 1024 }],
    rawResultSchema: {
      type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } }, additionalProperties: false,
    },
  }
  const evaluator = new evaluatorModule.FileEvaluatorEntrypoint(descriptor)
  const health = await evaluator.checkReady({ dataDir: root, hostArch: process.arch })
  assert.equal(health.ready, true)
  const bytes = Buffer.from('answer')
  const artifactPath = path.join(root, 'answer.txt')
  await fsp.writeFile(artifactPath, bytes)
  const job = {
    protocolVersion: 'benchmark-evaluation/v1',
    evaluationId: 'eval_fixture',
    executionRunId: 'run_fixture',
    benchmark: { key: 'fixture' },
    evaluator: { key: 'fixture' },
    artifacts: [{
      artifactId: 'artifact_fixture', executionRunId: 'run_fixture', name: 'answer.txt',
      mediaType: 'text/plain', sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, sizeBytes: bytes.length,
    }],
    limits: { timeoutSeconds: 30, cpu: 1, memoryMiB: 128 },
    payload: { expected: 'answer' },
  }
  evaluator.validateJob(job)
  const result = await evaluator.evaluate({
    job,
    artifacts: new Map([['answer.txt', { descriptor: job.artifacts[0], path: artifactPath }]]),
    workDir: path.join(root, 'job'),
    signal: new AbortController().signal,
    async reportProgress() {},
  })
  assert.deepEqual(result.completion.rawResult, { passed: true })
  assert.equal(fs.existsSync(result.evidenceFiles[0].path), true)
  await fsp.rm(root, { recursive: true, force: true })
})

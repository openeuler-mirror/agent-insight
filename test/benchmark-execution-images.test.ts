import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { loadProjectConfig } from '../packages/project-config/index.cjs'

const require = createRequire(import.meta.url)
const { prepareExecutionImage } = require('../services/executor/src/execution-images.cjs')
const instanceId = 'pallets__flask-5014'
const official = 'swebench/sweb.eval.x86_64.pallets_1776_flask-5014:latest'
const imageId = `sha256:${'b'.repeat(64)}`
const mirrors = ['swr.example.test/benchmark/a', 'swr.example.test/benchmark/b']

function fixture(t: TestContext, images: Record<string, unknown> = {}, daemonArch = 'x86_64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-images-'))
  const previous = { directory: process.env.AGENT_INSIGHT_CONFIG_DIR, snapshot: process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON }
  process.env.AGENT_INSIGHT_CONFIG_DIR = root
  delete process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON
  for (const scope of ['executor', 'evaluator']) {
    fs.writeFileSync(path.join(root, `${scope}.yaml`), JSON.stringify({ benchmarks: { 'swe-bench': { images: { verifiedMirrorRepositories: mirrors, proxyPrefix: 'proxy.example.test', ...images } } } }))
  }
  t.after(() => {
    if (previous.directory === undefined) delete process.env.AGENT_INSIGHT_CONFIG_DIR
    else process.env.AGENT_INSIGHT_CONFIG_DIR = previous.directory
    if (previous.snapshot === undefined) delete process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON
    else process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON = previous.snapshot
    fs.rmSync(root, { recursive: true, force: true })
  })
  const task = {
    benchmark: { key: 'swe-bench' }, task: { benchmarkPayload: { instanceId } },
    execution: { environment: { image: official, arch: 'amd64' } },
  }
  const calls: string[][] = []
  const unavailable = new Set<string>()
  let cached = false
  const docker = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'info') return { stdout: daemonArch }
    if (args[0] === 'pull') {
      if (unavailable.has(args[1])) throw new Error('registry unavailable')
      cached = true
      return { stdout: '' }
    }
    if (args[0] === 'tag') return { stdout: '' }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (!cached) throw new Error('not cached')
      return { stdout: args.includes('--format') ? `[]|${imageId}` : JSON.stringify([{ Id: imageId, Architecture: daemonArch === 'x86_64' ? 'amd64' : 'arm64', Os: 'linux', RepoDigests: [] }]) }
    }
    throw new Error(`unexpected Docker call: ${args}`)
  }
  return { root, task, calls, unavailable, docker, cache: () => { cached = true } }
}

test('execution falls back between its configured SWR mirror repositories', async t => {
  const f = fixture(t)
  f.unavailable.add(`${mirrors[0]}:${instanceId}`)
  const result = await prepareExecutionImage(f.task, { docker: f.docker, workDir: f.root })
  assert.deepEqual(f.calls.filter(args => args[0] === 'pull').map(args => args[1]), mirrors.map(repository => `${repository}:${instanceId}`))
  assert.deepEqual(f.calls.find(args => args[0] === 'tag'), ['tag', `${mirrors[1]}:${instanceId}`, official])
  assert.equal(result.image.Id, imageId)
  assert.equal(result.resolution.resolvedImageReference, `${mirrors[1]}:${instanceId}`)
  assert.equal(f.calls.at(-1)?.[2], imageId)
  assert.equal(f.task.execution.environment.image, official)
})

test('execution falls through its SWR and proxy failures to the official image', async t => {
  const f = fixture(t)
  const references = [...mirrors.map(repository => `${repository}:${instanceId}`), `proxy.example.test/${official}`, official]
  references.slice(0, -1).forEach(reference => f.unavailable.add(reference))
  const result = await prepareExecutionImage(f.task, { docker: f.docker, workDir: f.root })
  assert.deepEqual(f.calls.filter(args => args[0] === 'pull').map(args => args[1]), references)
  assert.equal(result.resolution.resolvedImageReference, official)
})

test('an executor proxy success avoids pulling the official registry and restores the official tag', async t => {
  const f = fixture(t, { verifiedMirrorRepositories: [] })
  const result = await prepareExecutionImage(f.task, { docker: f.docker, workDir: f.root })
  assert.deepEqual(f.calls.filter(args => args[0] === 'pull'), [['pull', `proxy.example.test/${official}`]])
  assert.equal(result.resolution.resolvedImageReference, `proxy.example.test/${official}`)
  assert.deepEqual(f.calls.find(args => args[0] === 'tag'), ['tag', `proxy.example.test/${official}`, official])
})

test('a cached offline execution image needs no registry digest or pull', async t => {
  const f = fixture(t)
  f.cache()
  const result = await prepareExecutionImage(f.task, { docker: f.docker, workDir: f.root })
  assert.equal(result.resolution.pinnedImage, imageId)
  assert.equal(f.calls.some(args => ['pull', 'tag'].includes(args[0])), false)
})

test('execution image preparation does not read evaluator configuration', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, 'evaluator.yaml'), '{"unsupportedEvaluatorSetting":true}')
  const result = await prepareExecutionImage(f.task, { docker: f.docker, workDir: f.root })
  assert.equal(result.resolution.resolvedImageReference, `${mirrors[0]}:${instanceId}`)
  assert.throws(() => loadProjectConfig('evaluator'), /unsupportedEvaluatorSetting/)
})

test('other benchmarks retain generic OCI image preparation', async t => {
  const f = fixture(t)
  f.task.benchmark.key = 'another-benchmark'
  f.task.execution.environment.image = 'example/case:latest'
  const result = await prepareExecutionImage(f.task, { docker: f.docker, workDir: f.root })
  assert.equal(result.image.Id, imageId)
  assert.equal(result.resolution, undefined)
  assert.deepEqual(f.calls.filter(args => args[0] === 'pull'), [['pull', '--platform', 'linux/amd64', 'example/case:latest']])
  assert.equal(f.calls.some(args => args[0] === 'info'), false)
})

test('ARM execution skips x86 SWR mirrors and retains its task architecture', async t => {
  const f = fixture(t, {}, 'arm64')
  f.task.execution.environment.arch = 'arm64'
  f.task.execution.environment.image = official.replace('.x86_64.', '.arm64.')
  const result = await prepareExecutionImage(f.task, { docker: f.docker, workDir: f.root })
  assert.equal(result.image.Architecture, 'arm64')
  assert.deepEqual(f.calls.filter(args => args[0] === 'pull'), [['pull', `proxy.example.test/${f.task.execution.environment.image}`]])
})

test('an execution task cannot silently switch to another Docker architecture', async t => {
  const f = fixture(t, {}, 'arm64')
  await assert.rejects(prepareExecutionImage(f.task, { docker: f.docker, workDir: f.root }), { code: 'SWE_IMAGE_ARCH_MISMATCH' })
  assert.deepEqual(f.calls.map(args => args[0]), ['info'])
})

test('cancelling a SWR pull stops further registry fallback', async t => {
  const f = fixture(t)
  const controller = new AbortController()
  const pulls: string[] = []
  const docker = async (args: string[]) => {
    if (args[0] === 'pull') { pulls.push(args[1]); controller.abort(); throw new Error('pull cancelled') }
    return f.docker(args)
  }
  await assert.rejects(prepareExecutionImage(f.task, { docker, workDir: f.root, signal: controller.signal }), /pull cancelled/)
  assert.deepEqual(pulls, [`${mirrors[0]}:${instanceId}`])
})

test('executor image configuration can change without overriding evaluator settings', t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, 'executor.local.yaml'), JSON.stringify({ benchmarks: { 'swe-bench': { images: { verifiedMirrorRepositories: [], arch: 'arm64' } } } }))
  const executor = loadProjectConfig('executor').benchmarks['swe-bench'].images
  const evaluator = loadProjectConfig('evaluator').benchmarks['swe-bench'].images
  assert.deepEqual(executor.verifiedMirrorRepositories, [])
  assert.deepEqual(evaluator.verifiedMirrorRepositories, mirrors)
  assert.equal(executor.arch, 'arm64')
  assert.equal(evaluator.arch, 'auto')
  fs.writeFileSync(path.join(f.root, 'executor.local.yaml'), JSON.stringify({ benchmarks: { 'swe-bench': { images: { verifiedMirrorRepositories: ['https://invalid.test/repository'] } } } }))
  assert.throws(() => loadProjectConfig('executor'), /verifiedMirrorRepositories/)
})

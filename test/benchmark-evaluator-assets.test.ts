import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

const { EvaluatorAssets } = require('../services/evaluator/src/evaluator-assets.cjs')
const { FileEvaluatorEntrypoint } = require('../services/evaluator/src/evaluator-registry.cjs')

const digest = 'a'.repeat(64)
const descriptor = {
  key: 'fixture', benchmarkKey: 'fixture', runtime: 'oci-container',
  assets: {
    image: `registry.example/team/assets@sha256:${digest}`,
    sourcePath: '/release', releaseId: 'v1', bundleDigest: `sha256:${'b'.repeat(64)}`,
    directoryEnv: 'FIXTURE_ASSETS_DIR', verifyCommand: 'python3', verifyEntrypoint: '/verify.py',
  },
}

async function fixture(t: TestContext, settings: { custom?: boolean, pullFails?: boolean, corrupt?: boolean, shared?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evaluator-assets-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const calls: string[][] = []
  const base = settings.custom ? path.join(directory, 'custom') : path.join(directory, 'benchmark-assets/fixture')
  const root = path.join(base, digest)
  const runner = async (command: { entrypoint: string }, args: string[]) => {
    calls.push([command.entrypoint, ...args])
    if (command.entrypoint === 'python3') {
      assert.deepEqual(args.slice(2), ['v1', descriptor.assets.bundleDigest])
      assert.equal(await fs.readFile(path.join(args[1], 'asset'), 'utf8'), 'verified fixture')
    } else if (args[0] === 'inspect') {
      return { stdout: JSON.stringify([{ Mounts: settings.shared === false ? [] : [{ Type: 'volume', Destination: directory }] }]) }
    } else if (args[0] === 'pull' && settings.pullFails) {
      throw new Error('registry unavailable')
    } else if (args[0] === 'cp') {
      await fs.writeFile(path.join(args[2], 'asset'), settings.corrupt ? 'damaged' : 'verified fixture')
    }
    return { stdout: '' }
  }
  const options = { dataDir: directory, retryDelayMs: 0, environment: {
    HOSTNAME: 'controller', ...(settings.custom ? { FIXTURE_ASSETS_DIR: base } : {}),
  } }
  return { directory, root, base, calls, runner, options, manager: new EvaluatorAssets(descriptor, runner, options) }
}

test('asset installation shares concurrent preparation, installs atomically and reuses verified disk cache', async (t) => {
  const f = await fixture(t)
  assert.throws(() => f.manager.assertReady(), { code: 'EVALUATOR_ASSETS_PREPARING', retryable: true })
  const roots = await Promise.all(Array.from({ length: 5 }, () => f.manager.ensure()))
  assert.deepEqual(roots, Array(5).fill(f.root))
  assert.equal(f.calls.filter(args => args[1] === 'pull').length, 1)
  assert.equal(f.calls.filter(args => args[1] === 'create').length, 1)
  assert.ok(f.calls.every(args => args[1] !== 'run' && args[1] !== 'start'))
  assert.equal(f.calls.filter(args => args[1] === 'rm').length, 1)
  assert.deepEqual(await fs.readdir(f.base), [digest])
  f.calls.length = 0
  const restarted = new EvaluatorAssets(descriptor, f.runner, f.options)
  assert.equal(await restarted.ensure(), f.root)
  assert.deepEqual(f.calls.map(args => args[0] === 'python3' ? 'verify' : args[1]), ['inspect', 'verify'])
})

test('custom asset storage is propagated per evaluator and benchmark without assets stays unchanged', async (t) => {
  const f = await fixture(t, { custom: true })
  const evaluator = new FileEvaluatorEntrypoint(descriptor, undefined, { ...f.options, assetRunner: f.runner })
  await evaluator.prepareAssets()
  assert.deepEqual(evaluator.assetEnvironment(), { EVALUATOR_ASSETS_DIR: f.root })
  const other = new FileEvaluatorEntrypoint({ key: 'other', runtime: 'script-package' })
  assert.deepEqual(other.assetEnvironment(), {})
  assert.deepEqual(await other.describeImages({}, 'amd64'), [])
})

test('download failures stop after three attempts and retain an actionable terminal error', async (t) => {
  const f = await fixture(t, { pullFails: true })
  await assert.rejects(f.manager.ensure(), { code: 'EVALUATOR_ASSETS_DOWNLOAD_FAILED', status: 422, retryable: false })
  assert.equal(f.calls.filter(args => args[1] === 'pull').length, 3)
  assert.throws(() => f.manager.assertReady(), /registry unavailable/)
  assert.equal(f.manager.stage, 'failed')
})

test('failed validation leaves no installed version or temporary files and removes the installer', async (t) => {
  const f = await fixture(t, { corrupt: true })
  await assert.rejects(f.manager.ensure(), { code: 'EVALUATOR_ASSETS_INVALID' })
  await assert.rejects(fs.access(f.root), { code: 'ENOENT' })
  assert.deepEqual(await fs.readdir(f.base), [])
  assert.equal(f.calls.filter(args => args[1] === 'rm').length, 1)
})

test('asset directory outside shared mounts fails before pulling images', async (t) => {
  const f = await fixture(t, { shared: false })
  await assert.rejects(f.manager.ensure(), { code: 'EVALUATOR_ASSETS_DIRECTORY_NOT_SHARED' })
  assert.ok(f.calls.every(args => args[1] !== 'pull'))
})

test('corrupt installed version fails validation without replacing it', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(f.root, { recursive: true })
  await fs.writeFile(path.join(f.root, 'asset'), 'damaged')
  await assert.rejects(f.manager.ensure(), { code: 'EVALUATOR_ASSETS_INVALID' })
  assert.equal(await fs.readFile(path.join(f.root, 'asset'), 'utf8'), 'damaged')
  assert.ok(f.calls.every(args => args[1] !== 'pull'))
})

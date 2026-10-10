import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const { ImageSizeEstimator, manifestBytes, FALLBACK_BYTES, ESTIMATE_TIMEOUT_MS } = require('../services/evaluator/src/image-size-estimator.cjs')
const { pullError } = require('../services/evaluator/src/image-pool-docker.cjs')
const GiB = 1024 ** 3
const manifest = (arch = 'amd64', size = GiB, oci = false) => ({
  Descriptor: { platform: { architecture: arch, os: 'linux' } },
  [oci ? 'OCIManifest' : 'SchemaV2Manifest']: { layers: [{ digest: 'sha256:layer', size }] },
})
const spec = { arch: 'x86_64', references: ['registry.example/case:v1', 'mirror.example/case:v1'] }

test('manifest estimate selects Linux architecture, supports OCI/legacy output and excludes manifest descriptor size', () => {
  assert.equal(manifestBytes([manifest('arm64', 2 * GiB, true), manifest()], 'aarch64'), 8 * GiB)
  assert.equal(manifestBytes([manifest('arm64', 2 * GiB), manifest()], 'amd64'), 4 * GiB)
  assert.equal(manifestBytes({ Platform: { os: 'linux', architecture: 'amd64' }, SchemaV2Manifest: manifest().SchemaV2Manifest }, 'amd64'), 4 * GiB)
  assert.equal(manifestBytes({ Descriptor: { platform: { os: 'linux', architecture: 'amd64' }, size: GiB } }, 'amd64'), null)
  assert.equal(manifestBytes(manifest('arm64'), 'amd64'), null)
  assert.equal(manifestBytes(manifest('amd64', -1), 'amd64'), null)
  assert.equal(manifestBytes(manifest('amd64', Number.MAX_SAFE_INTEGER), 'amd64'), null)
})

test('all fallback sources share a single two-second deadline, cache failures, and use bounded CLI execution', async () => {
  let now = 0
  const timeouts: number[] = []
  const estimator = new ImageSizeEstimator({ now: () => now, execute: async (command: string, args: string[], options: any) => {
    assert.equal(command, 'docker')
    assert.deepEqual(args.slice(0, 3), ['manifest', 'inspect', '--verbose'])
    assert.equal(options.killSignal, 'SIGKILL')
    assert.ok(options.maxBuffer <= 4 * 1024 ** 2)
    timeouts.push(options.timeout)
    now += timeouts.length === 1 ? 1500 : 500
    throw new Error('timeout')
  } })
  const input = { ...spec, references: [...spec.references, 'third.example/case:v1'] }
  assert.deepEqual(await estimator.estimate(input), { bytes: FALLBACK_BYTES, source: 'fallback' })
  assert.deepEqual(timeouts, [2000, 500])
  assert.equal((await estimator.estimate(input)).cached, true)
  assert.equal(timeouts.length, 2)
  now += 60_001
  await estimator.estimate(input)
  assert.ok(timeouts.length > 2)
})

test('successful estimates are cached/deduplicated, expire, and provider estimates avoid network', async () => {
  let now = 0
  let calls = 0
  const estimator = new ImageSizeEstimator({ now: () => now, execute: async () => { calls++; return { stdout: JSON.stringify(manifest()) } } })
  const results = await Promise.all([estimator.estimate(spec), estimator.estimate(spec)])
  assert.equal(calls, 1)
  assert.equal(results[0].bytes, 4 * GiB)
  assert.equal((await estimator.estimate(spec)).cached, true)
  now += 15 * 60_000 + 1
  await estimator.estimate(spec)
  assert.equal(calls, 2)
  assert.deepEqual(await estimator.estimate({ ...spec, estimatedBytes: 42 }), { bytes: 42, source: 'provider' })
  assert.equal(calls, 2)
})

test('invalid manifest and missing CLI degrade to an internal estimate without blocking evaluation', async () => {
  for (const execute of [async () => ({ stdout: 'invalid JSON' }), async () => ({ stdout: JSON.stringify(manifest('arm64')) }),
    async () => { throw new Error('ENOENT') }]) {
    assert.deepEqual(await new ImageSizeEstimator({ execute }).estimate(spec), { bytes: FALLBACK_BYTES, source: 'fallback' })
  }
})

test('a stalled metadata subprocess is killed at the overall budget, not left running', async () => {
  const execute = promisify(execFile)
  let calls = 0
  const estimator = new ImageSizeEstimator({ execute: async (_command: string, _args: string[], options: any) => {
    calls++
    return execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options)
  } })
  const started = Date.now()
  assert.equal((await estimator.estimate(spec)).source, 'fallback')
  assert.ok(Date.now() - started < ESTIMATE_TIMEOUT_MS + 1500)
  assert.equal(calls, 1)
})

test('confirmed disk-full errors are non-retryable capacity failures, not registry fallback errors', () => {
  for (const message of ['no space left on device', 'write failed: ENOSPC', 'disk quota exceeded']) {
    const error = pullError(message)
    assert.equal(error.code, 'IMAGE_POOL_SPACE_LOW')
    assert.equal(error.retryable, false)
  }
  assert.equal(pullError('manifest unknown').code, 'IMAGE_POOL_PULL_FAILED')
})

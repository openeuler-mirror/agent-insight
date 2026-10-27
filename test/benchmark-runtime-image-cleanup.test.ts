import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { createHash } from 'node:crypto'

const { cleanupRuntimeImages } = require('../services/evaluator/src/runtime-image-cleanup.cjs')
const { recordManagedImage, ownershipFile, ServiceControl } = require('../services/evaluator/src/service-control.cjs')
const { EvaluationJobJournal } = require('../services/evaluator/src/job-journal.cjs')
const { manage } = require('../services/evaluator/src/manage.cjs')

const id = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const descriptor = (key: string) => ({ runtime: 'oci-container', key, image: `runtime-${key}:current`, artifactDigest: id(key) })
type Image = { id: string; references: string[]; digests: string[] }

async function fixture(t: TestContext) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-image-cleanup-'))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const images = new Map<string, Image>()
  const references = new Set<string>()
  const calls: string[] = []
  const docker = {
    async request(method: string, endpoint: string) {
      calls.push(`${method} ${endpoint}`)
      assert.equal(method, 'GET')
      assert.equal(endpoint, '/info')
      return { ID: 'daemon' }
    },
    async inspect(ref: string) { return images.get(ref) || null },
    async referenced(imageId: string) { return references.has(imageId) },
    async remove(imageId: string) {
      calls.push(`remove ${imageId}`)
      assert.equal(references.has(imageId), false)
      for (const [reference, image] of images) if (image.id === imageId) images.delete(reference)
    },
  }
  async function add(reference: string, extra: Record<string, unknown> = {}) {
    const image: Image = { id: id(reference), references: [reference], digests: [] }
    images.set(reference, image)
    await recordManagedImage(dataDir, { reference, id: image.id, daemonId: 'daemon', role: 'runtime', uncertain: false, ...extra })
    return image
  }
  return { dataDir, images, references, calls, docker, add, descriptors: [descriptor('a'), descriptor('b')] }
}

test('shared cleanup removes only confirmed old Runtimes and preserves current Catalog versions across benchmarks', async (t) => {
  const f = await fixture(t)
  const current = await f.add('runtime-a:current')
  await f.add('runtime-b:current')
  const alias = await f.add('runtime-a:old-alias')
  alias.id = current.id
  await recordManagedImage(f.dataDir, { reference: 'runtime-a:old-alias', id: current.id, daemonId: 'daemon', role: 'runtime' })
  const old = await f.add('runtime-a:old')
  const unowned = { id: id('external'), references: ['unowned:old'], digests: [] }
  f.images.set('unowned:old', unowned)
  await f.add('controller:old', { role: 'controller' })
  const result = await cleanupRuntimeImages(f)
  assert.deepEqual(result.removed.map((image: Image) => image.id), [old.id])
  assert.equal(result.retained.length, 3)
  assert.ok(f.images.has('runtime-a:current'))
  assert.ok(f.images.has('runtime-b:current'))
  assert.ok(f.images.has('runtime-a:old-alias'))
  assert.ok(f.images.has('unowned:old'))
  assert.ok(f.images.has('controller:old'))
  await assert.rejects(fs.access(ownershipFile(f.dataDir, 'runtime-a:old')))
  assert.equal((await cleanupRuntimeImages(f)).removed.length, 0)
})

test('cleanup skips container references, preparation uncertainty, wrong daemon, retargeted tags and extra aliases', async (t) => {
  const f = await fixture(t)
  const used = await f.add('runtime:used')
  f.references.add(used.id)
  await f.add('runtime:preparing', { uncertain: true })
  await f.add('runtime:other-daemon', { daemonId: 'other' })
  await f.add('runtime:retargeted', { id: id('previous') })
  const aliased = await f.add('runtime:aliased')
  aliased.references.push('external:keep')
  const externalDigest = await f.add('runtime:other-repo')
  externalDigest.digests.push(`external/repo@${id('manifest')}`)
  const result = await cleanupRuntimeImages(f)
  assert.equal(result.retained.length, 6)
  assert.equal(result.removed.length, 0)
  assert.equal(result.skipped.length, 0)
  assert.ok(f.calls.every((call) => call.startsWith('GET ')))
})

test('dry-run and list keep images, records and jobs unchanged; list includes runtime candidates', async (t) => {
  const f = await fixture(t)
  await f.add('runtime:old')
  const journal = new EvaluationJobJournal(f.dataDir)
  await journal.accept({ runId: 'running-job', requestDigest: 'digest' })
  await journal.writeState('running-job', { stage: 'running_harness' })
  const before = await fs.readFile(ownershipFile(f.dataDir, 'runtime:old'), 'utf8')
  const dry = await cleanupRuntimeImages({ ...f, dryRun: true })
  assert.equal(dry.candidates.length, 1)
  assert.equal(dry.removed.length, 0)
  const listed = await manage({ ...f, instance: 'evaluator', mode: 'images-list', imagePoolEnabled: false })
  assert.equal(listed.runtimes.candidates.length, 1)
  assert.equal(listed.runtimes.dryRun, true)
  assert.equal(await fs.readFile(ownershipFile(f.dataDir, 'runtime:old'), 'utf8'), before)
  assert.equal((await journal.state('running-job')).stage, 'running_harness')
  assert.equal(await new ServiceControl(f.dataDir).stopped(), null)
  assert.ok(f.calls.every((call) => call.startsWith('GET ')))
})

test('online purge combines pool eviction with Runtime cleanup without stopping tasks', async (t) => {
  const f = await fixture(t)
  await f.add('runtime:old')
  const journal = new EvaluationJobJournal(f.dataDir)
  await journal.accept({ runId: 'running-job', requestDigest: 'digest' })
  const poolCalls: unknown[][] = []
  const result = await manage({ ...f, instance: 'evaluator', mode: 'images-purge', imagePoolEnabled: true,
    poolCommand: async (...args: unknown[]) => { poolCalls.push(args); return { images: [], removed: ['idle-case'] } } })
  assert.equal(result.runtimes.removed.length, 1)
  assert.deepEqual(result.removed, ['idle-case'])
  assert.deepEqual(poolCalls, [[f.dataDir, 'purge', { dryRun: false }]])
  assert.equal((await journal.state('running-job')).stage, 'accepted')
  assert.equal(await new ServiceControl(f.dataDir).stopped(), null)
})

test('online dry-run previews both pools without deleting ownership or stopping the service', async (t) => {
  const f = await fixture(t)
  await f.add('runtime:old')
  const result = await manage({ ...f, instance: 'evaluator', mode: 'images-purge', imagePoolEnabled: true, dryRun: true,
    poolCommand: async (_dataDir: string, command: string, options: { dryRun: boolean }) => {
      assert.equal(command, 'purge')
      assert.equal(options.dryRun, true)
      return { candidates: ['idle-case'], removed: [] }
    } })
  assert.equal(result.dryRun, true)
  assert.equal(result.runtimes.candidates.length, 1)
  assert.equal(result.runtimes.removed.length, 0)
  await fs.access(ownershipFile(f.dataDir, 'runtime:old'))
  assert.ok(f.calls.every((call) => call.startsWith('GET ')))
})

test('startup Runtime-only cleanup does not evict Case images or require the image pool', async (t) => {
  const f = await fixture(t)
  await f.add('runtime:old')
  const result = await manage({ ...f, instance: 'evaluator', mode: 'runtimes-purge',
    poolCommand: async () => assert.fail('Case pool must not be called') })
  assert.equal(result.runtimes.removed.length, 1)
  assert.equal(await new ServiceControl(f.dataDir).stopped(), null)
})

test('online purge still removes old Runtime images when the Case pool is disabled', async (t) => {
  const f = await fixture(t)
  await f.add('runtime:old')
  const result = await manage({ ...f, instance: 'evaluator', mode: 'images-purge', imagePoolEnabled: false,
    poolCommand: async () => assert.fail('Disabled pool must not be contacted') })
  assert.equal(result.enabled, false)
  assert.equal(result.runtimes.removed.length, 1)
})

test('registry-prefixed current versions are protected and old pulled versions can be removed', async (t) => {
  const f = await fixture(t)
  const original = process.env.EVALUATOR_RUNTIME_IMAGE_PREFIX
  process.env.EVALUATOR_RUNTIME_IMAGE_PREFIX = 'registry.example.test/evaluators'
  t.after(() => {
    if (original === undefined) delete process.env.EVALUATOR_RUNTIME_IMAGE_PREFIX
    else process.env.EVALUATOR_RUNTIME_IMAGE_PREFIX = original
  })
  await f.add('registry.example.test/evaluators/runtime-a:current')
  const old = await f.add('registry.example.test/evaluators/runtime-a:old')
  old.digests.push(`registry.example.test/evaluators/runtime-a@${id('manifest')}`)
  const result = await cleanupRuntimeImages(f)
  assert.deepEqual(result.removed.map((image: Image) => image.id), [old.id])
  assert.equal(result.retained.length, 1)
})

test('invalid Catalog or unavailable current image identity prevents any deletion', async (t) => {
  const f = await fixture(t)
  await f.add('runtime:old')
  await assert.rejects(cleanupRuntimeImages({ ...f, descriptors: [{ runtime: 'oci-container', image: 'broken' }] }), /Catalog is invalid/)
  await assert.rejects(cleanupRuntimeImages({ ...f, docker: { ...f.docker, inspect: async () => { throw new Error('Docker unavailable') } } }), /Docker unavailable/)
  assert.ok(f.calls.every((call) => call.startsWith('GET ')))
})

test('deletion conflicts retain ownership for retry; missing images only remove their confirmed stale record', async (t) => {
  const f = await fixture(t)
  const old = await f.add('runtime:old')
  const result = await cleanupRuntimeImages({ ...f, docker: { ...f.docker, remove: async (imageId: string) => {
    assert.equal(imageId, old.id)
    throw new Error('image referenced by a new container')
  } } })
  assert.equal(result.skipped.length, 1)
  assert.equal(result.removed.length, 0)
  await fs.access(ownershipFile(f.dataDir, 'runtime:old'))
  f.images.delete('runtime:old')
  const stale = await cleanupRuntimeImages(f)
  assert.equal(stale.removed[0].existed, false)
  assert.ok(f.calls.every((call) => call.startsWith('GET ')))
})

test('tag retargeting during removal cannot delete the replacement image', async (t) => {
  const f = await fixture(t)
  const old = await f.add('runtime:old')
  const replacement = { id: id('replacement'), references: ['runtime:old'], digests: [] }
  const result = await cleanupRuntimeImages({ ...f, docker: { ...f.docker, remove: async (imageId: string) => {
    f.images.set('runtime:old', replacement)
    assert.equal(imageId, old.id)
    await f.docker.remove(imageId)
  } } })
  assert.equal(result.removed.length, 1)
  assert.equal(f.images.get('runtime:old'), replacement)
})

test('ownership changing during inspection is retained rather than deleted', async (t) => {
  const f = await fixture(t)
  const old = await f.add('runtime:old')
  const result = await cleanupRuntimeImages({ ...f, docker: { ...f.docker, referenced: async () => {
    await recordManagedImage(f.dataDir, { reference: 'runtime:old', id: old.id, daemonId: 'daemon', role: 'runtime', uncertain: true })
    return false
  } } })
  assert.equal(result.removed.length, 0)
  assert.match(result.retained[0].reason, /changed/)
  assert.ok(f.images.has('runtime:old'))
  assert.equal(JSON.parse(await fs.readFile(ownershipFile(f.dataDir, 'runtime:old'), 'utf8')).uncertain, true)
})

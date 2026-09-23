import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

const { manage } = require('../services/evaluator/src/manage.cjs')
const { ServiceControl, recordManagedImage } = require('../services/evaluator/src/service-control.cjs')
const { EvaluationJobJournal, atomicWriteJson } = require('../services/evaluator/src/job-journal.cjs')

test('management uses bundled code without a host source mount for start, stop and purge', () => {
  for (const args of ['', '--start', '--purge-images', '--purge-images --dry-run']) {
    const result = spawnSync('bash', ['-c', `
set -eu
source "$1"
docker() { printf '%s\\n' "$*" >&2; }
CONTAINER_NAME=test-evaluator
DATA_VOLUME=test-data
DOCKER_SOCKET=/test/docker.sock
MANAGEMENT_READONLY=,readonly
evaluator_management_run sha256:test ${args}
`, 'test', path.resolve(__dirname, '../scripts/evaluator-management.sh')], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const calls = result.stderr.trim().split('\n')
    assert.equal(calls.length, 2)
    assert.match(calls[0], /--read-only/)
    assert.doesNotMatch(calls[0], /--mount/)
    assert.match(calls[1], /sha256:test \/app\/services\/evaluator\/src\/manage\.cjs/)
    assert.match(calls[1], /type=volume,src=test-data,dst=\/data,readonly/)
    assert.match(calls[1], /type=bind,src=\/test\/docker.sock,dst=\/var\/run\/docker.sock/)
    assert.doesNotMatch(result.stderr, /dst=\/management|src=[^,\n]*services\/evaluator\/src,/)
    assert.ok(calls[1].endsWith(`/app/services/evaluator/src/manage.cjs${args ? ` ${args}` : ''}`))
  }
})

test('missing bundled management code fails before mounting Docker or service data', () => {
  const result = spawnSync('bash', ['-c', `
set -eu
source "$1"
docker() { printf '%s\\n' "$*" >&2; return 1; }
evaluator_management_run sha256:legacy --purge-images
`, 'test', path.resolve(__dirname, '../scripts/evaluator-management.sh')], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /尚未执行停止或清理/)
  assert.match(result.stderr, /start-evaluator.sh/)
  assert.doesNotMatch(result.stderr, /--mount|--purge-images/)
})

async function fixture(t: any) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evaluator-management-'))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const containers: any[] = [
    { Id: 'controller', Names: ['/evaluator'], State: 'running', Labels: {} },
    { Id: 'runtime', Labels: { 'agent-insight.evaluator-instance': 'evaluator' } },
    { Id: 'other', Labels: { 'agent-insight.evaluator-instance': 'another' } },
  ]
  const calls: string[] = []
  const images = new Map([['runtime:v1', { id: 'runtime-image' }], ['controller:v1', { id: 'controller-image' }]])
  const docker = {
    async request(method: string, endpoint: string, _stream: boolean, payload: any) {
      calls.push(`${method} ${endpoint}`)
      if (endpoint === '/info') return { ID: 'daemon' }
      if (endpoint === '/containers/json?all=1') return [...containers]
      if (endpoint === '/containers/controller/json') return { Mounts: [{ Name: 'data', Destination: '/data' }] }
      if (endpoint.endsWith('/update')) { assert.deepEqual(payload, { RestartPolicy: { Name: 'no' } }); return {} }
      if (endpoint.includes('/stop?')) return null
      if (method === 'DELETE') { const index = containers.findIndex((item) => endpoint.startsWith(`/containers/${item.Id}?`)); if (index >= 0) containers.splice(index, 1); return null }
      throw new Error(endpoint)
    },
    async inspect(ref: string) { return images.get(ref) || null },
    async referenced() { return false },
    async remove(ref: string) { calls.push(`remove ${ref}`); images.delete(ref) },
  }
  const journal = new EvaluationJobJournal(dataDir)
  await journal.accept({ runId: 'run1', requestDigest: 'digest' })
  return { dataDir, docker, journal, containers, calls, images, instance: 'evaluator', volume: 'data' }
}

test('stop cancels persisted jobs and removes only owned containers', async (t) => {
  const f = await fixture(t)
  const result = await manage(f)
  assert.equal(result.stopped, true)
  assert.deepEqual(f.containers.map((item) => item.Id), ['other'])
  assert.equal((await f.journal.state('run1')).stage, 'cancelled')
  const control = new ServiceControl(f.dataDir)
  await assert.rejects(() => control.assertRunning(), /停止/)
  await control.resume()
  await assert.rejects(() => control.assertRunning('run1'), /停止/)
  assert.equal(f.images.size, 2)
  assert.ok(f.calls.indexOf('POST /containers/controller/stop?t=2') < f.calls.indexOf('DELETE /containers/runtime?force=true&v=false'))
})

test('dry-run does not mutate Docker or journal', async (t) => {
  const f = await fixture(t)
  await manage({ ...f, dryRun: true, purge: true })
  assert.ok(f.calls.every((call) => call.startsWith('GET ')))
  assert.equal(await new ServiceControl(f.dataDir).stopped(), null)
  assert.equal((await f.journal.state('run1')).stage, 'accepted')
})

test('offline purge deletes owned runtime refs, defers controller, and can repeat', async (t) => {
  const f = await fixture(t)
  await recordManagedImage(f.dataDir, { reference: 'runtime:v1', id: 'runtime-image', daemonId: 'daemon', role: 'runtime' })
  await recordManagedImage(f.dataDir, { reference: 'controller:v1', id: 'controller-image', daemonId: 'daemon', role: 'controller' })
  const result = await manage({ ...f, purge: true })
  assert.deepEqual(result.controllerImages, [{ reference: 'controller:v1', id: 'controller-image' }])
  assert.equal(f.images.has('runtime:v1'), false)
  assert.equal(f.images.has('controller:v1'), true)
  assert.equal((await manage({ ...f, purge: true })).stopped, true)
})

test('purge preserves pool with unconfirmed pulls and retargeted runtime refs', async (t) => {
  const f = await fixture(t)
  await atomicWriteJson(path.join(f.dataDir, 'image-pool/state.json'), {
    version: 1, daemonId: 'daemon', images: {}, operations: { pull: { uncertain: true } },
  })
  await recordManagedImage(f.dataDir, { reference: 'runtime:v1', id: 'old-image', daemonId: 'daemon', role: 'runtime' })
  const result = await manage({ ...f, purge: true })
  assert.equal(result.skipped.length, 2)
  assert.equal(f.images.has('runtime:v1'), true)
})

test('wrong controller volume rejects before any writes', async (t) => {
  const f = await fixture(t)
  await assert.rejects(() => manage({ ...f, volume: 'wrong' }), /volume does not match/)
  assert.ok(f.calls.every((call) => call.startsWith('GET ')))
})

test('evaluation cancellation waits for active execution and never releases protection before cleanup', async (t) => {
  const f = await fixture(t)
  const { BenchmarkEvaluatorService } = require('../services/evaluator/src/service.cjs')
  let cleaned = false
  let releases = 0
  const service = new BenchmarkEvaluatorService({ dataDir: f.dataDir, journal: f.journal,
    cleanupContainers: async () => ({ status: cleaned ? 'succeeded' : 'failed' }),
    imagePool: { config: {}, release: async () => { releases++ } } })
  const controller = new AbortController()
  service.controllers.set('run1', controller)
  service.active.set('run1', new Promise(() => {}))
  assert.equal((await service.cancel('run1')).status, 'cancelling')
  assert.equal(controller.signal.aborted, true)
  assert.equal(releases, 0)
  service.active.delete('run1')
  assert.equal((await service.cancel('run1')).status, 'cancelling')
  assert.equal(releases, 0)
  cleaned = true
  service.imageOwner = () => ({ runId: 'run1' })
  assert.equal((await service.cancel('run1')).status, 'cancelled')
  assert.equal(releases, 1)
  await assert.rejects(() => service.start('run1'), /停止/)
  assert.equal((await service.cancel('not-yet-accepted')).status, 'cancelled')
  await assert.rejects(() => service.control.assertRunning('not-yet-accepted'), /停止/)
})

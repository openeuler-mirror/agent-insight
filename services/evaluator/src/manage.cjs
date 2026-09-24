'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { DockerImageStore } = require('./image-pool-docker.cjs')
const { EvaluationJobJournal, atomicWriteJson } = require('./job-journal.cjs')
const { ServiceControl, readJson, recordManagedImage } = require('./service-control.cjs')

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function manage(options) {
  const { dataDir, instance, dryRun = false, purge = false, mode = 'stop' } = options
  if (!/^[A-Za-z0-9_.-]+$/.test(instance || '')) throw new Error('Invalid evaluator instance')
  const docker = options.docker || new DockerImageStore()
  const control = new ServiceControl(dataDir)
  const journal = new EvaluationJobJournal(dataDir)
  const info = await docker.request('GET', '/info')
  const containers = await docker.request('GET', '/containers/json?all=1')
  const controller = containers.find((item) => item.Names?.includes(`/${instance}`))
  if (controller) {
    const inspected = await docker.request('GET', `/containers/${controller.Id}/json`)
    if (!inspected.Mounts?.some((mount) => mount.Name === options.volume && mount.Destination === '/data')) {
      throw new Error('Controller data volume does not match; refusing to stop')
    }
  }
  if (mode === 'start') {
    if (controller?.State === 'running') throw new Error('Stop the existing evaluator before starting a replacement')
    const image = await docker.inspect(options.imageReference)
    if (!image) throw new Error('Controller image not found')
    await recordManagedImage(dataDir, { reference: options.imageReference, id: image.id, daemonId: info.ID, role: 'controller', uncertain: false })
    await control.resume()
    return { initialized: true }
  }
  const runIds = new Set(await journal.listRunIds())
  const owned = (item) => item.Id === controller?.Id
    || (item.Labels?.['agent-insight.evaluator-instance']
      ? item.Labels['agent-insight.evaluator-instance'] === instance
      : runIds.has(item.Labels?.['agent-insight.evaluation-id']))
  const targets = containers.filter(owned)
  const result = { dryRun, stopped: false, containers: targets.map((item) => item.Id), removed: [], skipped: [], controllerImages: [] }
  result.availableBytesBefore = await fs.statfs(dataDir).then((value) => value.bavail * value.bsize).catch(() => null)
  if (!dryRun) {
    await control.stop()
    for (const runId of runIds) {
      const state = await journal.state(runId)
      if (!TERMINAL.has(state?.stage)) {
        await control.cancel(runId, 'SERVICE_STOPPED')
        await journal.writeState(runId, { stage: 'cancelling', cancellationReason: 'SERVICE_STOPPED', cancellationCallbackPending: true })
      }
    }
    if (controller) {
      // Stop the producer before removing sibling containers created through its Docker socket.
      await docker.request('POST', `/containers/${controller.Id}/update`, false, { RestartPolicy: { Name: 'no' } })
      if (controller.State === 'running') await docker.request('POST', `/containers/${controller.Id}/stop?t=2`)
    }
    for (const runId of await journal.listRunIds()) {
      runIds.add(runId)
      const state = await journal.state(runId)
      if (!TERMINAL.has(state?.stage)) {
        await control.cancel(runId, 'SERVICE_STOPPED')
        await journal.writeState(runId, { stage: 'cancelling', cancellationReason: 'SERVICE_STOPPED', cancellationCallbackPending: true })
      }
    }
    const latest = await docker.request('GET', '/containers/json?all=1')
    for (const item of latest.filter(owned)) {
      try { await docker.request('DELETE', `/containers/${item.Id}?force=true&v=false`) }
      catch (error) { if (error.dockerStatus !== 404) result.skipped.push({ target: item.Id, reason: error.message }) }
    }
    const remaining = (await docker.request('GET', '/containers/json?all=1')).filter(owned)
    result.stopped = remaining.length === 0
    if (!result.stopped) return result
    for (const runId of runIds) {
      if (await control.cancelled(runId)) await journal.writeState(runId, { stage: 'cancelled', cancellationCallbackPending: true })
    }
  }
  if (!purge) return result
  const poolFile = path.join(dataDir, 'image-pool', 'state.json')
  const pool = await readJson(poolFile)
  if (pool && (pool.version !== 1 || pool.daemonId !== info.ID)) throw new Error('Image pool daemon or version mismatch')
  const records = []
  if (pool) {
    if (Object.values(pool.operations || {}).some((item) => !item.completed)) {
      result.skipped.push({ target: 'image-pool', reason: 'Docker operations remain unconfirmed; pool images retained' })
    } else {
      for (const entry of Object.values(pool.images)) {
        if (entry.uncertain || entry.deleting) {
          result.skipped.push({ target: entry.id, reason: 'Image operation remains unconfirmed' })
          continue
        }
        const users = Object.values(entry.users || {})
        if ((await Promise.all(users.map(async (owner) => runIds.has(owner.runId) && Boolean(await control.cancelled(owner.runId))))).some((known) => !known)) {
          result.skipped.push({ target: entry.id, reason: 'Image has an unconfirmed owner' })
          continue
        }
        for (const reference of [...entry.ownedReferences, ...entry.ownedDigests]) {
          records.push({ reference, id: entry.id, role: 'case', entry })
        }
      }
    }
  }
  const directory = path.join(dataDir, 'managed-images')
  const files = await fs.readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error })
  for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    const record = await readJson(path.join(directory, file))
    if (record.daemonId !== info.ID || record.uncertain || !record.id) {
      result.skipped.push({ target: record.reference, reason: 'Ownership or operation unconfirmed' })
    } else records.push({ ...record, file: path.join(directory, file) })
  }
  for (const record of records) {
    const actual = await docker.inspect(record.reference)
    if (actual && actual.id !== record.id) {
      result.skipped.push({ target: record.reference, reason: 'Reference points to a different image' })
      continue
    }
    if (record.role === 'controller' && actual) {
      result.controllerImages.push({ reference: record.reference, id: record.id })
      continue
    }
    if (actual && await docker.referenced(actual.id)) {
      result.skipped.push({ target: record.reference, reason: 'Image referenced by a container' })
      continue
    }
    try {
      if (actual && !dryRun) await docker.remove(record.reference)
      result.removed.push({ reference: record.reference, existed: Boolean(actual), dryRun })
      if (!dryRun) {
        if (record.file) await fs.unlink(record.file)
        if (record.entry) {
          record.entry.ownedReferences = record.entry.ownedReferences.filter((ref) => ref !== record.reference)
          record.entry.ownedDigests = record.entry.ownedDigests.filter((ref) => ref !== record.reference)
          if (!record.entry.ownedReferences.length && !record.entry.ownedDigests.length) delete pool.images[record.id]
          await atomicWriteJson(poolFile, pool)
        }
      }
    } catch (error) { result.skipped.push({ target: record.reference, reason: error.message }) }
  }
  result.availableBytesAfter = await fs.statfs(dataDir).then((value) => value.bavail * value.bsize).catch(() => null)
  result.spaceMeasurement = 'data-volume-filesystem; controller image cleanup happens after helper exit'
  return result
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2))
  manage({ dataDir: '/data', instance: process.env.EVALUATOR_INSTANCE_ID,
    volume: process.env.EVALUATOR_VOLUME, imageReference: process.env.EVALUATOR_IMAGE_REFERENCE,
    mode: args.has('--start') ? 'start' : 'stop', dryRun: args.has('--dry-run'), purge: args.has('--purge-images') })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
      for (const record of result.controllerImages || []) console.log(`CONTROLLER_IMAGE\t${record.id}\t${record.reference}`)
      if (!result.dryRun && (result.skipped?.length || result.stopped === false)) process.exitCode = 2
    }).catch((error) => { console.error(error.message); process.exitCode = 1 })
}

module.exports = { manage }

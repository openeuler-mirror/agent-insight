'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { atomicWriteJson } = require('./job-journal.cjs')

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

class ServiceControl {
  constructor(dataDir) { this.directory = path.join(dataDir, 'control') }
  stopped() { return readJson(path.join(this.directory, 'stopped.json')) }
  stop(reason = 'SERVICE_STOPPED') {
    return atomicWriteJson(path.join(this.directory, 'stopped.json'), { reason, at: new Date().toISOString() })
  }
  async resume() {
    await fs.unlink(path.join(this.directory, 'stopped.json')).catch((error) => { if (error.code !== 'ENOENT') throw error })
  }
  cancellationFile(runId) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(String(runId || ''))) throw new Error('Invalid evaluation runId')
    return path.join(this.directory, 'cancelled', `${runId}.json`)
  }
  cancelled(runId) { return readJson(this.cancellationFile(runId)) }
  cancel(runId, reason = 'EVALUATION_CANCELLED') {
    return atomicWriteJson(this.cancellationFile(runId), { reason, at: new Date().toISOString() })
  }
  async assertRunning(runId) {
    const stop = await this.stopped() || (runId && await this.cancelled(runId))
    if (stop) throw Object.assign(new Error('评测服务或任务已主动停止'), { code: stop.reason, status: 409, retryable: false })
  }
}

function ownershipFile(dataDir, reference) {
  return path.join(dataDir, 'managed-images', `${createHash('sha256').update(reference).digest('hex')}.json`)
}

async function recordManagedImage(dataDir, record) {
  if (!record.reference || !record.daemonId) throw new Error('Image ownership requires reference and daemon ID')
  await atomicWriteJson(ownershipFile(dataDir, record.reference), { ...record, updatedAt: new Date().toISOString() })
}

module.exports = { ServiceControl, readJson, recordManagedImage, ownershipFile }

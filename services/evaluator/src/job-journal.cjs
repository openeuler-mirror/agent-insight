'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  const handle = await fs.open(temporary, 'r')
  await handle.sync()
  await handle.close()
  await fs.rename(temporary, filePath)
}

class EvaluationJobJournal {
  constructor(dataDir) {
    this.jobsDir = path.join(dataDir, 'jobs')
  }

  jobDir(runId) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(String(runId || ''))) {
      throw Object.assign(new Error('evaluation runId 不合法'), { code: 'RUN_ID_INVALID', status: 400 })
    }
    return path.join(this.jobsDir, runId)
  }

  async readJson(filePath) {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  request(runId) {
    return this.readJson(path.join(this.jobDir(runId), 'request.json'))
  }

  state(runId) {
    return this.readJson(path.join(this.jobDir(runId), 'state.json'))
  }

  result(runId) {
    return this.readJson(path.join(this.jobDir(runId), 'result.json'))
  }

  async writeState(runId, patch) {
    const current = await this.state(runId)
    await atomicWriteJson(path.join(this.jobDir(runId), 'state.json'), {
      ...(current || {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    })
  }

  async writeResult(runId, result) {
    await atomicWriteJson(path.join(this.jobDir(runId), 'result.json'), result)
  }

  async accept(request) {
    const runDir = this.jobDir(request.runId)
    const existing = await this.request(request.runId)
    if (existing) {
      if (existing.requestDigest !== request.requestDigest) {
        throw Object.assign(new Error('同一 runId 的任务摘要不同'), {
          code: 'RUN_ID_CONFLICT',
          status: 409,
        })
      }
      return { created: false, state: await this.state(request.runId) }
    }
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 })
    await atomicWriteJson(path.join(runDir, 'request.json'), request)
    await this.writeState(request.runId, { stage: 'accepted' })
    return { created: true, state: await this.state(request.runId) }
  }

  artifactPath(runId, name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw Object.assign(new Error('Artifact 名称不合法'), { code: 'ARTIFACT_NAME_INVALID', status: 422 })
    }
    return path.join(this.jobDir(runId), 'input-artifacts', name)
  }

  async writeArtifact(runId, name, bytes) {
    const target = this.artifactPath(runId, name)
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    const temporary = `${target}.${process.pid}.tmp`
    await fs.writeFile(temporary, bytes, { mode: 0o600 })
    await fs.rename(temporary, target)
    return target
  }

  async listRunIds() {
    try {
      const entries = await fs.readdir(this.jobsDir, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }
}

module.exports = { EvaluationJobJournal, atomicWriteJson }

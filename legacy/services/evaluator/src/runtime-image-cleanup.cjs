/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { DockerImageStore } = require('./image-pool-docker.cjs')
const { readJson, ownershipFile } = require('./service-control.cjs')
const { runtimeDescriptor } = require('./runtime-image.cjs')

async function cleanupRuntimeImages(options = {}) {
  const dataDir = options.dataDir || process.env.EVALUATOR_DATA_DIR || '/data'
  const docker = options.docker || new DockerImageStore()
  const descriptors = options.descriptors || require('../../../generated/benchmark-catalog/evaluators.cjs').generatedEvaluatorDescriptors
  const dryRun = options.dryRun === true
  const result = { dryRun, candidates: [], removed: [], retained: [], skipped: [] }
  const currentReferences = new Set()
  for (const descriptor of descriptors.filter((item) => item.runtime === 'oci-container')) {
    if (!descriptor.image || !/^sha256:[a-f0-9]{64}$/.test(descriptor.artifactDigest || '')) {
      throw new Error('Runtime Catalog is invalid; refusing image cleanup')
    }
    currentReferences.add(descriptor.image)
    currentReferences.add(runtimeDescriptor(descriptor).image)
  }
  const currentIds = new Set()
  for (const reference of currentReferences) {
    const image = await docker.inspect(reference)
    if (image) currentIds.add(image.id)
  }
  const { ID: daemonId } = await docker.request('GET', '/info')
  if (!daemonId) throw new Error('Docker daemon identity is unavailable; refusing image cleanup')
  const directory = path.join(dataDir, 'managed-images')
  const files = await fs.readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error })
  for (const name of files.filter((item) => /^[a-f0-9]{64}\.json$/.test(item))) {
    const file = path.join(directory, name)
    let record
    try {
      record = await readJson(file)
      if (record?.role !== 'runtime') continue
      const retain = (reason) => result.retained.push({ reference: record.reference, id: record.id, reason })
      if (typeof record.reference !== 'string' || ownershipFile(dataDir, record.reference) !== file
        || record.daemonId !== daemonId || record.uncertain || !/^sha256:[a-f0-9]{64}$/.test(record.id || '')) {
        retain('Ownership or operation unconfirmed')
        continue
      }
      if (currentReferences.has(record.reference) || currentIds.has(record.id)) {
        retain('Required by current Controller Catalog')
        continue
      }
      const actual = await docker.inspect(record.reference)
      if (actual && actual.id !== record.id) {
        retain('Reference points to a different image')
        continue
      }
      if (actual && await docker.referenced(actual.id)) {
        retain('Image referenced by a container')
        continue
      }
      const repository = record.reference.split('@')[0].replace(/:[^/:]+$/, '')
      if (actual && (actual.references.some((ref) => ref !== '<none>:<none>' && ref !== record.reference)
        || actual.digests.some((ref) => ref !== record.reference && !ref.startsWith(`${repository}@sha256:`)))) {
        retain('Image has additional references; retained conservatively')
        continue
      }
      const candidate = { reference: record.reference, id: record.id, existed: Boolean(actual) }
      result.candidates.push(candidate)
      if (dryRun) continue
      const latest = await readJson(file)
      if (JSON.stringify(latest) !== JSON.stringify(record)) {
        retain('Ownership record changed during cleanup')
        continue
      }
      // Deleting by ID cannot remove a new image if a tag was retargeted after inspection.
      if (actual) await docker.remove(record.id)
      if (JSON.stringify(await readJson(file)) === JSON.stringify(record)) await fs.unlink(file)
      result.removed.push(candidate)
    } catch (error) {
      result.skipped.push({ reference: record?.reference || name, reason: error.message })
    }
  }
  return result
}

module.exports = { cleanupRuntimeImages }

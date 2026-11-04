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

/** @param {unknown} value */
function isEvidencePath(value) {
  return typeof value === 'string' && value.length <= 512
    && value.split('/').length <= 16
    && value.split('/').every(segment => segment.length > 0 && segment.length <= 128
      && segment !== '.' && segment !== '..'
      && !/[\x00-\x1f\x7f-\x9f\\:<>"|?*\u202a-\u202e\u2066-\u2069]/u.test(segment)
      && !/[\ud800-\udfff]/u.test(segment)
      && !/[. ]$/.test(segment))
}

function evidenceContentDisposition(name) {
  const basename = name.split('/').pop()
  const fallback = basename.replace(/[^A-Za-z0-9._-]/g, '_') || 'artifact'
  const encoded = encodeURIComponent(basename).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function evidenceSource(runtimeFactsJson, artifactId) {
  try {
    const facts = typeof runtimeFactsJson === 'string' ? JSON.parse(runtimeFactsJson) : runtimeFactsJson
    const source = facts?.evidenceCollection?.files?.find(item => item.artifactId === artifactId)?.source
    return ['official-file', 'official-return', 'runtime-output', 'platform'].includes(source) ? source : undefined
  } catch { return undefined }
}

function matchesEvidenceCollection(collection, artifacts, status) {
  if (collection?.schemaVersion !== 'evidence-collection/v1'
    || !['official-directory', 'output-directory', 'declared'].includes(collection.scope)
    || typeof collection.complete !== 'boolean' || !Array.isArray(collection.issues)
    || collection.issues.some(issue => typeof issue?.path !== 'string' || typeof issue?.message !== 'string')
    || !Array.isArray(collection.files)
    || collection.files.length !== artifacts.length
    || new Set(collection.files.map(item => item?.artifactId)).size !== collection.files.length) return false
  if (status === 'completed' && (collection.complete !== true || !Array.isArray(collection.issues) || collection.issues.length)) return false
  return collection.files.every(item => {
    const artifact = artifacts.find(value => value.id === item?.artifactId)
    return artifact && item.name === artifact.name && item.sha256 === artifact.sha256 && item.sizeBytes === artifact.sizeBytes
      && ['official-file', 'official-return', 'runtime-output', 'platform'].includes(item.source)
  })
}

module.exports = { isEvidencePath, evidenceContentDisposition, evidenceSource, matchesEvidenceCollection }

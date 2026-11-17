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

"use strict"

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { isEvidencePath } = require('../../../packages/benchmark-protocol/artifact-path.cjs')
const SOURCES = new Set(['official-file', 'official-return', 'runtime-output', 'platform'])
const MAX_BYTES = 64 * 1024 * 1024

function mediaType(name) {
  if (/\.json$/i.test(name)) return 'application/json'
  if (/\.(log|txt|csv|xml|md|jsonl)$/i.test(name)) return 'text/plain'
  return 'application/octet-stream'
}

async function collectEvidence(outputDir, declarations = [], evidenceRoot) {
  const files = new Map(), names = new Set(), issues = []
  const rootStat = await fs.lstat(outputDir)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('输出目录不得是符号链接')
  const root = await fs.realpath(outputDir)
  let officialRoot
  const issue = (name, message) => issues.push({ path: name, message })
  const inside = value => value.startsWith(`${root}${path.sep}`)
  if (evidenceRoot !== undefined) {
    try {
      if (typeof evidenceRoot !== 'string' || (evidenceRoot !== '.' && !isEvidencePath(evidenceRoot))) throw new Error('产物根目录必须是安全的相对路径')
      officialRoot = await fs.realpath(path.resolve(root, evidenceRoot))
      if ((officialRoot !== root && !inside(officialRoot)) || !(await fs.stat(officialRoot)).isDirectory()) throw new Error('产物根目录越界或不是目录')
    } catch (error) { issue(String(evidenceRoot), error.message) }
  }
  async function add(file, declaration) {
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || !inside(await fs.realpath(file))) throw new Error('证据必须是输出目录中的普通文件，不接受符号链接')
      const inOfficial = officialRoot && file.startsWith(`${officialRoot}${path.sep}`)
      const originalName = path.relative(inOfficial ? officialRoot : root, file).split(path.sep).join('/')
      const name = declaration?.name || originalName
      if (!isEvidencePath(name)) throw new Error('证据原始名称不受支持')
      if (inOfficial && name !== originalName) throw new Error('官方产物不能改名或压平目录')
      if (names.has(name)) throw new Error('证据名称冲突')
      if (stat.size > MAX_BYTES) throw new Error('证据超过 64 MiB，未截断上传')
      if (declaration?.kind !== undefined && !/^[a-z][a-z0-9._-]{0,63}$/.test(declaration.kind)) throw new Error('证据类型不合法')
      if (declaration?.mediaType !== undefined && (typeof declaration.mediaType !== 'string' || !declaration.mediaType.trim() || declaration.mediaType.length > 128)) throw new Error('证据媒体类型不合法')
      const source = declaration?.source || 'runtime-output'
      if (!SOURCES.has(source)) throw new Error('证据来源类型不合法')
      names.add(name)
      files.set(file, { name, path: file, kind: declaration?.kind || 'runtime-output', mediaType: declaration?.mediaType || mediaType(name), source })
    } catch (error) { issue(path.relative(root, file), error.message) }
  }
  if (!Array.isArray(declarations)) issue('evidenceFiles', '证据清单必须是数组')
  else for (const item of declarations) {
    if (!item || typeof item.path !== 'string') { issue('evidenceFiles', '证据缺少文件路径'); continue }
    const file = path.resolve(root, item.path)
    if (!inside(file) || file === path.join(root, 'result.json')) { issue(item.path, '不能把输入或通信文件作为评测证据'); continue }
    if (files.has(file)) { issue(item.path, '同一文件被重复声明'); continue }
    await add(file, item)
  }
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (file === path.join(root, 'result.json')) continue
      if (entry.isSymbolicLink()) { issue(path.relative(root, file), '不收集符号链接'); continue }
      if (entry.isDirectory()) await walk(file)
      else if (!files.has(file)) await add(file)
    }
  }
  await walk(root)
  return { files: [...files.values()], issues, scope: officialRoot ? 'official-directory' : 'output-directory' }
}

async function describeEvidence(files, collection = {}) {
  const entries = []
  for (const file of files) {
    const bytes = await fs.readFile(file.path)
    entries.push({ name: file.name, source: file.source || 'runtime-output', sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, sizeBytes: bytes.length })
  }
  return { schemaVersion: 'evidence-collection/v1', scope: collection.scope || 'declared', complete: !(collection.issues?.length), issues: collection.issues || [], files: entries }
}

function appendPlatformFile(files, file, basename) {
  let prefix = 'controller', i = 1
  while (files.some(item => item.name === `${prefix}/${basename}`)) prefix = `controller-${i++}`
  files.push({ name: `${prefix}/${basename}`, kind: 'controller-diagnostic', mediaType: mediaType(basename), path: file, source: 'platform' })
}

module.exports = { collectEvidence, describeEvidence, appendPlatformFile }

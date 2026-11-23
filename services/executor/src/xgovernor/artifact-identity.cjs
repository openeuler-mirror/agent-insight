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

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const hashes = new Map()
const signature = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(':')

function fileDigest(file, info) {
  const key = signature(info)
  const cached = hashes.get(file)
  if (cached?.key === key) return cached.digest
  const hash = createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  try {
    if (signature(fs.fstatSync(descriptor, { bigint: true })) !== key) throw new Error('制品正在变化')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytes
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes))
    if (signature(fs.fstatSync(descriptor, { bigint: true })) !== key || signature(fs.statSync(file, { bigint: true })) !== key) throw new Error('制品正在变化')
  } finally { fs.closeSync(descriptor) }
  const digest = hash.digest('hex')
  hashes.set(file, { key, digest })
  if (hashes.size > 32768) hashes.delete(hashes.keys().next().value)
  return digest
}

function artifactIdentity(config) {
  const files = []
  const reasons = []
  const budget = { entries: 0, bytes: 0 }
  const visit = (file, name, ancestors = new Set()) => {
    if (++budget.entries > 20000 || ancestors.size > 64) throw new Error('制品文件数量或目录层级超限')
    const resolved = fs.realpathSync(file)
    const info = fs.statSync(resolved, { bigint: true })
    if (info.isDirectory()) {
      if (ancestors.has(resolved)) throw new Error('制品目录存在循环链接')
      const next = new Set([...ancestors, resolved])
      for (const entry of fs.readdirSync(resolved).sort()) if (entry !== '.git') visit(path.join(resolved, entry), `${name}/${entry}`, next)
    } else if (info.isFile()) {
      budget.bytes += Number(info.size)
      if (budget.bytes > 2 * 1024 ** 3) throw new Error('制品内容超过识别上限')
      files.push([name, Number(info.mode & 0o777n), fileDigest(resolved, info)])
    } else throw new Error('制品不是普通文件或目录')
  }
  const inspect = (label, file) => {
    try {
      if (!file) throw new Error('未配置')
      visit(file, label)
    } catch (cause) {
      const reason = cause.code === 'ENOENT' ? '文件不存在' : cause.code === 'EACCES' ? '文件不可读' : cause.code ? '无法读取' : cause.message
      reasons.push(`${label}：${reason}`)
      files.push([label, 'unavailable'])
    }
  }
  inspect('server', config.serverExecutable)
  for (const [platform, runtime] of Object.entries(config.runtimes).sort(([a], [b]) => a.localeCompare(b))) {
    inspect(`${platform}/worker`, runtime.workerExecutable)
    if (runtime.kind === 'pi') {
      inspect(`${platform}/agent`, runtime.executable)
      inspect(`${platform}/extension`, runtime.extensionDirectory)
    }
    if (runtime.traceExporter) inspect(`${platform}/trace-exporter`, runtime.traceExporter)
    if (runtime.credentialExecutable) inspect(`${platform}/credentials`, runtime.credentialExecutable)
  }
  return { digest: `sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`, reasons }
}

module.exports = { artifactIdentity }

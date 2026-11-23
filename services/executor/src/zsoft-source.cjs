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

const fsp = require('node:fs/promises')
const path = require('node:path')
const { isIP } = require('node:net')
const { readBoundedFile } = require('./public-bundle.cjs')

function invalid() {
  throw Object.assign(new Error('ZSoft 源码来源不合法，请检查执行机的 source_id、公开下载地址和固定版本'), { code: 'ZSOFT_SOURCE_INVALID' })
}

async function prepareZsoftSourceHandoff(tasksDir, taskId) {
  try {
    const stat = await fsp.lstat(path.join(tasksDir, taskId, 'public/repo-vul'))
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
    return null
  } catch (error) { if (error.code !== 'ENOENT') throw error }

  try {
    const manifest = JSON.parse(await readBoundedFile(tasksDir, `${taskId}/private/source-manifest.json`, 65536))
    const id = manifest?.source_id
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) invalid()
    const input = JSON.parse(await readBoundedFile(path.dirname(tasksDir), `source-locks/${id}.json`, 65536))
    if (input?.source_id !== id || !['archive', 'git_snapshot'].includes(input.kind)
      || typeof input.url !== 'string' || input.url.length > 4096
      || !/^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9._~/%+-]+$/.test(input.url)) invalid()
    const url = new URL(input.url)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (url.username || url.password || url.search || url.hash || isIP(host) || !host.includes('.')
      || /(?:^|\.)(?:localhost|local|internal)$/.test(host)) invalid()
    const lock = { source_id: id, kind: input.kind, url: input.url }
    if (input.commit !== undefined) {
      if (typeof input.commit !== 'string' || !/^[a-f0-9]{40}$/.test(input.commit)) invalid()
      lock.commit = input.commit
    }
    if (input.sha256 !== undefined) {
      if (typeof input.sha256 !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(input.sha256)) invalid()
      lock.sha256 = input.sha256.replace(/^sha256:/, '')
    }
    if (lock.kind === 'git_snapshot' && !lock.commit) invalid()
    if (lock.kind === 'archive' && !lock.sha256 && !/(?:^|\/)[a-f0-9]{40}(?:[./]|$)/.test(url.pathname)) invalid()
    return lock
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error('ZSoft 缺少 public/repo-vul 或源码锁定文件，请在执行机准备对应官方源码来源'), { code: 'ZSOFT_SOURCE_MISSING' })
    }
    invalid()
  }
}

module.exports = { prepareZsoftSourceHandoff }

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
const { readBoundedFile, validatePublicPath, canonical } = require('./public-bundle.cjs')
const { mctsZsoftTasksDir } = require('./mcts-config.cjs')
const { prepareZsoftSourceHandoff } = require('./zsoft-source.cjs')

function fail(code, message) { throw Object.assign(new Error(message), { code }) }

function validateZsoftTasksSpec(spec) {
  if (spec?.provider !== 'zsoft-tasks' || typeof spec.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.taskId)
    || Object.keys(spec).some(key => !['provider', 'taskId'].includes(key))) {
    fail('ZSOFT_TASKS_DIR_INVALID', 'ZSoft 工作区任务配置不合法')
  }
}

class ZsoftTasksWorkspaceProvider {
  constructor(rootDir, mctsConfig = {}) { this.rootDir = rootDir; this.mctsConfig = mctsConfig }

  async prepare(spec, context) {
    validateZsoftTasksSpec(spec)
    if (!/^erun_[0-9a-f]{32}$/.test(context.runId) || context.benchmarkKey !== 'zsoft-l1') {
      fail('TASK_CONTEXT_MISMATCH', 'ZSoft 任务上下文不一致')
    }
    let tasksDir
    try { tasksDir = mctsZsoftTasksDir(this.mctsConfig) }
    catch (error) { fail('ZSOFT_TASKS_DIR_INVALID', error.message) }
    const taskRoot = path.join(tasksDir, spec.taskId)
    let manifest
    try { manifest = JSON.parse((await readBoundedFile(tasksDir, `${spec.taskId}/task.json`, 65536)).toString('utf8')) }
    catch (error) {
      if (error.code === 'ENOENT') fail('ZSOFT_TASK_MISSING', '执行机的 ZSoft 任务目录中缺少指定题目，请检查目录配置')
      throw error
    }
    const expected = context.benchmarkPayload
    const tags = [...(manifest.tags || [])]
    const kernel = tags.includes('kernel') || spec.taskId.startsWith('linux-rxrpc-')
    const track = kernel ? 'kernel' : 'userspace'
    if (!tags.includes(track)) tags.push(track)
    const kind = kernel ? 'c' : tags.includes('python') ? 'python' : tags.includes('c') ? 'c' : 'binary'
    if (!expected || manifest.task_id !== spec.taskId || expected.taskId !== spec.taskId
      || (tags.includes('kernel') && tags.includes('userspace'))
      || manifest.title !== expected.title || manifest.description !== expected.description
      || canonical(tags) !== canonical(expected.tags) || kind !== expected.submissionKind
      || manifest.submission?.max_bytes !== expected.maxBytes) {
      fail('ZSOFT_TASK_MISMATCH', '执行机的 ZSoft 题目与所选数据集不一致')
    }
    const metadata = { task_id: spec.taskId, title: expected.title, description: expected.description,
      tags, submission_kind: kind, max_bytes: expected.maxBytes }
    const sourceLock = await prepareZsoftSourceHandoff(tasksDir, spec.taskId)
    const workspace = path.join(this.rootDir, context.runId)
    await fsp.mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    await fsp.mkdir(workspace, { mode: 0o700 })
    let total = 0
    let count = 0
    const copyPublic = async (relative) => {
      context.signal?.throwIfAborted()
      const source = path.join(taskRoot, relative)
      const stat = await fsp.lstat(source)
      validatePublicPath(`tasks/${spec.taskId}/${relative}`, spec.taskId)
      if (stat.isSymbolicLink()) fail('PUBLIC_BUNDLE_FILE_INVALID', '公开题目文件不能是符号链接')
      if (stat.isDirectory()) {
        for (const entry of await fsp.readdir(source)) await copyPublic(`${relative}/${entry}`)
      } else if (stat.isFile()) {
        total += stat.size
        if (total > 512 * 1024 * 1024 || ++count > 100000) fail('PUBLIC_BUNDLE_TOO_LARGE', '公开题目资料超出大小或文件数量限制')
        const bytes = await readBoundedFile(taskRoot, relative, stat.size)
        const target = path.join(workspace, 'tasks', spec.taskId, relative)
        await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        await fsp.writeFile(target, bytes, { flag: 'wx', mode: stat.mode & 0o111 ? 0o700 : 0o600 })
      } else fail('PUBLIC_BUNDLE_FILE_INVALID', '公开题目资料包含特殊文件')
    }
    try {
      await readBoundedFile(taskRoot, 'public/README.md', 512 * 1024 * 1024)
      for (const entry of await fsp.readdir(path.join(taskRoot, 'public'))) await copyPublic(`public/${entry}`)
      await fsp.writeFile(path.join(workspace, 'tasks', spec.taskId, 'task.json'), canonical(metadata), { flag: 'wx', mode: 0o600 })
      if (sourceLock) {
        const privateDir = path.join(workspace, 'tasks', spec.taskId, 'private')
        const locksDir = path.join(workspace, 'source-locks')
        await fsp.mkdir(privateDir, { mode: 0o700 })
        await fsp.mkdir(locksDir, { mode: 0o700 })
        await fsp.writeFile(path.join(privateDir, 'source-manifest.json'), canonical({ source_id: sourceLock.source_id }), { flag: 'wx', mode: 0o600 })
        await fsp.writeFile(path.join(locksDir, `${sourceLock.source_id}.json`), canonical(sourceLock), { flag: 'wx', mode: 0o600 })
      }
      await fsp.mkdir(path.join(workspace, 'submission'), { mode: 0o700 })
      return { path: workspace }
    } catch (error) { await fsp.rm(workspace, { recursive: true, force: true }); throw error }
  }
}

module.exports = { ZsoftTasksWorkspaceProvider, validateZsoftTasksSpec }

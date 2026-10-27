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

const error = (code, message) => Object.assign(new Error(message), { code })
const preparers = new Map([['swe-bench', require('./benchmarks/swe-bench.cjs').prepareCaseWorkspace]])

async function prepareExecutionWorkspace(task, { exec }) {
  const prepare = preparers.get(task.benchmark.key)
  if (prepare) return prepare(task, { exec })
  await exec(['git', 'reset', '--hard', task.workspace.revision], 'workspace-reset')
  await exec(['git', 'clean', '-fd'], 'workspace-clean')
  const head = await exec(['git', 'rev-parse', 'HEAD'], 'workspace-head')
  const origin = await exec(['git', 'remote', 'get-url', 'origin'], 'workspace-origin')
  const status = await exec(['git', 'status', '--porcelain'], 'workspace-status')
  const normalize = value => value.trim().replace(/\.git\/?$/, '').replace(/\/$/, '')
  if (head.stdout.trim() !== task.workspace.revision || status.stdout.trim() || normalize(origin.stdout) !== normalize(task.workspace.repository)) throw error('WORKSPACE_REVISION_MISMATCH', '镜像仓库或工作树不是干净的冻结基线')
  return { baseCommit: head.stdout.trim(), datasetRevision: task.workspace.revision }
}

module.exports = { prepareExecutionWorkspace }

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

const preparers = new Map([['swe-bench', require('./benchmarks/swe-bench.cjs').prepareCaseImage]])

async function prepareExecutionImage(task, options) {
  const prepare = preparers.get(task.benchmark.key)
  if (prepare) return prepare(task, options)
  const { docker, signal } = options
  const { image: reference, arch } = task.execution.environment
  let image
  try { image = JSON.parse((await docker(['image', 'inspect', reference], { signal })).stdout)[0] } catch {
    await docker(['pull', '--platform', `linux/${arch}`, reference], { signal })
    image = JSON.parse((await docker(['image', 'inspect', reference], { signal })).stdout)[0]
  }
  return { image }
}

module.exports = { prepareExecutionImage }

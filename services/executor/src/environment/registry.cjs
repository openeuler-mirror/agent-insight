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
function loadEnvironmentAdapter(key) {
  const builtins = { generic: './datasets/generic.cjs', reliability: './datasets/reliability.cjs' }
  let implementation
  if (Object.hasOwn(builtins, key)) implementation = require(builtins[key])
  else {
    const installed = path.resolve(__dirname, '../generated/benchmark-catalog/executors.cjs')
    const catalog = require(fs.existsSync(installed) ? installed : path.resolve(__dirname, '../../../../generated/benchmark-catalog/executors.cjs'))
    const descriptor = catalog.generatedEnvironmentPreparationDescriptors?.find(item => item.datasetAdapterKey === key)
    if (!descriptor) throw Object.assign(new Error('客户端未包含该数据集的环境准备能力，请更新客户端后重试。'), { code: 'ENVIRONMENT_ADAPTER_UNAVAILABLE' })
    implementation = require(descriptor.modulePath)
  }
  if (typeof implementation.checkEnvironment !== 'function' || typeof implementation.prepareEnvironment !== 'function') throw new Error('数据集环境准备协议不兼容，请更新客户端。')
  return implementation
}
async function prepareEnvironment(context, services, report, load = loadEnvironmentAdapter) {
  const adapter = load(context.dataset.adapterKey)
  await report({ state: 'checking' })
  let result = await adapter.checkEnvironment(context, services)
  if (result.issues.length) return { state: 'needs_action', issues: result.issues }
  if (result.prepare.length) {
    await report({ state: 'preparing' })
    await adapter.prepareEnvironment(context, services, report)
    await report({ state: 'checking' })
    result = await adapter.checkEnvironment(context, services)
  }
  if (result.issues.length) return { state: 'needs_action', issues: result.issues }
  if (result.prepare.length) throw Object.assign(new Error('准备后仍有运行组件未就绪，请检查执行机配置后再次点击“下一步”。'), { code: 'ENVIRONMENT_VERIFICATION_FAILED' })
  return { state: 'ready', issues: [] }
}
async function checkEnvironment(context, services, report, load = loadEnvironmentAdapter) {
  await report({ state: 'checking' })
  const result = await load(context.dataset.adapterKey).checkEnvironment(context, services)
  if (result.issues.length) return { state: 'needs_action', issues: result.issues }
  if (result.prepare.length) return { state: 'needs_action', issues: [{ code: 'ENVIRONMENT_CHANGED', message: '执行机环境已变化，请再次点击“下一步”重新检查并准备。' }] }
  return { state: 'ready', issues: [] }
}
module.exports = { loadEnvironmentAdapter, prepareEnvironment, checkEnvironment }

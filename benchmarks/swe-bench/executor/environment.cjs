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

async function checkEnvironment(context, services) {
  const binding = services.executionBinding(context)
  if (binding?.backendKey === 'xgovernor') return services.checkSandbox(context, binding)
  if (context.platform === 'pi-mcts') return services.checkMcts(context, 'swe-bench')
  return { issues: await services.checkAgent(context), prepare: [] }
}
async function prepareEnvironment(context, services, reportProgress) {
  const binding = services.executionBinding(context)
  if (!binding || binding.backendKey !== 'xgovernor') throw new Error('所选执行方式没有自动准备操作')
  await services.prepareSandbox(context, binding, reportProgress)
}
module.exports = { checkEnvironment, prepareEnvironment }

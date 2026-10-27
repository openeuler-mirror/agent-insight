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
  const issues = await services.checkAgent(context)
  if (!['opencode', 'xiaoo'].includes(context.platform)) {
    issues.push({ code: 'FI_PLATFORM_UNSUPPORTED', message: '所选 Agent 暂不支持故障注入，请选择支持的 Agent。' })
    return { issues, prepare: [] }
  }
  const fi = await services.checkFaultInjection(context)
  issues.push(...fi.issues)
  return { issues, prepare: fi.prepare }
}
async function prepareEnvironment(context, services, reportProgress) {
  await reportProgress({ state: 'preparing' })
  await services.prepareFaultInjection(context)
}
module.exports = { checkEnvironment, prepareEnvironment }

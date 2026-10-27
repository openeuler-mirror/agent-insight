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
  if (context.platform === 'pi-mcts') return services.checkMcts(context, 'zsoft-l1')
  const issues = await services.checkAgent(context)
  issues.push(...await services.checkZsoftSource(context))
  return { issues, prepare: [] }
}
async function prepareEnvironment() {}
module.exports = { checkEnvironment, prepareEnvironment }

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

const protocol = require('./execution-protocol.cjs')
const { loadProjectConfig } = require('./project-config.cjs')
const probes = { xgovernor: () => require('./xgovernor/profile.cjs'), local: () => require('./local-profile.cjs') }
function executionCapabilities(options = {}) {
  const raw = options.config || loadProjectConfig('executor').execution
  const profiles = []; const configured = {}
  for (const [key, local] of Object.entries(raw.profiles)) {
    const backend = local.backend || 'xgovernor'
    if (!Object.hasOwn(probes, backend)) throw Object.assign(new Error(`执行后端不可用: ${backend}`), { code: 'EXECUTOR_CAPABILITY_MISSING' })
    let result
    try { result = probes[backend]().probe({ ...options, config: { profiles: { [key]: local }, bindings: raw.bindings } }) }
    catch {
      result = { config: { profiles: { [key]: local } }, profiles: [{ profile: protocol.describeProfile(key, local),
        benchmarks: raw.bindings.filter(b => b.profile === key).flatMap(b => b.benchmarks), ready: false, note: '执行后端探测失败，请检查对应后端配置与依赖' }] }
    }
    configured[key] = result.config.profiles[key]
    profiles.push(...result.profiles)
  }
  return { profiles, config: { profiles: configured, bindings: raw.bindings } }
}
module.exports = { ...protocol, executionCapabilities }

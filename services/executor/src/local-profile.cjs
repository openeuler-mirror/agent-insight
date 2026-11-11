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
const protocol = require('./execution-protocol.cjs')
function runtimeFor(platform) {
  const source = path.resolve(__dirname, '../../../scripts/reliability-client.cjs')
  return require(fs.existsSync(source) ? source : path.resolve(__dirname, '../reliability-client.cjs')).probeExperimentRuntime(platform)
}
function probe(options) {
  const profiles = []; const configured = {}
  const artifactDigest = protocol.digest(['execution-backend.cjs', 'index.cjs', 'local-profile.cjs'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')))
  for (const [key, raw] of Object.entries(options.config.profiles)) {
    const config = { ...raw }; const runtimes = {}
    const targetReadiness = {}; const targetCapabilities = {}
    for (const target of config.targets) {
      let runtime
      try { runtime = (options.runtimeProbe || runtimeFor)(target.platform) } catch (error) { runtime = { reason: error.message } }
      runtimes[target.platform] = { version: runtime?.version || null }
      const native = options.nativePlatforms?.find(p => p.id === target.platform)
      const catalogReady = !options.nativePlatforms || Boolean(native && target.agents.every(agent => native.agents?.includes(agent))
        && config.models.every(model => native.models?.includes(model)))
      const ready = Boolean(runtime?.ready && runtime.canResolveTraceId && catalogReady)
      const note = ready ? undefined : runtime?.reason || '原生 Runtime 或完整 Trace 能力未就绪'
      targetReadiness[target.platform] = { ready, ...(note ? { note } : {}) }
      targetCapabilities[target.platform] = { returnsTraceId: ready }
    }
    config.artifactDigest = protocol.digest({ artifactDigest, runtimes })
    configured[key] = config
    const ready = Object.values(targetReadiness).every(item => item.ready)
    profiles.push({ profile: protocol.describeProfile(key, config), benchmarks: options.config.bindings.filter(b => b.profile === key).flatMap(b => b.benchmarks), ready,
      targetReadiness, targetCapabilities, ...(!ready ? { note: '部分原生 Runtime 或 Trace 能力未就绪' } : {}) })
  }
  return { profiles, config: { ...options.config, profiles: configured } }
}
module.exports = { probe }

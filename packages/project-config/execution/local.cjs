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

const protocol = () => require('../../benchmark-protocol/execution.cjs')
function normalize(key, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['targets', 'models', 'timeouts'].includes(k))) throw new Error('本地 Profile 包含未知字段')
  if (raw.timeouts !== undefined && (!raw.timeouts || typeof raw.timeouts !== 'object' || Array.isArray(raw.timeouts))) throw new Error('本地 Profile timeouts 必须为对象')
  const config = { targets: raw.targets, models: raw.models === undefined ? [] : raw.models, timeouts: { prepareSeconds: 300, cleanupSeconds: 120, ...raw.timeouts }, backend: 'local' }
  describe(key, config)
  return config
}
function describe(key, config) {
  return protocol().createProfile({ key, backendKey: 'local', sandbox: 'none', network: 'client-default', sourceRevision: 'unknown',
    implementationDigest: protocol().digest({ backend: 'local', targets: config.targets, models: config.models, timeouts: config.timeouts, artifactDigest: config.artifactDigest || null }),
    ...(config.artifactDigest ? { artifactDigest: config.artifactDigest } : {}), targets: config.targets, models: config.models, timeouts: config.timeouts })
}
module.exports = { normalize, describe }

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

const { SweBenchImageResolver, imageProxyPrefix, verifiedImageMirrorRepositories } = require('./index.cjs')

function describeImages(payload, arch) {
  const instance = payload?.instance
  if (!instance || !/^[a-z0-9_.-]{1,200}$/i.test(String(instance.instance_id || ''))) {
    throw new Error('SWE-bench image preparation requires a valid instance_id')
  }
  const daemonArch = ['amd64', 'x86_64'].includes(arch) ? 'x86_64' : arch === 'aarch64' ? 'arm64' : arch
  const selected = new SweBenchImageResolver().imageFor(String(instance.image || ''), instance.instance_id, daemonArch)
  const proxy = imageProxyPrefix()
  const mirrors = selected.source === 'official' && selected.arch === 'x86_64' ? verifiedImageMirrorRepositories() : []
  return [{
    key: selected.image,
    arch: selected.arch,
    references: [
      ...mirrors.map((repository) => `${repository}:${instance.instance_id}`),
      ...(proxy ? [`${proxy}/${selected.image}`] : []),
      selected.image,
    ],
    context: { ...selected, daemonArch, imageMirrorRepositories: mirrors, imageProxyPrefix: proxy || null },
  }]
}

module.exports = { describeImages }

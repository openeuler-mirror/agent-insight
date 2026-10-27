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

function remoteImage(image) {
  const host = String(image || '').split('/')[0]
  return String(image || '').includes('/') && (host.includes('.') || host.includes(':') || host === 'localhost')
}

function runtimeDescriptor(descriptor, prefix = process.env.EVALUATOR_RUNTIME_IMAGE_PREFIX || '') {
  if (!prefix || remoteImage(descriptor.image)) return descriptor
  prefix = prefix.replace(/\/+$/, '')
  if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9._-]+)+$/.test(prefix) || !remoteImage(`${prefix}/runtime`)) {
    throw new Error('EVALUATOR_RUNTIME_IMAGE_PREFIX must be registry/namespace')
  }
  return { ...descriptor, image: `${prefix}/${descriptor.image}` }
}

module.exports = { runtimeDescriptor, remoteImage }

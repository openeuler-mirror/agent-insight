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

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { runtimePackageRoot } from '../src/lib/runtime/package-root'

test('runtime package root does not follow standalone cwd when explicitly configured', () => {
  const previous = process.env.AGENT_INSIGHT_PACKAGE_ROOT
  try {
    process.env.AGENT_INSIGHT_PACKAGE_ROOT = path.join(process.cwd(), 'package-root')
    assert.equal(runtimePackageRoot(), path.resolve(process.cwd(), 'package-root'))
  } finally {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_PACKAGE_ROOT
    else process.env.AGENT_INSIGHT_PACKAGE_ROOT = previous
  }
})

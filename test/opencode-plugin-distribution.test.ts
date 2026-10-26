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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { GET } from '../src/app/api/ingest/setup/opencode/route'

test('downloaded OpenCode plugin exposes only the default plugin factory', async () => {
  const response = await GET()
  assert.equal(response.status, 200)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-artifact-'))
  const artifact = path.join(root, 'Witty-Skill-Insight.ts')
  try {
    fs.writeFileSync(artifact, await response.text(), 'utf8')
    const pluginModule = await import(`${pathToFileURL(artifact).href}?v=${Date.now()}`)
    assert.deepEqual(Object.keys(pluginModule), ['default'])
    assert.equal(typeof pluginModule.default, 'function')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

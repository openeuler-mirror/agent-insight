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
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activateIsolatedHome } from './isolated-home'

export function createIsolatedDatabase() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-test-db-'))
  const restore = activateIsolatedHome(home)
  const dispose = () => {
    restore()
    fs.rmSync(home, { recursive: true, force: true })
  }
  try {
    fs.closeSync(fs.openSync(path.join(home, 'test.db'), 'wx'))
    const result = spawnSync(process.execPath, [
      path.resolve('node_modules/prisma/build/index.js'), 'db', 'push',
      '--schema', path.resolve('prisma/schema.prisma'), '--skip-generate',
    ], { env: process.env, encoding: 'utf8', timeout: 120_000 })
    assert.equal(result.status, 0, result.error?.message || result.stderr || 'Temporary test database initialization failed')
    return { home, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}

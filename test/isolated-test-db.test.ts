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
import test from 'node:test'
import { isolatedHomeEnv } from './helpers/isolated-home'

test('446-17: DB-backed regressions bootstrap without any personal Agent Insight database', t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-clean-test-home-'))
    t.after(() => fs.rmSync(home, { recursive: true, force: true }))
    const result = spawnSync(process.execPath, ['--import', 'tsx', '-e',
        'const db = require("./test/helpers/isolated-test-db.ts").isolateTestDatabase("clean"); if (!require("node:fs").existsSync(db.dbFile)) process.exit(2)'],
    { env: isolatedHomeEnv(home), encoding: 'utf8', timeout: 120000 })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
    assert.equal(fs.existsSync(path.join(home, '.agent-insight', 'data', 'witty_insight.db')), false)
})

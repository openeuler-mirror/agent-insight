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
import path from 'node:path'
import test from 'node:test'
import { createIsolatedDatabase } from './helpers/isolated-database'

test('managed OpenCode uses private databases and cleans up temporary instances', async t => {
  const fixture = createIsolatedDatabase()
  const root = fixture.home
  const userCliData = path.join(root, 'user-cli-data')
  const userCliDb = path.join(userCliData, 'opencode', 'opencode.db')
  const binary = path.join(root, 'opencode-fixture')
  fs.mkdirSync(path.dirname(userCliDb), { recursive: true })
  fs.writeFileSync(userCliDb, 'user CLI database')
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const data = process.env.XDG_DATA_HOME
const database = process.env.OPENCODE_DB || path.join(data, 'opencode', 'opencode.db')
fs.mkdirSync(path.dirname(database), { recursive: true })
fs.writeFileSync(database, 'platform database')
if (process.env.OPENCODE_TEST_START_FAILURE === 'exit') {
  fs.writeSync(2, 'SQLiteError: table project already exists token=fixture-secret\\n')
  process.exit(1)
}
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
require('node:http').createServer((req, res) => {
  if (process.env.OPENCODE_TEST_START_FAILURE === 'health') {
    res.statusCode = 500
    res.end('SQLiteError: table project already exists token=fixture-secret')
    return
  }
  res.end(JSON.stringify({
    database, data, state: process.env.XDG_STATE_HOME, cache: process.env.XDG_CACHE_HOME,
    home: process.env.HOME,
  }))
}).listen(port, '127.0.0.1')
`, { mode: 0o700 })
  const env = {
    AGENT_INSIGHT_HOME: process.env.AGENT_INSIGHT_HOME!,
    OPENCODE_BIN: binary,
    OPENCODE_DB: userCliDb,
    XDG_DATA_HOME: userCliData,
    XDG_STATE_HOME: path.join(root, 'user-cli-state'),
    XDG_CACHE_HOME: path.join(root, 'user-cli-cache'),
    OPENCODE_TEST_START_FAILURE: '',
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fixture.dispose()
  })

  const { ensureOpencodeServer, stopOpencodeServer, runWithEphemeralOpencodeServer } =
    await import('../src/lib/engine/skill-generation/opencode-agent-cli/opencode-manager')
  const runtime = async (url: string): Promise<{ database: string; data: string; state: string; cache: string; home: string }> =>
    (await fetch(url)).json()
  const users = ['fixture.a', 'fixture_a']
  try {
    const urls = await Promise.all(users.map(user => ensureOpencodeServer({ user })))
    const [first, second] = await Promise.all(urls.map(runtime))
    assert.notEqual(first.database, second.database)
    assert.equal(first.home, process.env.HOME)
    for (const instance of [first, second]) {
      assert.ok(instance.data.startsWith(path.join(env.AGENT_INSIGHT_HOME, 'data', '.opencode-runtime') + path.sep))
      assert.equal(path.dirname(instance.state), path.dirname(instance.data))
      assert.equal(path.dirname(instance.cache), path.dirname(instance.data))
      assert.equal(fs.readFileSync(instance.database, 'utf8'), 'platform database')
    }
    await stopOpencodeServer(users[0])
    assert.equal((await runtime(await ensureOpencodeServer({ user: users[0] }))).database, first.database)

    for (const isolateHome of [false, true]) {
      const instance = await runWithEphemeralOpencodeServer({ user: users[0], isolateHome }, runtime)
      assert.notEqual(instance.database, first.database)
      assert.equal(instance.home, isolateHome ? path.dirname(instance.data) : process.env.HOME)
      assert.equal(fs.existsSync(path.dirname(instance.data)), false)
    }

    await t.test('startup errors retain the SQLite cause from the child and the health check', async st => {
      const timeout = AbortSignal.timeout.bind(AbortSignal)
      st.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 30_000 ? 2000 : ms))
      for (const [mode, pattern] of [
        ['exit', /exited during startup.*table project already exists/],
        ['health', /HTTP 500 \(table project already exists\)/],
      ] as const) {
        process.env.OPENCODE_TEST_START_FAILURE = mode
        await assert.rejects(runWithEphemeralOpencodeServer({ user: users[0] }, runtime), error => {
          assert.ok(error instanceof Error)
          assert.match(error.message, pattern)
          assert.doesNotMatch(error.message, /fixture-secret/)
          return true
        })
        assert.ok(fs.readdirSync(path.dirname(path.dirname(first.data))).every(name => !name.startsWith('isolated-home-')))
      }
    })
    assert.equal(fs.readFileSync(userCliDb, 'utf8'), 'user CLI database')
    assert.equal(process.env.OPENCODE_DB, userCliDb)
  } finally {
    await Promise.all(users.map(user => stopOpencodeServer(user)))
  }
})

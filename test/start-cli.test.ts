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

for (const mode of ['dev', 'start']) {
  test(`CLI fallback launches Next ${mode} on the requested port`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-cli-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const write = (file: string, content: string) => {
      const target = path.join(root, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
    for (const file of ['bin/cli.js', 'scripts/start.js', 'scripts/agent-insight-home.cjs']) {
      write(file, fs.readFileSync(file, 'utf8'))
    }
    write('scripts/utils.js', `
const fs = require('node:fs')
module.exports = {
  findPidOnPort: () => fs.existsSync('ready') ? 1 : null,
  getPort: options => options.port,
  ensureEnvFile() {},
  ensureDataDirectory() {},
  runCommand: async command => fs.appendFileSync('commands', command + '\\n'),
  sleep: () => new Promise(resolve => setTimeout(resolve, 100)),
  getDataRoot: () => process.cwd(),
}
`)
    write('scripts/sync_admin_api_key.js', 'exports.syncAdminApiKey = async () => ({})')
    write('scripts/sync-prisma-client.js', 'exports.syncGeneratedPrismaClient = () => {}')
    write('scripts/lib/fi-python-runtime.js', 'exports.readCurrentRuntime = exports.resolveBootstrapPython = () => null')
    write('scripts/benchmark/generate-catalog.cjs', 'exports.generate = () => ["fixture"]')
    write('node_modules/next/dist/bin/next', `
require('node:fs').writeFileSync('args', JSON.stringify(process.argv.slice(2)))
require('node:fs').writeFileSync('ready', '')
`)
    if (mode === 'start') write('.next/BUILD_ID', 'fixture')

    const env = { ...process.env }
    delete env.AGENT_INSIGHT_DATA_DIR
    const result = spawnSync(process.execPath, ['bin/cli.js', 'start', '--port', '34817'], {
      cwd: root, env, encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'args'), 'utf8')), [mode, '--port', '34817'])
    assert.equal(result.stdout.includes('[benchmark catalog] generated: fixture'), mode === 'dev')
    assert.deepEqual(fs.readFileSync(path.join(root, 'commands'), 'utf8').trim().split('\n'), [
      'npx prisma generate', 'node scripts/prepare-ras-sqlite-schema.js', 'npx prisma db push --skip-generate',
    ])
  })
}

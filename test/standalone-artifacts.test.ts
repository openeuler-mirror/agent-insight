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
import test from 'node:test'
import { createRequire } from 'node:module'

const { verifyStandalone } = createRequire(import.meta.url)('../scripts/verify-standalone.cjs')

test('standalone preflight rejects missing pages and client reference manifests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-check-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const files = {
    'server.js': '', '.next/BUILD_ID': 'test', '.next/required-server-files.json': '{}',
    '.next/server/app-paths-manifest.json': JSON.stringify({ '/(app)/dataset/page': 'app/(app)/dataset/page.js', '/api/ping/route': 'app/api/ping/route.js' }),
    '.next/server/pages-manifest.json': JSON.stringify({ '/500': 'pages/500.html' }),
    '.next/server/app/(app)/dataset/page.js': '',
    '.next/server/app/(app)/dataset/page_client-reference-manifest.js': '',
    '.next/server/app/api/ping/route.js': '', '.next/server/pages/500.html': '',
  }
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    fs.writeFileSync(path.join(root, relative), content)
  }
  assert.doesNotThrow(() => verifyStandalone(root))
  for (const relative of Object.keys(files)) {
    fs.unlinkSync(path.join(root, relative))
    assert.throws(() => verifyStandalone(root), /Incomplete standalone build/)
    fs.writeFileSync(path.join(root, relative), files[relative as keyof typeof files])
  }
})

test('startup readiness rejects HTTP 500 instead of accepting an open port', () => {
  const script = fs.readFileSync('scripts/start.sh', 'utf8')
  assert.ok(script.includes('node scripts/verify-standalone.cjs "$STANDALONE_DIR"'))
  assert.match(script, /^HEALTH_URL="http:\/\/127\.0\.0\.1:\$PLATFORM_PORT\$BASE_PATH"$/m)
  const readiness = script.slice(script.indexOf('READY=0'))
  for (const route of ['dataset', 'fault']) assert.ok(readiness.includes(`$HEALTH_URL/${route}`))
  assert.match(readiness, /curl --noproxy '\*' -fsS/)
})

test('npm start prepares standalone static assets before booting the server (Bug 446-4)', (t) => {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.equal(manifest.scripts.start, 'node scripts/start-standalone.cjs', 'npm start 必须走资源准备启动器，不得直接 node standalone/server.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-standalone-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, '.next', 'standalone', '.next'), { recursive: true })
  fs.writeFileSync(path.join(root, '.next', 'standalone', 'server.js'), '')
  fs.mkdirSync(path.join(root, '.next', 'static', 'chunks'), { recursive: true })
  fs.writeFileSync(path.join(root, '.next', 'static', 'chunks', 'app.js'), 'console.log(1)')
  fs.mkdirSync(path.join(root, 'public'), { recursive: true })
  fs.writeFileSync(path.join(root, 'public', 'logo.svg'), '<svg/>')
  const { syncStandaloneAssets } = createRequire(import.meta.url)('../scripts/start-standalone.cjs')
  syncStandaloneAssets(root)
  assert.equal(fs.readFileSync(path.join(root, '.next', 'standalone', '.next', 'static', 'chunks', 'app.js'), 'utf8'), 'console.log(1)')
  assert.equal(fs.readFileSync(path.join(root, '.next', 'standalone', 'public', 'logo.svg'), 'utf8'), '<svg/>')
  // 重复同步幂等，且能覆盖旧构建产物
  fs.writeFileSync(path.join(root, '.next', 'static', 'chunks', 'app.js'), 'console.log(2)')
  syncStandaloneAssets(root)
  assert.equal(fs.readFileSync(path.join(root, '.next', 'standalone', '.next', 'static', 'chunks', 'app.js'), 'utf8'), 'console.log(2)')
})

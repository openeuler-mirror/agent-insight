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

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import AdmZip from 'adm-zip'

const require = createRequire(import.meta.url)
const prepare = require('../scripts/prepare-npm-package.js')

test('standalone packaging refreshes legal files and includes nested third-party licenses', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-licenses-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const standalone = path.join(root, '.next', 'standalone')
  fs.mkdirSync(standalone, { recursive: true })
  const files = ['LICENSE', 'NOTICE', 'LICENSE-MIT-Historical', 'Third_Party_Open_Source_Software_Notice.txt']
  for (const name of files) {
    fs.writeFileSync(path.join(root, name), `current ${name}\n`)
    fs.writeFileSync(path.join(standalone, name), 'stale')
  }
  fs.mkdirSync(path.join(root, 'licenses', 'fonts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'licenses', 'fonts', 'OFL.txt'), 'font copyright and license')
  prepare.copyLegalFiles(root, standalone)
  for (const name of files) {
    assert.equal(fs.readFileSync(path.join(standalone, name), 'utf8'), `current ${name}\n`)
  }
  assert.equal(fs.readFileSync(path.join(standalone, 'licenses', 'fonts', 'OFL.txt'), 'utf8'), 'font copyright and license')
})

test('standalone packaging refuses to omit required license material', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-missing-license-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(() => prepare.copyLegalFiles(root, path.join(root, 'standalone')), /Missing legal file.*LICENSE/)
})

test('Qoder VSIX keeps its Mulan license and carries the collector Apache and historical MIT notices', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-licenses-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { buildDesktopVsix } = await import('../integrations/qoder-desktop/build-vsix.mjs')
  const zip = new AdmZip(buildDesktopVsix(path.join(root, 'collector.vsix')))
  assert.match(zip.readAsText('extension/LICENSE.txt'), /Mulan Permissive Software License/)
  assert.match(zip.readAsText('extension/collector/LICENSE'), /Apache License/)
  assert.match(zip.readAsText('extension/LICENSE-MIT-Historical'), /Skill-Insight Contributors/)
})

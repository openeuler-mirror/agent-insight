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
import test, { type TestContext } from 'node:test'

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsoft-bootstrap-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const configDir = path.join(root, 'config')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(configDir)
  fs.mkdirSync(bin)
  const calls = path.join(root, 'calls.jsonl')
  fs.writeFileSync(path.join(bin, 'npx'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.BOOTSTRAP_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
const key = process.argv.includes('zsoft-l1') ? 'zsoft-l1' : 'swe-bench';
console.log(key + ': ' + (process.env.BOOTSTRAP_OUTPUT || 'imported'));
if (process.env.BOOTSTRAP_FAIL === key) { console.error('fixture import failed: ' + key); process.exit(1); }
`, { mode: 0o755 })
  const env = { ...process.env, AGENT_INSIGHT_CONFIG_DIR: configDir, AGENT_INSIGHT_HOME: root,
    DATABASE_URL: `file:${root}/fixture.db`, BOOTSTRAP_CALLS: calls, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  const configure = (value: unknown) => fs.writeFileSync(path.join(configDir, 'platform.local.yaml'), JSON.stringify(value))
  const run = () => spawnSync(process.execPath, ['scripts/benchmark/bootstrap-zsoft-dataset.cjs'], { env, encoding: 'utf8', timeout: 10_000 })
  return { root, calls, env, configure, run }
}

test('disabled and invalid ZSoft auto-import never invoke the importer or create logs', t => {
  const f = fixture(t)
  for (const autoImport of [false, 'false', null]) {
    f.configure({ benchmarks: { 'zsoft-l1': { dataset: { autoImport } } } })
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    if (autoImport === false) {
      assert.equal(result.stderr, '')
      assert.match(result.stdout, /ZSoft L1 自动导入已关闭/)
    } else {
      assert.match(result.stderr, /benchmarks.zsoft-l1.dataset.autoImport.*类型或取值不合法/)
      assert.match(result.stderr, /将继续启动服务/)
    }
    assert.equal(fs.existsSync(f.calls), false)
    assert.equal(fs.existsSync(path.join(f.root, 'logs')), false)
  }
})

test('default ZSoft auto-import uses the shared CLI, records logs, and retries after failure', t => {
  const f = fixture(t)
  const log = path.join(f.root, 'logs', 'zsoft-l1-bootstrap.log')
  const failed = spawnSync(process.execPath, ['scripts/benchmark/bootstrap-zsoft-dataset.cjs'], {
    env: { ...f.env, BOOTSTRAP_FAIL: 'zsoft-l1' }, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(failed.status, 0)
  assert.equal(failed.stderr.trim().split('\n').length, 4)
  assert.match(failed.stderr, /将继续启动服务/)
  assert.match(failed.stderr, /benchmarks.zsoft-l1.dataset.source、revision/)
  assert.ok(failed.stderr.includes(log))
  assert.match(failed.stderr, /下次启动自动重试/)
  assert.match(fs.readFileSync(log, 'utf8'), /fixture import failed/)
  const success = f.run()
  assert.equal(success.status, 0, success.stderr)
  assert.equal(success.stderr, '')
  assert.match(success.stdout, /ZSoft L1 数据集已就绪/)
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /fixture import failed/)
  assert.deepEqual(fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [
    ['tsx', 'scripts/benchmark/ensure-dataset.ts', '--benchmark', 'zsoft-l1'],
    ['tsx', 'scripts/benchmark/ensure-dataset.ts', '--benchmark', 'zsoft-l1'],
  ])
})

test('ZSoft logging failures warn without invoking the importer or naming a nonexistent log', t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, 'logs'), 'not a directory')
  const result = f.run()
  assert.equal(result.status, 0)
  assert.match(result.stderr, /写入权限/)
  assert.match(result.stderr, /将继续启动服务/)
  assert.doesNotMatch(result.stderr, /详细错误见/)
  assert.equal(fs.existsSync(f.calls), false)
})

test('start.sh prepares both datasets independently and reaches the build after either fails', t => {
  const f = fixture(t)
  const script = fs.readFileSync('scripts/start.sh', 'utf8')
  const begin = script.indexOf('if ! node scripts/benchmark/bootstrap-swe-bench-dataset.cjs; then')
  const end = script.indexOf('\nstage_done', begin)
  assert.ok(begin > 0 && end > begin)
  const startupStep = script.slice(begin, end) + '\necho "Building project..."\n'
  assert.match(startupStep, /bootstrap-zsoft-dataset.cjs/)
  for (const failure of ['swe-bench', 'zsoft-l1']) {
    const result = spawnSync('bash', [], { input: startupStep, env: { ...f.env, BOOTSTRAP_FAIL: failure }, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Building project/)
    assert.match(result.stdout, /Preparing SWE-bench Verified dataset/)
    assert.match(result.stdout, /Preparing ZSoft L1 dataset/)
    assert.match(result.stderr, /将继续启动服务/)
    assert.match(fs.readFileSync(path.join(f.root, 'logs', `${failure}-bootstrap.log`), 'utf8'), /fixture import failed/)
    const other = failure === 'swe-bench' ? 'zsoft-l1' : 'swe-bench'
    assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'logs', `${other}-bootstrap.log`), 'utf8'), /fixture import failed/)
  }
  for (const disabled of ['swe-bench', 'zsoft-l1']) {
    f.configure({ benchmarks: { [disabled]: { dataset: { autoImport: false } } } })
    fs.writeFileSync(f.calls, '')
    const result = spawnSync('bash', [], { input: startupStep, env: f.env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /Building project/)
    const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].includes('zsoft-l1'), disabled !== 'zsoft-l1')
  }
})

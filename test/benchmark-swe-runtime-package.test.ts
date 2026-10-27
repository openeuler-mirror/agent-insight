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
import test, { type TestContext } from 'node:test'
import { spawnSync } from 'node:child_process'

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-runtime-package-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dockerfile = fs.readFileSync('benchmarks/swe-bench/evaluator/Dockerfile', 'utf8')
  const copies = dockerfile.split('\n').filter(line => line.startsWith('COPY '))
  assert.ok(copies.length)
  for (const copy of copies) {
    const match = /^COPY (\S+) \.\/(\S+)$/.exec(copy)
    assert.ok(match, `Update package-layout test for unsupported COPY syntax: ${copy}`)
    const target = path.join(root, match[2])
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(path.resolve(match[1]), target, { recursive: true })
  }
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', AGENT_INSIGHT_CONFIG_DIR: path.join(root, 'config', 'benchmark'), AGENT_INSIGHT_EVALUATOR_CONFIG_JSON: '' }
  return { root, dockerfile, env }
}

const loadEntrypoints = `
  const assert = require('node:assert/strict');
  const root = process.cwd();
  const entrypoint = require(root + '/benchmarks/swe-bench/evaluator/entrypoint.cjs');
  const smoke = require(root + '/benchmarks/swe-bench/smoke/index.cjs');
  const { SweBenchEvaluator } = require(root + '/benchmarks/swe-bench/evaluator/index.cjs');
  assert.equal(typeof entrypoint.main, 'function');
  assert.equal(typeof smoke.runSmoke, 'function');
  assert.equal(new SweBenchEvaluator().key, 'swe-bench');
  console.log('SWE_RUNTIME_ENTRYPOINTS_OK');
`

test('Dockerfile COPY layout loads evaluation and smoke entrypoints without repository or node_modules fallback', t => {
  const f = fixture(t)
  const result = spawnSync(process.execPath, ['-e', loadEntrypoints], { cwd: f.root, env: f.env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /SWE_RUNTIME_ENTRYPOINTS_OK/)
  assert.match(f.dockerfile, /RUN node -e .*require\('\.\/benchmarks\/swe-bench\/evaluator\/entrypoint\.cjs'\).*require\('\.\/benchmarks\/swe-bench\/smoke\/index\.cjs'\)/)
})

test('packaged CLI reaches protocol argument validation instead of failing module resolution', t => {
  const f = fixture(t)
  const result = spawnSync(process.execPath, ['benchmarks/swe-bench/evaluator/entrypoint.cjs'], { cwd: f.root, env: f.env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  const failure = JSON.parse(result.stderr.trim())
  assert.equal(failure.code, 'EVALUATOR_ENTRYPOINT_FAILED')
  assert.match(failure.message, /usage: evaluator doctor/)
})

for (const dependency of ['services/evaluator/src/runtime-image.cjs', 'services/evaluator/src/evaluator-assets.cjs', 'packages/benchmark-protocol/artifact-path.cjs']) {
  test(`missing packaged dependency ${dependency} reproduces MODULE_NOT_FOUND`, t => {
    const f = fixture(t)
    fs.rmSync(path.join(f.root, dependency))
    const result = spawnSync(process.execPath, ['-e', loadEntrypoints], { cwd: f.root, env: f.env, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /MODULE_NOT_FOUND/)
    assert.ok(result.stderr.includes(path.basename(dependency)))
  })
}

test('SWE-bench evaluation Runtime remains configured for denied network access', () => {
  const config = fs.readFileSync('benchmarks/swe-bench/evaluator/evaluator.yaml', 'utf8')
  assert.match(config, /^network: deny$/m)
})

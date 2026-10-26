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

import { resolveOpencodeBinary } from '../src/lib/engine/skill-generation/opencode-agent-cli/opencode-manager'

test('opencode binary resolution supports standalone and source deployments', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-binary-')))
  const previousCwd = process.cwd()
  const previousRoot = process.env.AGENT_INSIGHT_PACKAGE_ROOT
  const previousBinary = process.env.OPENCODE_BIN
  const localBinary = path.join(root, 'node_modules', '.bin', 'opencode')
  const standalone = path.join(root, '.next', 'standalone')
  const override = path.join(root, 'custom-opencode')
  fs.mkdirSync(path.dirname(localBinary), { recursive: true })
  fs.mkdirSync(standalone, { recursive: true })
  fs.writeFileSync(localBinary, '')
  fs.writeFileSync(override, '')
  try {
    delete process.env.OPENCODE_BIN
    process.env.AGENT_INSIGHT_PACKAGE_ROOT = root
    process.chdir(standalone)

    await t.test('standalone finds the binary in the package root', () => {
      assert.equal(resolveOpencodeBinary(), localBinary)
    })
    await t.test('explicit binary takes priority over the package root', () => {
      process.env.OPENCODE_BIN = override
      assert.equal(resolveOpencodeBinary(), override)
    })
    await t.test('missing explicit binary falls back to the package root', () => {
      process.env.OPENCODE_BIN = path.join(root, 'missing')
      assert.equal(resolveOpencodeBinary(), localBinary)
      delete process.env.OPENCODE_BIN
    })
    await t.test('source deployment uses cwd without a configured package root', () => {
      delete process.env.AGENT_INSIGHT_PACKAGE_ROOT
      process.chdir(root)
      assert.equal(resolveOpencodeBinary(), localBinary)
    })
    await t.test('deployment without a local binary falls back to PATH', () => {
      process.chdir(standalone)
      assert.equal(resolveOpencodeBinary(), 'opencode')
    })
  } finally {
    process.chdir(previousCwd)
    if (previousRoot === undefined) delete process.env.AGENT_INSIGHT_PACKAGE_ROOT
    else process.env.AGENT_INSIGHT_PACKAGE_ROOT = previousRoot
    if (previousBinary === undefined) delete process.env.OPENCODE_BIN
    else process.env.OPENCODE_BIN = previousBinary
    fs.rmSync(root, { recursive: true, force: true })
  }
})

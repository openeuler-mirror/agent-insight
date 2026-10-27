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
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { loadProjectConfig } from '../../packages/project-config/index.cjs'
import { prepareZsoftSource } from '../../benchmarks/zsoft-l1/dataset/prepare'

const require = createRequire(import.meta.url)
const { EvaluatorAssets } = require('../../services/evaluator/src/evaluator-assets.cjs')
const { runOciEntrypoint } = require('../../services/evaluator/src/evaluator-registry.cjs')

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zsoft-config-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

function environment(t: TestContext, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
}

test('ZSoft legacy variables only warn once and cannot override YAML', async t => {
  const root = await fixture(t)
  const warnings: string[] = []
  const env = { NODE_ENV: 'test' as const, ZSOFT_DATASET_SOURCE: '/ignored-secret', ZSOFT_DATASET_REVISION: 'invalid', ZSOFT_L1_ASSETS_DIR: '/ignored-secret', ZSOFT_KERNEL_ACCEL: 'invalid' }
  const options = { configDir: root, env, warn: (message: string) => { warnings.push(message) } }
  for (let iteration = 0; iteration < 2; iteration++) {
    assert.deepEqual(loadProjectConfig('platform', options).benchmarks['zsoft-l1'].dataset, { autoImport: true, source: null, revision: null })
    assert.deepEqual(loadProjectConfig('evaluator', options).benchmarks['zsoft-l1'], { assetsDir: null, kernelAccel: 'tcg' })
  }
  assert.equal(warnings.length, 4)
  for (const field of ['dataset.source', 'dataset.revision', 'assetsDir', 'kernelAccel']) assert.ok(warnings.some(message => message.includes(`benchmarks.zsoft-l1.${field}`)))
  assert.ok(warnings.every(message => message.includes('不再生效') && !message.includes('ignored-secret')))
})

test('ZSoft YAML merges overrides, resolves paths, resets with null, and rejects invalid settings', async t => {
  const root = await fixture(t)
  const options = { configDir: root, env: { NODE_ENV: 'test' as const } }
  await fs.writeFile(path.join(root, 'platform.yaml'), JSON.stringify({ benchmarks: { 'zsoft-l1': { dataset: { source: 'https://git.example.test/official.git', revision: 'a'.repeat(40) } } } }))
  await fs.writeFile(path.join(root, 'platform.local.yaml'), JSON.stringify({ benchmarks: { 'zsoft-l1': { dataset: { autoImport: false, source: '../official', revision: null } } } }))
  assert.deepEqual(loadProjectConfig('platform', options).benchmarks['zsoft-l1'].dataset, { autoImport: false, source: path.resolve(root, '../official'), revision: null })
  await fs.writeFile(path.join(root, 'evaluator.local.yaml'), JSON.stringify({ benchmarks: { 'zsoft-l1': { assetsDir: './assets', kernelAccel: 'kvm' } } }))
  const config = loadProjectConfig('evaluator', options)
  assert.deepEqual(config.benchmarks['zsoft-l1'], { assetsDir: path.join(root, 'assets'), kernelAccel: 'kvm' })
  const snapshot = loadProjectConfig('evaluator', { env: { NODE_ENV: 'test', AGENT_INSIGHT_EVALUATOR_CONFIG_JSON: JSON.stringify(config), ZSOFT_KERNEL_ACCEL: 'tcg' } })
  assert.deepEqual(snapshot, config)
  for (const [scope, settings, field] of [
    ['platform', { dataset: { autoImport: 'false' } }, 'dataset.autoImport'],
    ['platform', { dataset: { autoImport: null } }, 'dataset.autoImport'],
    ['platform', { dataset: { source: '' } }, 'dataset.source'],
    ['platform', { dataset: { revision: 'master' } }, 'dataset.revision'],
    ['evaluator', { kernelAccel: 'auto' }, 'kernelAccel'],
    ['evaluator', { kernelAccel: null }, 'kernelAccel'],
    ['evaluator', { assetsDir: 'http://not-a-directory' }, 'assetsDir'],
    ['evaluator', { assetsDir: 123 }, 'assetsDir'],
  ] as const) {
    await fs.writeFile(path.join(root, `${scope}.local.yaml`), JSON.stringify({ benchmarks: { 'zsoft-l1': settings } }))
    assert.throws(() => loadProjectConfig(scope as 'platform', options), error => String(error).includes(`${scope}.local.yaml: benchmarks.zsoft-l1.${field}`))
  }
  await fs.writeFile(path.join(root, 'evaluator.local.yaml'), JSON.stringify({ benchmarks: { 'zsoft-l1': { assetsDir: null } } }))
  assert.deepEqual(loadProjectConfig('evaluator', options).benchmarks['zsoft-l1'], { assetsDir: null, kernelAccel: 'tcg' })
})

test('ZSoft preparation reads offline YAML sources and ignores stale dataset variables', async t => {
  const root = await fixture(t)
  const configDir = path.join(root, 'config')
  const official = path.join(root, 'official')
  await fs.mkdir(configDir)
  await fs.mkdir(path.join(official, 'tasks'), { recursive: true })
  await fs.writeFile(path.join(configDir, 'platform.local.yaml'), 'benchmarks:\n  zsoft-l1:\n    dataset:\n      source: ../official\n')
  environment(t, { AGENT_INSIGHT_CONFIG_DIR: configDir, ZSOFT_DATASET_SOURCE: '/missing-old-source', ZSOFT_DATASET_REVISION: 'invalid' })
  assert.equal(await prepareZsoftSource(), official)
})

test('ZSoft assets use the configured shared base or managed default, never the old variable', async t => {
  const root = await fixture(t)
  const descriptor = { key: 'zsoft-l1', benchmarkKey: 'zsoft-l1', runtime: 'oci-container', assets: {
    image: `registry.example/assets@sha256:${'a'.repeat(64)}`, directoryEnv: 'ZSOFT_L1_ASSETS_DIR', sourcePath: '/release', releaseId: 'fixture', bundleDigest: `sha256:${'b'.repeat(64)}`, verifyCommand: 'python3', verifyEntrypoint: '/verify.py',
  } }
  for (const assetsDir of [path.join(root, 'custom'), null]) {
    const base = assetsDir || path.join(root, 'benchmark-assets', 'zsoft-l1')
    const runner = async (command: { entrypoint: string }, args: string[]) => {
      if (command.entrypoint === 'python3') assert.equal(await fs.readFile(path.join(args[1], 'asset'), 'utf8'), 'verified')
      if (args[0] === 'inspect') return { stdout: JSON.stringify([{ Mounts: [{ Type: 'volume', Destination: root }] }]) }
      if (args[0] === 'cp') await fs.writeFile(path.join(args[2], 'asset'), 'verified')
      return { stdout: '' }
    }
    const manager = new EvaluatorAssets(descriptor, runner, { dataDir: root, environment: {
      HOSTNAME: 'controller', ZSOFT_L1_ASSETS_DIR: '/ignored-old-directory', AGENT_INSIGHT_EVALUATOR_CONFIG_JSON: JSON.stringify({ benchmarks: { 'zsoft-l1': { assetsDir } } }),
    } })
    t.after(() => manager.close())
    assert.equal(await manager.ensure(), path.join(base, 'a'.repeat(64)))
  }
})

test('Controller passes the YAML snapshot and resolved release directory to the ZSoft Python runtime', async t => {
  const root = await fixture(t)
  const bin = path.join(root, 'bin')
  const release = path.join(root, 'assets', 'release')
  await fs.mkdir(bin)
  await fs.mkdir(release, { recursive: true })
  await fs.writeFile(path.join(root, 'evaluator.local.yaml'), JSON.stringify({ benchmarks: { 'zsoft-l1': { assetsDir: './assets', kernelAccel: 'kvm' } } }))
  const snapshot = JSON.stringify(loadProjectConfig('evaluator', { configDir: root, env: { NODE_ENV: 'test' } }))
  const digest = `sha256:${'d'.repeat(64)}`
  await fs.writeFile(path.join(bin, 'docker'), `#!${process.execPath}\nconst args = process.argv.slice(2); process.stdout.write(args[0] === 'image' ? ${JSON.stringify(digest)} : JSON.stringify(args));\n`, { mode: 0o700 })
  environment(t, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, AGENT_INSIGHT_EVALUATOR_CONFIG_JSON: snapshot, EVALUATOR_CONTROLLER_CONTAINER_ID: 'synthetic-controller', ZSOFT_KERNEL_ACCEL: 'tcg', EVALUATOR_RUNTIME_ENV_NAMES: 'ZSOFT_KERNEL_ACCEL' })
  const result = await runOciEntrypoint({ key: 'zsoft-l1', benchmarkKey: 'zsoft-l1', image: 'fixture:runtime', artifactDigest: digest, resources: { cpu: 4, memoryMiB: 8192 }, network: 'deny', command: 'python3', entrypoint: '/entrypoint.py' }, ['doctor'], { env: { EVALUATOR_ASSETS_DIR: release } })
  const args = JSON.parse(result.stdout) as string[]
  const runtimeEnv = Object.fromEntries(args.flatMap((value, index) => value === '--env' ? [args[index + 1]] : []).map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]))
  assert.equal(runtimeEnv.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON, snapshot)
  assert.equal(runtimeEnv.EVALUATOR_ASSETS_DIR, release)
  execFileSync('python3', ['-c', `
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / 'benchmarks/zsoft-l1/evaluator'))
import entrypoint
assert entrypoint.kernel_acceleration() == 'kvm'
assert str(entrypoint.asset_root()) == os.environ['EVALUATOR_ASSETS_DIR']
`], { env: { ...process.env, ...runtimeEnv, PYTHONDONTWRITEBYTECODE: '1' } })
  environment(t, { EVALUATOR_ASSETS_DIR: undefined, ZSOFT_L1_ASSETS_DIR: release })
  assert.throws(() => require('../../benchmarks/zsoft-l1/evaluator/images.cjs').describeImages({}, 'amd64'), /ZSOFT_ASSET_ROOT_MISSING/)
})

test('standalone ZSoft validation translates YAML acceleration into the native framework environment', async t => {
  const root = await fixture(t)
  execFileSync('python3', ['-c', `
import importlib.util, json, sys
from pathlib import Path
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('zsoft_validate', 'scripts/benchmark/zsoft-validate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
mode = module.configured_kernel_acceleration()
assert mode == 'kvm'
root = Path(sys.argv[1])
args = SimpleNamespace(binary=sys.executable, bench_root=root, kernel_accel=mode)
result = module.cli(args, root, 'synthetic', ['-c', 'import os; print(os.environ["ZSOFT_KERNEL_ACCEL"])'], 10)
assert result['exit_code'] == 0
assert Path(result['stdout']).read_text().strip() == 'kvm'
`, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AGENT_INSIGHT_EVALUATOR_CONFIG_JSON: JSON.stringify({ benchmarks: { 'zsoft-l1': { kernelAccel: 'kvm' } } }), ZSOFT_KERNEL_ACCEL: 'tcg' } })
})

test('ZSoft Catalog no longer declares the migrated asset environment variable', () => {
  const { generatedEvaluatorDescriptors } = require('../../generated/benchmark-catalog/evaluators.cjs')
  const descriptor = generatedEvaluatorDescriptors.find((item: { benchmarkKey: string }) => item.benchmarkKey === 'zsoft-l1')
  assert.ok(descriptor.assets)
  assert.equal(Object.hasOwn(descriptor.assets, 'directoryEnv'), false)
})

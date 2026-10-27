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
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { loadProjectConfig, parseEvaluatorEnv, legacySettings } = require('../packages/project-config/index.cjs')
const root = path.resolve(__dirname, '..')
const script = path.join(root, 'scripts/evaluator.sh')

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluator-env-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const configDir = path.join(directory, 'config')
  fs.mkdirSync(configDir)
  fs.writeFileSync(path.join(configDir, 'evaluator.yaml'), 'maxConcurrency: 2\n')
  const local = path.join(configDir, 'evaluator.local.yaml')
  const localText = 'maxConcurrency: 3\nimagePool:\n  reserveRatio: 0.4\n'
  fs.writeFileSync(local, localText)
  return { directory, configDir, local, localText }
}

test('all migrated evaluator variables have typed explicit overrides and preserve generic Runtime env', t => {
  const f = fixture(t)
  const values = {
    EVALUATOR_MAX_CONCURRENCY: '4', ZSOFT_L1_ASSETS_DIR: '/shared/assets', ZSOFT_KERNEL_ACCEL: 'kvm',
    SWE_BENCH_PYTHON: '/opt/python', SWE_BENCH_IMAGE_SOURCE: 'epoch', SWE_BENCH_IMAGE_ARCH: 'arm64',
    SWE_BENCH_ALLOW_NON_OFFICIAL: 'true', SWE_BENCH_IMAGE_PROXY_PREFIX: 'proxy.example.test',
    SWE_BENCH_VERIFIED_MIRROR_REPOS: 'swr.example.test/a,swr.example.test/b',
    SWEBENCH_DOCKER_TIMEOUT: '900', SWEBENCH_DOCKER_POOL_SIZE: '8',
    IMAGE_POOL_ENABLED: 'true', IMAGE_POOL_PREFETCH_ENABLED: 'true', IMAGE_POOL_RESERVE_RATIO: '0.25',
    IMAGE_POOL_HIGH_WATERMARK: '0.85', IMAGE_POOL_MAX_PULLS: '3', IMAGE_POOL_WAIT_SECONDS: '120', IMAGE_POOL_MAC_DISK_PATH: '../probe',
  }
  assert.deepEqual(Object.keys(values).sort(), Object.keys(legacySettings.evaluator).sort())
  const parsed = parseEvaluatorEnv([...Object.entries(values).map(([key, value]) => `${key}=${value}`), 'CUSTOM_RUNTIME_TOKEN=private-token=with-equals'])
  assert.deepEqual(parsed.passthrough, ['CUSTOM_RUNTIME_TOKEN=private-token=with-equals'])
  const config = loadProjectConfig('evaluator', { configDir: f.configDir, pathBaseDir: '/host/config', env: {}, deploymentOverrides: parsed.overrides })
  assert.equal(config.maxConcurrency, 4)
  assert.deepEqual(config.benchmarks['swe-bench'], { python: '/opt/python', images: {
    source: 'epoch', arch: 'arm64', allowNonOfficial: true, proxyPrefix: 'proxy.example.test', verifiedMirrorRepositories: ['swr.example.test/a', 'swr.example.test/b'],
  }, docker: { requestTimeoutSeconds: 900, connectionPoolSize: 8 } })
  assert.deepEqual(config.benchmarks['zsoft-l1'], { assetsDir: '/shared/assets', kernelAccel: 'kvm' })
  assert.deepEqual(config.imagePool, { enabled: true, prefetchEnabled: true, reserveRatio: 0.25, highWatermark: 0.85, maxPulls: 3, waitSeconds: 120, macDiskPath: '/host/probe' })
  assert.equal(fs.readFileSync(f.local, 'utf8'), f.localText)
})

test('explicit overrides win over YAML and last duplicate wins without reviving ambient legacy env', t => {
  const f = fixture(t)
  const { overrides } = parseEvaluatorEnv(['EVALUATOR_MAX_CONCURRENCY=2', 'EVALUATOR_MAX_CONCURRENCY=4'])
  const warnings: string[] = []
  const options = { configDir: f.configDir, env: { EVALUATOR_MAX_CONCURRENCY: '19' }, warn: (message: string) => warnings.push(message) }
  assert.equal(loadProjectConfig('evaluator', options).maxConcurrency, 3)
  assert.equal(loadProjectConfig('evaluator', { ...options, deploymentOverrides: overrides }).maxConcurrency, 4)
  assert.ok(warnings.every(message => !message.includes('19')))
})

test('lists, nullable paths and boolean aliases parse without shell evaluation', () => {
  assert.deepEqual(parseEvaluatorEnv(['SWE_BENCH_VERIFIED_MIRROR_REPOS=']).overrides.benchmarks['swe-bench'].images.verifiedMirrorRepositories, [])
  assert.deepEqual(parseEvaluatorEnv(['SWE_BENCH_VERIFIED_MIRROR_REPOS=["swr.example.test/a"]']).overrides.benchmarks['swe-bench'].images.verifiedMirrorRepositories, ['swr.example.test/a'])
  assert.equal(parseEvaluatorEnv(['SWE_BENCH_VERIFIED_MIRROR_REPOS=null']).overrides.benchmarks['swe-bench'].images.verifiedMirrorRepositories, null)
  assert.equal(parseEvaluatorEnv(['IMAGE_POOL_ENABLED=0']).overrides.imagePool.enabled, false)
  assert.equal(parseEvaluatorEnv(['IMAGE_POOL_PREFETCH_ENABLED=TRUE']).overrides.imagePool.prefetchEnabled, true)
  assert.equal(parseEvaluatorEnv(['ZSOFT_L1_ASSETS_DIR=']).overrides.benchmarks['zsoft-l1'].assetsDir, null)
  assert.deepEqual(parseEvaluatorEnv(['MODEL_TOKEN=$(do-not-execute)=literal']).passthrough, ['MODEL_TOKEN=$(do-not-execute)=literal'])
})

test('invalid, unknown or multiline business settings fail without echoing values', () => {
  for (const assignment of ['EVALUATOR_MAX_CONCURRENCY=0', 'EVALUATOR_MAX_CONCURRENCY=4private-secret', 'IMAGE_POOL_PREFETCH_ENABLED=private-secret', 'IMAGE_POOL_RESERVE_RATIO=1', 'IMAGE_POOL_MAX_PULLS=9', 'SWE_BENCH_VERIFIED_MIRROR_REPOS=[private-secret]', 'SWE_BENCH_NOT_A_SETTING=private-secret', 'SWEBENCH_NOT_A_SETTING=private-secret', 'IMAGE_POOL_NOT_A_SETTING=private-secret', 'MODEL_TOKEN=private-secret\nOTHER=value']) {
    assert.throws(() => parseEvaluatorEnv([assignment]), (cause: any) => !cause.message.includes('private-secret'))
  }
})

test('final merged configuration still enforces cross-field constraints', t => {
  const f = fixture(t)
  const load = (assignments: string[]) => loadProjectConfig('evaluator', { configDir: f.configDir, env: {}, deploymentOverrides: parseEvaluatorEnv(assignments).overrides })
  assert.throws(() => load(['IMAGE_POOL_MAX_PULLS=1']), /maxPulls/)
  assert.equal(load(['IMAGE_POOL_MAX_PULLS=1', 'IMAGE_POOL_PREFETCH_ENABLED=false']).imagePool.maxPulls, 1)
  assert.throws(() => load(['SWE_BENCH_IMAGE_SOURCE=epoch']), /source=epoch/)
})

function shellFixture(t: TestContext) {
  const f = fixture(t)
  const docker = path.join(f.directory, 'docker')
  const dockerLog = path.join(f.directory, 'docker-args.json')
  fs.writeFileSync(docker, `#!${process.execPath}\nconst fs=require('node:fs');const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(dockerLog)},JSON.stringify(args));
const start=args.indexOf('/app/packages/project-config/index.cjs');
if(start<0||!args.includes('--interactive')||!args.includes('none')||!args.includes('--read-only'))process.exit(91);
const command=args.slice(start+1);command[1]=${JSON.stringify(f.configDir)};
const result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(root, 'packages/project-config/index.cjs'))},...command],{input:fs.readFileSync(0),encoding:'utf8',env:process.env});
process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??92);\n`, { mode: 0o755 })
  const source = fs.readFileSync(script, 'utf8')
  const head = source.slice(0, source.indexOf('for command_name in git docker df'))
  const stageStart = source.indexOf('PROJECT_CONFIG_DIR=')
  const stageEnd = source.indexOf('\nevaluator_image_pool_mounts\n', stageStart)
  assert.ok(stageStart > 0 && stageEnd > stageStart)
  const stage = source.slice(stageStart, stageEnd)
  const env = { ...process.env, PATH: `${f.directory}:${process.env.PATH}`, AGENT_INSIGHT_HOME: f.directory,
    AGENT_INSIGHT_EVALUATOR_HOME: path.join(f.directory, 'home'), AGENT_INSIGHT_CONFIG_DIR: f.configDir }
  for (const key of ['PORT', 'AGENT_INSIGHT_PORT', 'AGENT_INSIGHT_EVALUATOR_PORT', 'EVALUATOR_MAX_CONCURRENCY']) delete (env as Record<string, unknown>)[key]
  const run = (assignments: string[]) => spawnSync('bash', ['-c', `${head}\nIMAGE_ID=fixture\n${stage}\nprintf 'SNAPSHOT=%s\\n' "$PROJECT_CONFIG_JSON"\nprintf 'POOL_ENABLED=%s\\n' "$POOL_ENABLED"\nif [ "\${#EVALUATOR_ENV[@]}" -gt 0 ]; then printf 'ENV=%s\\n' "\${EVALUATOR_ENV[@]}"; fi`, script,
    'start', '--platform-base-url', 'http://host.docker.internal:3000', ...assignments.flatMap(value => ['--evaluator-env', value])], { env, encoding: 'utf8' })
  return { ...f, run, dockerLog }
}

test('the unchanged start command feeds CLI overrides through stdin into the shared snapshot', t => {
  const f = shellFixture(t)
  const result = f.run(['EVALUATOR_MAX_CONCURRENCY=4', 'CUSTOM_RUNTIME_TOKEN=private-token=literal'])
  assert.equal(result.status, 0, result.stderr)
  const snapshot = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('SNAPSHOT='))!.slice('SNAPSHOT='.length))
  assert.equal(snapshot.maxConcurrency, 4)
  assert.match(result.stderr, /maxConcurrency=4/)
  assert.equal(result.stderr.includes('private-token'), false)
  assert.equal(result.stderr.includes('EVALUATOR_MAX_CONCURRENCY 已迁移'), false)
  assert.match(result.stdout, /ENV=CUSTOM_RUNTIME_TOKEN=private-token=literal/)
  assert.doesNotMatch(result.stdout, /ENV=EVALUATOR_MAX_CONCURRENCY/)
  const args = fs.readFileSync(f.dockerLog, 'utf8')
  assert.equal(args.includes('private-token'), false)
  assert.equal(args.includes('EVALUATOR_MAX_CONCURRENCY=4'), false)
  assert.equal(fs.readFileSync(f.local, 'utf8'), f.localText)
  assert.equal(loadProjectConfig('evaluator', { env: { AGENT_INSIGHT_EVALUATOR_CONFIG_JSON: JSON.stringify(snapshot) } }).maxConcurrency, 4)
})

test('start without overrides preserves YAML; pool overrides reach mount preparation', t => {
  const f = shellFixture(t)
  const plain = f.run([])
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /"maxConcurrency":3/)
  const disabled = f.run(['IMAGE_POOL_ENABLED=false', 'IMAGE_POOL_PREFETCH_ENABLED=false'])
  assert.equal(disabled.status, 0, disabled.stderr)
  assert.match(disabled.stdout, /POOL_ENABLED=false/)
  assert.doesNotMatch(disabled.stdout, /ENV=IMAGE_POOL_/)
})

test('Controller health consumes the exact snapshot produced by the unchanged command', async t => {
  const f = shellFixture(t)
  const result = f.run(['EVALUATOR_MAX_CONCURRENCY=4'])
  assert.equal(result.status, 0, result.stderr)
  const snapshot = result.stdout.split('\n').find(line => line.startsWith('SNAPSHOT='))!.slice('SNAPSHOT='.length)
  const previous = process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON
  process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON = snapshot
  t.after(() => { if (previous === undefined) delete process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON; else process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON = previous })
  const { BenchmarkEvaluatorService } = require('../services/evaluator/src/service.cjs')
  const service = new BenchmarkEvaluatorService({ dataDir: f.directory, registry: { values: () => [] },
    controllerProbe: async () => ({}), imagePoolConfig: { enabled: false } })
  const report = await service.healthReport()
  assert.equal(report.maxConcurrency, 4)
  assert.equal(report.activeCount, 0)
  assert.equal(report.status, 'healthy')
})

test('invalid overrides stop startup before service replacement; protected overrides stay forbidden', t => {
  const f = shellFixture(t)
  for (const assignment of ['EVALUATOR_MAX_CONCURRENCY=0', 'IMAGE_POOL_MAX_PULLS=1', 'SWE_BENCH_UNKNOWN=private-value', 'AGENT_INSIGHT_EVALUATOR_CONFIG_JSON=private-value', 'EVALUATOR_RUNTIME_ENV_NAMES=private-value', 'IMAGE_POOL_DISK_PATH=private-value', 'EVALUATOR_PORT=4000', 'MODEL_TOKEN=private-value\nOTHER=value']) {
    const result = f.run([assignment])
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /SNAPSHOT=/)
    assert.equal(result.stderr.includes('private-value'), false)
  }
})

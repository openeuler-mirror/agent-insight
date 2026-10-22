import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createRequire } from 'node:module'
import { loadProjectConfig } from '../packages/project-config/index.cjs'
const require = createRequire(import.meta.url)

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-config-'))
  const configDir = path.join(root, 'config', 'benchmark')
  fs.mkdirSync(configDir, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(configDir, name), typeof value === 'string' ? value : JSON.stringify(value))
  return { root, configDir, write, options: { configDir, env: {} } }
}

test('defaults, scoped files and local overrides need no version field', (t) => {
  const f = fixture(t)
  f.write('platform.yaml', 'benchmarks:\n  scheduling:\n    maxPendingEvaluations: 50\n')
  f.write('platform.local.yaml', { benchmarks: { 'swe-bench': { dataset: { autoImport: false } } } })
  f.write('evaluator.yaml', { maxConcurrency: 3 })
  const platform = loadProjectConfig('platform', f.options)
  assert.equal(platform.benchmarks.scheduling.maxPendingEvaluations, 50)
  assert.equal(platform.benchmarks.scheduling.maxPendingEvaluationsPerUser, 128)
  assert.equal(platform.benchmarks['swe-bench'].dataset.autoImport, false)
  assert.deepEqual(loadProjectConfig('platform', { root: f.root, env: {} }), platform)
  assert.equal(loadProjectConfig('evaluator', { root: f.root, env: {} }).maxConcurrency, 3)
  assert.equal(loadProjectConfig('evaluator', f.options).maxConcurrency, 3)
  assert.equal(loadProjectConfig('executor', f.options).benchmarks['swe-bench'].gitSource, null)
  f.write('platform.local.yaml', { version: 1 })
  assert.throws(() => loadProjectConfig('platform', f.options), /platform.local.yaml.*未知配置字段 version/)
})

test('configuration resolves paths by the declaring file and distinguishes null from empty lists', (t) => {
  const f = fixture(t)
  f.write('platform.local.yaml', { benchmarks: { 'swe-bench': { dataset: { source: '../datasets/test.parquet' }, loader: { sourceArchive: 'https://mirror.example/archive.tar.gz', python: '~/python/bin/python' } } } })
  const platform = loadProjectConfig('platform', f.options).benchmarks['swe-bench']
  assert.equal(platform.dataset.source, path.join(f.root, 'config/datasets/test.parquet'))
  assert.equal(platform.loader.sourceArchive, 'https://mirror.example/archive.tar.gz')
  assert.equal(platform.loader.python, path.join(os.homedir(), 'python/bin/python'))
  f.write('evaluator.yaml', { benchmarks: { 'swe-bench': { images: { verifiedMirrorRepositories: ['registry.example/swe'] } } } })
  f.write('evaluator.local.yaml', { benchmarks: { 'swe-bench': { images: { verifiedMirrorRepositories: [] } } } })
  assert.deepEqual(loadProjectConfig('evaluator', f.options).benchmarks['swe-bench'].images.verifiedMirrorRepositories, [])
  f.write('evaluator.local.yaml', { benchmarks: { 'swe-bench': { images: { verifiedMirrorRepositories: null } } } })
  assert.equal(loadProjectConfig('evaluator', f.options).benchmarks['swe-bench'].images.verifiedMirrorRepositories, null)
})

test('unknown keys, wrong types, duplicate YAML keys and cross-field errors identify the configuration', (t) => {
  const f = fixture(t)
  for (const [value, expected] of [
    [{ maxConcurrency: '2' }, /maxConcurrency/],
    [{ imagePool: { enabled: 'false' } }, /imagePool.enabled/],
    [{ imagePool: { maxPulls: 1 } }, /imagePool.maxPulls/],
    [{ benchmarks: { 'swe-bench': { images: { source: 'epoch' } } } }, /source=epoch/],
    ['maxConcurrency: 2\nmaxConcurrency: 3', /duplicated mapping key/],
    ['maxConcurrency: [', /evaluator.local.yaml/],
  ] as const) {
    f.write('evaluator.local.yaml', value)
    assert.throws(() => loadProjectConfig('evaluator', f.options), expected)
  }
  f.write('executor.yaml', { benchmarks: { 'swe-bench': { gitSource: 'http://user:secret@mirror.example' } } })
  assert.throws(() => loadProjectConfig('executor', f.options), /gitSource.*凭证/)
})

test('legacy business variables warn once and do not override file settings', (t) => {
  const f = fixture(t)
  f.write('platform.yaml', { benchmarks: { 'swe-bench': { dataset: { autoImport: false } } } })
  const warnings: string[] = []
  const options = { ...f.options, env: { SWE_BENCH_DATASET_SOURCE: '/ignored', AGENT_INSIGHT_BENCHMARK: 'swe-bench' }, warn: (message: string) => warnings.push(message) }
  const result = loadProjectConfig('platform', options)
  assert.equal(result.benchmarks['swe-bench'].dataset.autoImport, false)
  assert.equal(result.benchmarks['swe-bench'].dataset.source, null)
  assert.equal(warnings.length, 2)
  loadProjectConfig('platform', options)
  assert.equal(warnings.length, 2)
})

test('Evaluator deployment produces a validated snapshot with host paths and no external Node modules', (t) => {
  const f = fixture(t)
  const runtime = path.join(f.root, 'packages', 'project-config')
  fs.cpSync(path.resolve('packages/project-config'), runtime, { recursive: true })
  f.write('evaluator.local.yaml', { maxConcurrency: 4, imagePool: { macDiskPath: '../probe' }, benchmarks: { 'swe-bench': { docker: { requestTimeoutSeconds: 99 } } } })
  const cli = spawnSync(process.execPath, [path.join(runtime, 'index.cjs'), 'evaluator', f.configDir, '/host/project/config/benchmark', '--deployment'], { encoding: 'utf8', env: { NODE_ENV: 'test' } })
  assert.equal(cli.status, 0, cli.stderr)
  const lines = cli.stdout.trim().split('\n')
  assert.equal(lines[1], 'true')
  assert.equal(lines[2], '/host/project/config/probe')
  const snapshot = loadProjectConfig('evaluator', { configDir: '/missing', env: { AGENT_INSIGHT_EVALUATOR_CONFIG_JSON: lines[0] } })
  assert.equal(snapshot.maxConcurrency, 4)
  assert.equal(snapshot.benchmarks['swe-bench'].docker.requestTimeoutSeconds, 99)
  assert.equal(snapshot.imagePool.macDiskPath, '/host/project/config/probe')
})

test('disabled or invalid auto-import configuration never starts the importer or prevents startup', (t) => {
  const f = fixture(t)
  const env = { ...process.env, AGENT_INSIGHT_CONFIG_DIR: f.configDir, AGENT_INSIGHT_HOME: f.root }
  for (const [value, warning] of [
    [{ benchmarks: { 'swe-bench': { dataset: { autoImport: false } } } }, false],
    [{ benchmarks: { 'swe-bench': { dataset: { autoImport: 'invalid' } } } }, true],
  ] as const) {
    f.write('platform.local.yaml', value)
    const result = spawnSync(process.execPath, ['scripts/benchmark/bootstrap-swe-bench-dataset.cjs'], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    if (warning) {
      assert.match(result.stderr, /autoImport.*类型或取值不合法/)
      assert.match(result.stderr, /将继续启动服务/)
    } else assert.match(result.stdout, /自动导入已关闭/)
    assert.equal(fs.existsSync(path.join(f.root, 'logs')), false)
  }
})

test('installed client loads user configuration outside runtime and retains overrides on reinstall', (t) => {
  const f = fixture(t)
  const clientHome = path.join(f.root, 'home')
  const code = `
    const fs = require('node:fs');
    const path = require('node:path');
    const installer = require('./scripts/install-ras-client.js');
    installer.installRuntime();
    const assert = require('node:assert/strict');
    const local = path.join(process.env.AGENT_INSIGHT_HOME, 'config/executor.local.yaml');
    assert.equal(fs.existsSync(path.dirname(local)), true);
    assert.equal(fs.existsSync(local), false);
    fs.writeFileSync(local, JSON.stringify({
      benchmarks:{'swe-bench':{gitSource:'../git-cache'}},
      execution:{profiles:{'xgovernor-local-docker':{resources:{cpu:4,memoryMiB:8192}}}},
      runtimes:{mcts:{defaults:{maxIters:7}}}
    }));
    const text = fs.readFileSync(local, 'utf8');
    installer.installRuntime();
    assert.equal(fs.readFileSync(local, 'utf8'), text);
    const {loadProjectConfig} = require(path.join(installer.RUNTIME_DIR, 'packages/project-config/index.cjs'));
    const config = loadProjectConfig('executor');
    assert.equal(config.execution.profiles['xgovernor-local-docker'].resources.cpu, 4);
    assert.equal(config.execution.profiles['xgovernor-local-docker'].resources.memoryMiB, 8192);
    assert.equal(config.execution.profiles['xgovernor-local-docker'].resources.pids, 512);
    assert.equal(config.benchmarks['swe-bench'].images.source, 'official');
    const runtimeOptions = require(path.join(installer.RUNTIME_DIR, 'executor/runtime-options.cjs'));
    assert.equal(runtimeOptions.runtimeInvocationOptions('pi-mcts', 'pi-mcts').agentOptions.values.maxIters, 7);
    const {SweBenchGitSourcePolicy} = require(path.join(installer.RUNTIME_DIR, 'executor/benchmarks/swe-bench.cjs'));
    const policy = new SweBenchGitSourcePolicy({home:process.env.AGENT_INSIGHT_HOME});
    const result = policy.resolve({repository:'https://github.com/pallets/flask.git'});
    assert.equal(result.cachePath, path.join(process.env.AGENT_INSIGHT_HOME, 'git-cache/pallets/flask.git'));
  `
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_INSIGHT_HOME: clientHome }
  delete env.AGENT_INSIGHT_CONFIG_DIR
  delete env.AGENT_INSIGHT_PACKAGE_ROOT
  const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env })
  assert.equal(child.status, 0, child.stderr)
  assert.ok(fs.existsSync(path.join(clientHome, 'config/executor.local.yaml')))
  assert.match(child.stdout, /用户配置（可选）：/)
})

test('custom configuration directory directly contains scoped files without an extra benchmark suffix', (t) => {
  const f = fixture(t)
  const customDir = path.join(f.root, 'deployment-config')
  fs.mkdirSync(customDir)
  fs.writeFileSync(path.join(customDir, 'platform.yaml'), 'benchmarks:\n  swe-bench:\n    dataset:\n      autoImport: false\n')
  const config = loadProjectConfig('platform', { root: f.root, env: { AGENT_INSIGHT_CONFIG_DIR: customDir } })
  assert.equal(config.benchmarks['swe-bench'].dataset.autoImport, false)
})

test('installed client ignores both old local paths without migration or fallback', (t) => {
  const f = fixture(t)
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_INSIGHT_HOME: path.join(f.root, 'home') }
  delete env.AGENT_INSIGHT_CONFIG_DIR
  delete env.AGENT_INSIGHT_PACKAGE_ROOT
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const assert = require('node:assert/strict');
    const installer = require('./scripts/install-ras-client.js');
    const legacyDir = path.join(installer.RUNTIME_DIR, 'config');
    fs.mkdirSync(legacyDir, {recursive:true});
    const legacyLocal = path.join(legacyDir, 'executor.local.yaml');
    const legacyText = 'benchmarks:\\n  swe-bench:\\n    gitSource: ../git-cache\\n';
    fs.writeFileSync(legacyLocal, legacyText);
    const oldBenchmarkLocal = path.join(legacyDir, 'benchmark/executor.local.yaml');
    fs.mkdirSync(path.dirname(oldBenchmarkLocal), {recursive:true});
    fs.writeFileSync(oldBenchmarkLocal, 'invalid: [');
    installer.installRuntime();
    assert.equal(fs.existsSync(path.join(installer.RUNTIME_DIR, 'executor/runtimes/mcts/runtime.yaml')), true);
    assert.equal(fs.existsSync(path.join(installer.RUNTIME_DIR, 'runtimes')), false);
    const {prepareExecutionImage} = require(path.join(installer.RUNTIME_DIR, 'executor/execution-images.cjs'));
    assert.equal(typeof prepareExecutionImage, 'function');
    assert.equal(typeof require(path.join(installer.RUNTIME_DIR, 'executor/benchmarks/swe-bench-images.cjs')).SweBenchImageResolver, 'function');
    const runtimeOptions = require(path.join(installer.RUNTIME_DIR, 'executor/runtime-options.cjs'));
    const invocation = runtimeOptions.runtimeInvocationOptions('pi-mcts', 'pi-mcts');
    assert.equal(invocation.agentOptions.runtimeKey, 'mcts');
    assert.equal(invocation.agentOptions.values.maxIters, 5);
    assert.deepEqual(invocation.args.slice(0, 4), ['--max-iters', '5', '--branching', '3']);
    assert.equal(invocation.definition.parameters.some(field => 'binding' in field), false);
    const {loadProjectConfig} = require(path.join(installer.RUNTIME_DIR, 'packages/project-config/index.cjs'));
    const options = {root:installer.RUNTIME_DIR};
    const local = path.join(process.env.AGENT_INSIGHT_HOME, 'config/executor.local.yaml');
    assert.equal(fs.existsSync(local), false);
    assert.equal(loadProjectConfig('executor', options).benchmarks['swe-bench'].gitSource, null);
    assert.equal(fs.readFileSync(legacyLocal,'utf8'),legacyText);
    assert.equal(fs.readFileSync(oldBenchmarkLocal,'utf8'), 'invalid: [');
    fs.writeFileSync(local,'benchmarks:\\n  swe-bench:\\n    gitSource: https://new.example/git\\n');
    installer.installRuntime();
    assert.equal(loadProjectConfig('executor', options).benchmarks['swe-bench'].gitSource,'https://new.example/git');
    assert.equal(fs.readFileSync(oldBenchmarkLocal,'utf8'), 'invalid: [');
    const customDir = path.join(process.env.AGENT_INSIGHT_HOME, 'custom-config');
    fs.mkdirSync(customDir);
    fs.writeFileSync(path.join(customDir,'executor.local.yaml'), 'benchmarks:\\n  swe-bench:\\n    gitSource: ../custom-cache\\n');
    const custom = loadProjectConfig('executor', {root:installer.RUNTIME_DIR, env:{...process.env,AGENT_INSIGHT_CONFIG_DIR:customDir}});
    assert.equal(custom.benchmarks['swe-bench'].gitSource, path.join(process.env.AGENT_INSIGHT_HOME, 'custom-cache'));
    fs.writeFileSync(local, 'invalid: [');
    assert.throws(() => loadProjectConfig('executor', options), /config[/\\\\]executor.local.yaml/);
  `], { env, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
})

test('Controller and SWE-bench Evaluator consume the same validated deployment snapshot', (t) => {
  const f = fixture(t)
  f.write('evaluator.local.yaml', { maxConcurrency: 3, benchmarks: { 'swe-bench': { python: '/opt/custom/bin/python', images: { verifiedMirrorRepositories: [] }, docker: { requestTimeoutSeconds: 90, connectionPoolSize: 4 } } } })
  const previous = process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON
  process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON = JSON.stringify(loadProjectConfig('evaluator', f.options))
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON
    else process.env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON = previous
  })
  const { BenchmarkEvaluatorService } = require('../services/evaluator/src/service.cjs')
  const { SweBenchEvaluator, verifiedImageMirrorRepositories } = require('../benchmarks/swe-bench/evaluator/index.cjs')
  const controller = new BenchmarkEvaluatorService({ dataDir: f.root, imagePoolConfig: { enabled: false } })
  const evaluator = new SweBenchEvaluator()
  assert.equal(controller.maxConcurrency, 3)
  assert.equal(evaluator.python, '/opt/custom/bin/python')
  assert.deepEqual(evaluator.config.docker, { requestTimeoutSeconds: 90, connectionPoolSize: 4 })
  assert.deepEqual(verifiedImageMirrorRepositories(), [])
})

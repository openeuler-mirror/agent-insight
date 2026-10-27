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
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { isolatedHomeEnv } from './helpers/isolated-home'

const require = createRequire(import.meta.url)
const { DependencyManager, command, probeServer } = require('../services/executor/src/xgovernor/dependency-manager.cjs')
const { readState, readRelease, resolveManagedProfile } = require('../services/executor/src/xgovernor/installation.cjs')
const { artifactIdentity } = require('../services/executor/src/xgovernor/artifact-identity.cjs')
const { normalizeExecutionConfig, describeProfile } = require('../packages/benchmark-protocol/execution.cjs')
const { executionCapabilities } = require('../services/executor/src/execution-config.cjs')
const target = { platform: 'linux', arch: 'x64' }
const xiaooModel = `pub(crate) async fn probe(llm: &PersistedLlm) -> Result<(), SessionDomainError> {
    let provider = provider(llm, Arc::new(Mutex::new(Default::default())))?;
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        provider.complete(&request),
    )
    .await
    .map_err(|_| invalid("model preflight timed out"))?
    .map(|_| ())
}
const OTHER_TIMEOUT: Duration = Duration::from_secs(10);
`

function write(file: string, content: string, executable = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, { mode: executable ? 0o755 : 0o644 })
}

const server = `#!${process.execPath}
const http = require('node:http'); const fs = require('node:fs');
const token = fs.readFileSync(process.env.XGOVERNOR_TENANTS_CONFIG_PATH, 'utf8').split('"')[1];
const port = Number(process.env.XGOVERNOR_BIND_ADDR.split(':').pop());
http.createServer((req, res) => {
 res.setHeader('content-type', 'application/json');
 if (req.url.endsWith('/health')) return res.end('{"status":"ok"}');
 if (req.headers.authorization !== 'Bearer ' + token) { res.statusCode = 401; return res.end('{}'); }
 if (req.method === 'GET' && req.url.endsWith('/sessions')) return res.end('{"sessions":[]}');
 res.statusCode = 422; res.end('{}');
}).listen(port, '127.0.0.1');
`

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-dependency-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const upstream = path.join(root, 'upstream')
  write(path.join(upstream, 'apps/server/src/main.rs'), 'XGOVERNOR_TENANT_BIND_ADDR --worker DockerProvider')
  write(path.join(upstream, 'apps/server/src/httpserver/session.rs'), '/sessions/open /sessions/exec /sessions/turns /sessions/close /sessions/cancel /turns/:turn_id/events')
  write(path.join(upstream, 'crates/protocol/runtime/src/worker.rs'), 'RuntimeStateSnapshot')
  write(path.join(upstream, 'apps/runtime-xiaoo/src/model.rs'), xiaooModel)
  write(path.join(upstream, 'Cargo.lock'), 'locked')
  write(path.join(upstream, 'apps/runtime-pi/extension/package-lock.json'), '{}')
  write(path.join(upstream, 'apps/runtime-pi/extension/package.json'), JSON.stringify({ version: '0.1.0', devDependencies: { '@earendil-works/pi-coding-agent': '0.84.2' }, pi: { extensions: ['./index.ts'] } }))
  write(path.join(upstream, 'apps/runtime-pi/extension/index.ts'), 'export {}')
  write(path.join(upstream, 'apps/runtime-pi/extension/probe.ts'), 'export {}')
  write(path.join(upstream, 'apps/runtime-pi/extension/model-config.ts'), 'export {}')
  await command('git', ['init', '--quiet'], { cwd: upstream })
  const commit = async (tag: string) => {
    write(path.join(upstream, 'version'), tag)
    await command('git', ['add', '.'], { cwd: upstream })
    await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--quiet', '-m', tag], { cwd: upstream })
    await command('git', ['tag', tag], { cwd: upstream })
    return command('git', ['rev-parse', 'HEAD'], { cwd: upstream })
  }
  const first = await commit('v1')
  let builds = 0
  let failBuild = false
  let failProbe = false
  const commands: Array<{ file: string; args: string[]; cwd: string; targetDirectory: string }> = []
  const manager = new DependencyManager({
    root: path.join(root, 'installed'), target, log() {},
    async buildNativeCredentials(source: string) {
      write(path.join(source, 'target/release/insight-xiaoo-credentials'), `#!${process.execPath}\n`, true)
      return { version: 1, source: 'fixture-native-source' }
    },
    async command(file: string, args: string[], options: any) {
      commands.push({ file, args, cwd: options.cwd, targetDirectory: options.env.CARGO_TARGET_DIR })
      if (file === 'git') {
        const actual = args[0] === 'remote' ? [...args.slice(0, -1), upstream] : args
        return command(file, actual, { ...options, verbose: false })
      }
      if (args[0] === '--version') return file === 'node' ? 'v24.13.0' : 'fixture'
      if (file === 'cargo') {
        builds++
        if (failBuild) throw new Error('fixture compile error')
        assert.equal(fs.readFileSync(path.join(options.cwd, 'apps/runtime-xiaoo/src/model.rs'), 'utf8'), xiaooModel.replace('from_secs(10)', 'from_secs(60)'))
        const version = fs.readFileSync(path.join(options.cwd, 'version'), 'utf8')
        write(path.join(options.cwd, 'target/release/xgovernor-server'), server + `\n// ${version}\n`, true)
        write(path.join(options.cwd, 'target/release/pi-worker'), `#!${process.execPath}\n// ${version}\n`, true)
        const probe = path.join(options.cwd, 'apps/runtime-pi/extension/probe.ts')
        write(path.join(options.cwd, 'target/release/check-pi-probe'), `#!${process.execPath}\nconst fs = require('node:fs'); const probe = ${JSON.stringify(probe)};\nif (!fs.existsSync(probe)) process.exit(1);\nconsole.log(probe);\n`, true)
      } else if (args[0] === 'ci') {
        write(path.join(options.cwd, 'node_modules/@earendil-works/pi-coding-agent/package.json'), '{"version":"0.84.2"}')
        write(path.join(options.cwd, 'node_modules/.bin/pi'), `#!${process.execPath}\n`, true)
      }
      return ''
    },
    async probe(directory: string, config: any) {
      if (failProbe) throw new Error('fixture protocol mismatch')
      await probeServer(directory, config)
    },
  })
  return { root, upstream, manager, first, commit, commands, get builds() { return builds }, set failBuild(value: boolean) { failBuild = value }, set failProbe(value: boolean) { failProbe = value } }
}

test('managed dependency installs official HEAD, keeps source/locked components, updates and rolls back atomically', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.manager.status(), { installed: false, root: f.manager.root })
  const initial = await f.manager.update()
  assert.equal(initial.revision, f.first)
  assert.equal(initial.requestedVersion, 'HEAD')
  assert.deepEqual(initial.components, { pi: '0.84.2', extension: '0.1.0', xiaooCredentials: { version: 1, source: 'fixture-native-source' } })
  const one = f.manager.status()
  assert.equal(one.installed, true)
  assert.ok(fs.existsSync(path.join(one.directory, 'source/.git')))
  assert.equal(f.commands.find(item => item.args[0] === 'fetch')?.args.at(-1), 'HEAD')
  assert.ok(f.commands.some(item => item.file === 'cargo' && item.args.includes('--locked')))
  assert.equal((await f.manager.update()).changed, false)
  assert.equal(f.builds, 1)

  const second = await f.commit('v2')
  assert.equal((await f.manager.update()).revision, second)
  const two = f.manager.status()
  assert.notEqual(one.artifactDigest, two.artifactDigest)
  assert.notEqual(one.directory, two.directory)
  assert.ok(fs.existsSync(one.directory), 'running Cases retain the old immutable component directory')
  const raw = normalizeExecutionConfig()
  const afterUpdate = executionCapabilities({ config: raw, installationRoot: f.manager.root, target, env: {}, os: 'linux', refresh: true }).profiles[0].profile
  assert.equal(afterUpdate.sourceRevision, second)
  const firstProfile = resolveManagedProfile(raw.profiles['xgovernor-local-docker'], { root: f.manager.root, target })
  assert.equal(firstProfile.config.managedRevision, second)
  assert.equal(firstProfile.config.runtimes.xiaoo.workerExecutable, firstProfile.config.serverExecutable)
  assert.equal(describeProfile('xgovernor-local-docker', firstProfile.config).sourceRevision, second)
  await f.manager.rollback()
  assert.equal(f.manager.status().revision, f.first)
  const afterRollback = executionCapabilities({ config: raw, installationRoot: f.manager.root, target, env: {}, os: 'linux' }).profiles[0].profile
  assert.equal(afterRollback.sourceRevision, f.first)
  assert.notEqual(afterRollback.definitionDigest, afterUpdate.definitionDigest)
  assert.equal((await f.manager.update('v1')).changed, false)
  assert.equal((await f.manager.update(second)).revision, second)
})

test('build, compatibility and download failures preserve the active pointer and release the update lock', async t => {
  const f = await fixture(t)
  await f.manager.update()
  const before = fs.readFileSync(path.join(f.manager.root, 'current.json'), 'utf8')
  await f.commit('v2')
  f.failBuild = true
  await assert.rejects(f.manager.update(), /compile error/)
  f.failBuild = false
  f.failProbe = true
  await assert.rejects(f.manager.update(), /protocol mismatch/)
  f.failProbe = false
  await assert.rejects(f.manager.update('missing-tag'), /git 执行失败/)
  assert.equal(fs.readFileSync(path.join(f.manager.root, 'current.json'), 'utf8'), before)
  assert.equal(fs.existsSync(path.join(f.manager.root, 'update.lock')), false)
  assert.equal(fs.readdirSync(path.join(f.manager.root, 'releases')).length, 1)
  assert.equal(fs.readdirSync(f.manager.root).some(file => file.startsWith('.staging-')), false)
  await assert.rejects(f.manager.rollback(), /没有可回退/)
  await assert.rejects(f.manager.update('--upload-pack=bad'), /tag 或 commit/)
  assert.equal(fs.readFileSync(path.join(f.manager.root, 'current.json'), 'utf8'), before)
})

test('build embeds the final Pi probe path, and activation never moves the compiled source', async t => {
  const f = await fixture(t)
  await f.manager.update()
  const installed = f.manager.status()
  const source = fs.realpathSync(path.join(installed.directory, 'source'))
  const builds = f.commands.filter(item => item.file === 'cargo' && item.args[0] === 'build')
  assert.equal(builds.length, 1)
  assert.equal(builds[0].cwd, source)
  assert.equal(builds[0].targetDirectory, path.join(source, 'target'))
  assert.equal(installed.build.layoutVersion, 1)
  assert.equal(installed.build.sourceDirectory, source)
  assert.equal(fs.readdirSync(f.manager.root).some(file => file.startsWith('.staging-')), false)
  const checked = spawnSync(path.join(source, 'target/release/check-pi-probe'), [], { encoding: 'utf8' })
  assert.equal(checked.status, 0, 'A compile-time extension path must still exist after activation')
  assert.equal(checked.stdout.trim(), path.join(source, 'apps/runtime-pi/extension/probe.ts'))
  await f.commit('v2')
  await f.manager.update()
  assert.equal(spawnSync(path.join(source, 'target/release/check-pi-probe')).status, 0, 'Updating does not move an older immutable release')
})

test('legacy layouts rebuild the same revision, preserve the old directory, and cannot be rolled back into service', async t => {
  const f = await fixture(t)
  await f.manager.update('v1')
  const old = f.manager.status()
  const file = path.join(old.directory, 'installation.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete manifest.build
  fs.writeFileSync(file, JSON.stringify(manifest))
  assert.throws(() => f.manager.status(), /重新执行客户端安装命令以重建/)
  const raw = normalizeExecutionConfig()
  const capabilities = executionCapabilities({ config: raw, installationRoot: f.manager.root, target, env: {}, os: 'linux', refresh: true })
  assert.equal(capabilities.profiles[0].ready, false)
  assert.match(capabilities.profiles[0].note, /重建/)
  const beforeRepair = fs.readFileSync(path.join(f.manager.root, 'current.json'), 'utf8')
  f.failBuild = true
  await assert.rejects(f.manager.update('v1'), /compile error/)
  f.failBuild = false
  assert.equal(fs.readFileSync(path.join(f.manager.root, 'current.json'), 'utf8'), beforeRepair)
  assert.equal(fs.readdirSync(path.join(f.manager.root, 'releases')).length, 1)
  assert.ok(fs.existsSync(path.join(old.directory, 'source/target/release/xgovernor-server')))
  const repaired = await f.manager.update('v1')
  assert.equal(repaired.changed, true)
  assert.equal(repaired.revision, old.revision)
  assert.equal(f.builds, 3)
  const active = f.manager.status()
  assert.notEqual(active.directory, old.directory)
  assert.ok(fs.existsSync(old.directory))
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(manifest))
  const pointer = fs.readFileSync(path.join(f.manager.root, 'current.json'), 'utf8')
  await assert.rejects(f.manager.rollback(), /重建/)
  assert.equal(fs.readFileSync(path.join(f.manager.root, 'current.json'), 'utf8'), pointer)
  assert.equal((await f.manager.update('v1')).changed, false)
})

test('relocated releases fail readiness validation instead of using stale compiled paths', async t => {
  const f = await fixture(t)
  await f.manager.update()
  const relocated = path.join(f.root, 'relocated')
  fs.renameSync(f.manager.root, relocated)
  const state = readState(relocated)
  assert.throws(() => readRelease(relocated, state.current, target), /目录已移动/)
})

test('model preflight timeout is compiled as 60 seconds; older builds rebuild and incompatible source never activates', async t => {
  const f = await fixture(t)
  await f.manager.update('v1')
  const old = f.manager.status()
  assert.equal(old.build.modelPreflightTimeoutSeconds, 60)
  const file = path.join(old.directory, 'installation.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete manifest.build.modelPreflightTimeoutSeconds
  fs.writeFileSync(file, JSON.stringify(manifest))
  assert.throws(() => f.manager.status(), /60 秒.*向导第二步.*重建 xGovernor.*重装客户端不会自动重建/)
  assert.equal((await f.manager.update('v1')).changed, true)
  assert.equal(f.manager.status().build.modelPreflightTimeoutSeconds, 60)
  assert.notEqual(f.manager.status().directory, old.directory)
  assert.ok(fs.existsSync(old.directory))
  assert.equal((await f.manager.update('v1')).changed, false)
  const pointer = fs.readFileSync(path.join(f.manager.root, 'current.json'), 'utf8')
  write(path.join(f.upstream, 'apps/runtime-xiaoo/src/model.rs'), xiaooModel.replace('from_secs(10)', 'from_secs(20)'))
  await f.commit('v2')
  await assert.rejects(f.manager.update('v2'), /模型预检源码布局不兼容/)
  assert.equal(fs.readFileSync(path.join(f.manager.root, 'current.json'), 'utf8'), pointer)
  write(path.join(f.upstream, 'apps/runtime-xiaoo/src/model.rs'), xiaooModel.replace('from_secs(10)', 'from_secs(60)'))
  await f.commit('v3')
  assert.equal((await f.manager.update('v3')).changed, true)
})

test('missing native credential bridge rebuilds the same upstream revision and bridge tampering invalidates its digest', async t => {
  const f = await fixture(t)
  await f.manager.update('v1')
  const before = f.manager.status()
  const file = path.join(before.directory, 'installation.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete manifest.components.xiaooCredentials
  fs.writeFileSync(file, JSON.stringify(manifest))
  assert.throws(() => f.manager.status(), /原生凭据桥接.*重新执行客户端安装/)
  assert.equal((await f.manager.update('v1')).changed, true)
  const current = f.manager.status()
  assert.notEqual(current.directory, before.directory)
  assert.equal(current.components.xiaooCredentials.version, 1)
  assert.ok(fs.existsSync(before.directory))
  fs.appendFileSync(path.join(current.directory, current.artifacts.xiaooCredentials), '\n// tamper')
  assert.throws(() => f.manager.status(), /摘要不一致/)
})

test('parallel updates are refused; corrupt bundles and architecture mismatches never become ready', async t => {
  const f = await fixture(t)
  await f.manager.update()
  const state = readState(f.manager.root)
  assert.throws(() => readRelease(f.manager.root, state.current, { platform: 'linux', arch: 'arm64' }), /架构/)
  write(path.join(f.manager.root, 'update.lock'), String(process.pid))
  await assert.rejects(f.manager.update(), /已有更新/)
  fs.rmSync(path.join(f.manager.root, 'update.lock'))
  const installed = readRelease(f.manager.root, state.current, target)
  fs.appendFileSync(installed.config.serverExecutable, '\n// tampered')
  assert.throws(() => f.manager.status(), /摘要不一致/)
  const raw = normalizeExecutionConfig()
  const result = executionCapabilities({ config: raw, installationRoot: f.manager.root, target, env: {}, os: 'linux', refresh: true })
  assert.equal(result.profiles[0].ready, false)
  assert.match(result.profiles[0].note, /安装不可用/)
  await f.manager.update()
  assert.equal(f.manager.status().revision, f.first)
})

test('manual installations keep their configured paths and file changes alter the public digest', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-manual-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const binary = path.join(root, 'server')
  write(binary, '#!/bin/sh\nexit 0\n', true)
  const raw = normalizeExecutionConfig({ profiles: { 'xgovernor-local-docker': {
    sourceRevision: 'a'.repeat(40), serverExecutable: binary,
    runtimes: { xiaoo: { kind: 'xiaoo', namespace: 'xiaoo', agents: ['defaultagent'], workerExecutable: binary } },
  } } })
  const local = raw.profiles['xgovernor-local-docker']
  assert.equal(resolveManagedProfile(local, { root: '/missing' }).config, local)
  const a = executionCapabilities({ config: raw, env: {}, os: 'linux', refresh: true }).profiles[0].profile
  fs.appendFileSync(binary, '# update\n')
  const b = executionCapabilities({ config: raw, env: {}, os: 'linux' }).profiles[0].profile
  assert.notEqual(a.definitionDigest, b.definitionDigest)
  assert.equal(b.sourceRevision, 'unknown', 'a declaration does not certify a manually replaced executable')
  assert.equal(JSON.stringify(b).includes(root), false)
  assert.deepEqual(artifactIdentity(local).reasons, [])
})

test('installed-client command works without a source checkout and rejects unsupported hosts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = isolatedHomeEnv(root)
  const runtime = path.join(env.AGENT_INSIGHT_HOME!, 'client/runtime')
  const install = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).installRuntime()', path.resolve('scripts/install-ras-client.js')], { cwd: os.tmpdir(), env, encoding: 'utf8' })
  assert.equal(install.status, 0, install.stderr)
  const invoke = (args: string[]) => spawnSync(process.execPath, [path.join(runtime, 'xgovernor.cjs'), ...args], { cwd: os.tmpdir(), env, encoding: 'utf8' })
  const status = invoke(['status'])
  assert.equal(status.status, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).installed, false)
  assert.equal(invoke(['--help']).status, 0)
  assert.equal(invoke(['status', '--version', 'v1']).status, 1)
  if (process.platform !== 'linux') assert.match(invoke(['update']).stderr, /仅支持 Linux/)
})

test('cancelled build commands exit without waiting for the build timeout', async () => {
  const controller = new AbortController()
  const pending = command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, timeoutMs: 10000 })
  const timer = setTimeout(() => controller.abort(), 50)
  try { await assert.rejects(pending, /取消或执行超时/) }
  finally { clearTimeout(timer) }
})

test('standalone packaging fills partially traced directories and replaces stale backend modules', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-standalone-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(path.join(root, 'scripts/already-traced.js'), '')
  write(path.join(root, 'services/executor/src/xgovernor/installation.cjs'), 'stale')
  const { copyBenchmarkExecutionRuntime } = require('../scripts/prepare-npm-package.js')
  copyBenchmarkExecutionRuntime(path.resolve('.'), root)
  for (const file of ['scripts/xgovernor.cjs', 'services/executor/src/xgovernor/installation.cjs', 'services/executor/src/xgovernor/dependency-manager.cjs', 'packages/benchmark-protocol/execution.cjs']) {
    assert.deepEqual(fs.readFileSync(path.join(root, file)), fs.readFileSync(path.resolve(file)))
  }
  const status = spawnSync(process.execPath, [path.join(root, 'scripts/xgovernor.cjs'), 'status'], { cwd: os.tmpdir(), env: isolatedHomeEnv(root), encoding: 'utf8' })
  assert.equal(status.status, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).installed, false)
})

test('managed profile preserves other native runtimes for later dataset preparation', async t => {
  const f = await fixture(t)
  await f.manager.update('v1')
  write(path.join(f.manager.root, 'setup.json'), JSON.stringify({ platforms: ['xiaoo'] }))
  const result = executionCapabilities({ config: normalizeExecutionConfig(), installationRoot: f.manager.root, target, env: {}, os: 'linux', refresh: true })
  assert.deepEqual(result.profiles[0].profile.targets.map((item: any) => item.platform), ['pi-agent', 'xiaoo'])
  assert.deepEqual(Object.keys(result.config.profiles['xgovernor-local-docker'].runtimes), ['pi-agent', 'xiaoo'])
})

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
  write(path.join(upstream, 'Cargo.lock'), 'locked')
  write(path.join(upstream, 'apps/runtime-pi/extension/package-lock.json'), '{}')
  write(path.join(upstream, 'apps/runtime-pi/extension/package.json'), JSON.stringify({ version: '0.1.0', devDependencies: { '@earendil-works/pi-coding-agent': '0.84.2' }, pi: { extensions: ['./index.ts'] } }))
  write(path.join(upstream, 'apps/runtime-pi/extension/index.ts'), 'export {}')
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
  const commands: Array<{ file: string; args: string[] }> = []
  const manager = new DependencyManager({
    root: path.join(root, 'installed'), target, log() {},
    async command(file: string, args: string[], options: any) {
      commands.push({ file, args })
      if (file === 'git') {
        const actual = args[0] === 'remote' ? [...args.slice(0, -1), upstream] : args
        return command(file, actual, { ...options, verbose: false })
      }
      if (args[0] === '--version') return file === 'node' ? 'v24.13.0' : 'fixture'
      if (file === 'cargo') {
        builds++
        if (failBuild) throw new Error('fixture compile error')
        const version = fs.readFileSync(path.join(options.cwd, 'version'), 'utf8')
        write(path.join(options.cwd, 'target/release/xgovernor-server'), server + `\n// ${version}\n`, true)
        write(path.join(options.cwd, 'target/release/pi-worker'), `#!${process.execPath}\n// ${version}\n`, true)
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
  assert.deepEqual(initial.components, { pi: '0.84.2', extension: '0.1.0' })
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

test('managed profile only advertises selected native runtimes', async t => {
  const f = await fixture(t)
  await f.manager.update('v1')
  write(path.join(f.manager.root, 'setup.json'), JSON.stringify({ platforms: ['xiaoo'] }))
  const result = executionCapabilities({ config: normalizeExecutionConfig(), installationRoot: f.manager.root, target, env: {}, os: 'linux', refresh: true })
  assert.deepEqual(result.profiles[0].profile.targets.map((item: any) => item.platform), ['xiaoo'])
  assert.deepEqual(Object.keys(result.config.profiles['xgovernor-local-docker'].runtimes), ['xiaoo'])
})

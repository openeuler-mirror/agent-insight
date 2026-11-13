/* Copyright (c) 2026 Huawei Technologies Co., Ltd. SPDX-License-Identifier: Apache-2.0 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { isolatedHomeEnv } from './helpers/isolated-home'

const installer = path.resolve(__dirname, '../scripts/install-ras-client.js')

async function fixture(t: TestContext, manager = 'unavailable') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-background-'))
  const clientHome = path.join(home, '.agent-insight/client')
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  const preload = path.join(home, 'linux.cjs')
  fs.writeFileSync(preload, `Object.defineProperty(process, 'platform', {value: 'linux'});
Object.defineProperty(process, 'getuid', {value: () => 1009720000});
const fs = require('node:fs'); const exists = fs.existsSync;
fs.existsSync = file => file === '/etc/systemd/system/agent-insight-client.service' ? process.env.TEST_LEGACY_SYSTEMD === '1' : exists(file);`)
  if (manager !== 'missing') fs.writeFileSync(path.join(bin, 'systemctl'), manager === 'available' ? '#!/bin/sh\nexit 0\n' : `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
echo 'Failed to connect to bus: No medium found' >&2
exit 1
`, { mode: 0o755 })
  const env = isolatedHomeEnv(home, {
    PATH: manager === 'missing' ? bin : `${bin}:/usr/bin:/bin`,
    NODE_OPTIONS: `--require=${preload}`,
    AGENT_INSIGHT_MACHINE_ID: `test-background-${path.basename(home)}`,
  })
  const registrations: Array<{ client: { supervisor: string }; previousClientId?: string }> = []
  const heartbeats: Array<{ authorization: string | undefined; body: { service: { supervisor: string } } }> = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/register')) {
      registrations.push(body)
      res.end(JSON.stringify({ clientId: 'cli_background', user: 'fixture', deviceCredential: `dc_${registrations.length}`, control: {} }))
    } else if (req.url?.endsWith('/heartbeat') && !req.url.includes('fault-injection')) {
      heartbeats.push({ authorization: req.headers.authorization, body })
      res.end(JSON.stringify({ nextHeartbeatSeconds: 30 }))
    } else if (req.url?.includes('/commands/next')) {
      res.writeHead(204).end()
    } else res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const host = `http://127.0.0.1:${address.port}`
  const run = (file: string, args: string[] = []) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.once('error', reject)
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`installer timed out: ${output}`)) }, 20_000)
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  const install = (...args: string[]) => run(installer, ['--host', host, '--token', 'it_fixture', '--no-fi', ...args])
  const background = (...args: string[]) => run(path.join(clientHome, 'runtime/client-process.cjs'), args)
  const record = () => JSON.parse(fs.readFileSync(path.join(clientHome, 'background.json'), 'utf8')) as { pid: number; instanceId: string }
  t.after(async () => {
    if (fs.existsSync(path.join(clientHome, 'runtime/client-process.cjs'))) await background('stop')
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { home, clientHome, env, run, install, background, record, registrations, heartbeats }
}

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 8000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(predicate(), 'client did not report the expected heartbeat')
}

for (const manager of ['unavailable', 'missing']) {
  test(`curl client installer registers and starts without systemd (${manager})`, async t => {
    const f = await fixture(t, manager)
    const result = await f.install()
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /后台进程|background/)
    assert.equal(f.registrations[0]?.client.supervisor, 'background')
    assert.ok(fs.existsSync(path.join(f.clientHome, 'runtime/reliability-client.cjs')))
    await eventually(() => f.heartbeats.some(item => item.authorization === 'Bearer dc_1'))
    assert.equal(f.heartbeats[0].body.service.supervisor, 'background')
    assert.ok(f.record().pid > 1)
    const status = await f.run(installer, ['--status'])
    assert.equal(status.code, 0, status.output)
    assert.match(status.output, /background: running/)
    assert.doesNotMatch(status.output, /systemd \(/)
  })
}

test('reinstallation replaces the background process and uses the rotated credential', async t => {
  const f = await fixture(t)
  assert.equal((await f.install()).code, 0)
  const first = f.record()
  const repeated = await f.install()
  assert.equal(repeated.code, 0, repeated.output)
  assert.equal(f.registrations.length, 2)
  assert.equal(f.registrations[1].previousClientId, 'cli_background')
  assert.notEqual(f.record().pid, first.pid)
  assert.throws(() => process.kill(first.pid, 0))
  await eventually(() => f.heartbeats.some(item => item.authorization === 'Bearer dc_2'))
  const removed = await f.run(installer, ['--uninstall'])
  assert.equal(removed.code, 0, removed.output)
  assert.ok(fs.existsSync(path.join(f.clientHome, 'config.json')))
  assert.match((await f.background('status')).output, /background: stopped/)
})

test('no-start completes registration without starting a process and supports a later start', async t => {
  const f = await fixture(t)
  const result = await f.install('--no-start')
  assert.equal(result.code, 0, result.output)
  assert.equal(f.registrations.length, 1)
  assert.ok(!fs.existsSync(path.join(f.clientHome, 'background.json')))
  assert.equal(f.heartbeats.length, 0)
  const start = await f.background('start')
  assert.equal(start.code, 0, start.output)
  await eventually(() => f.heartbeats.length > 0)
})

test('a client that exits during startup is reported as failed and leaves no background PID', async t => {
  const f = await fixture(t)
  assert.equal((await f.install('--no-start')).code, 0)
  fs.writeFileSync(path.join(f.clientHome, 'runtime/reliability-client.cjs'), 'process.exit(23)')
  const result = await f.background('start')
  assert.notEqual(result.code, 0, result.output)
  assert.match(result.output, /23|启动失败/)
  assert.ok(!fs.existsSync(path.join(f.clientHome, 'background.json')))
})

test('stale PID metadata never terminates an unrelated process', async t => {
  const f = await fixture(t)
  assert.equal((await f.install('--no-start')).code, 0)
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => { unrelated.kill() })
  fs.writeFileSync(path.join(f.clientHome, 'background.json'), JSON.stringify({ pid: unrelated.pid, instanceId: 'unrelated-process' }))
  const result = await f.background('stop')
  assert.equal(result.code, 0, result.output)
  assert.doesNotThrow(() => process.kill(unrelated.pid!, 0))
  assert.ok(!fs.existsSync(path.join(f.clientHome, 'background.json')))
})

test('an available systemd manager keeps the existing managed installation path', async t => {
  const f = await fixture(t, 'available')
  const result = await f.install('--no-start')
  assert.equal(result.code, 0, result.output)
  assert.equal(f.registrations[0].client.supervisor, 'systemd')
  assert.ok(fs.existsSync(path.join(f.home, '.config/systemd/user/agent-insight-client.service')))
  assert.ok(!fs.existsSync(path.join(f.clientHome, 'background.json')))
})

test('an unmanageable legacy system service still prevents credential rotation and duplicate clients', async t => {
  const f = await fixture(t)
  f.env.TEST_LEGACY_SYSTEMD = '1'
  const result = await f.install()
  assert.notEqual(result.code, 0, result.output)
  assert.match(result.output, /无法接管历史 systemd 服务/)
  assert.equal(f.registrations.length, 0)
  assert.ok(!fs.existsSync(path.join(f.clientHome, 'background.json')))
})

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

const require = createRequire(import.meta.url)
const { LocalRetention } = require('../services/executor/src/retention.cjs')
const { FileRunStore, createBenchmarkExecutor } = require('../services/executor/src/index.cjs')
const { repository } = require('../services/executor/src/xgovernor/installation.cjs')
const { DurableTraceUploader, acquireProcessLock, releaseProcessLock } = require('../scripts/agent-trace-collectors/shared/trace-transport.cjs')
const now = Date.UTC(2026, 9, 22)
const ago = (days: number) => new Date(now - days * 86400000).toISOString()

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-retention-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const baseDir = path.join(root, 'client')
  const installRoot = path.join(root, 'dependencies/xgovernor')
  const active = new Set<string>()
  const errors: unknown[] = []
  let days = 7
  const gc = new LocalRetention({ baseDir, installRoot, getDays: () => days, now: () => now,
    isActive: (id: string) => active.has(id), hasActiveRuns: () => active.size > 0,
    logError: (...args: unknown[]) => errors.push(args),
  })
  function run(id: string, age = 8, patch = {}, leasePatch = {}) {
    const record = path.join(baseDir, 'benchmark-runs', id)
    const sandbox = path.join(baseDir, 'xgovernor-runs', id)
    const state = { stage: 'terminal', terminalStatus: 'succeeded', terminalAt: ago(age), completionDeliveredAt: ago(age),
      cleanup: { status: 'succeeded' }, localArtifacts: [{ name: 'model.patch', sha256: 'sha256:fixture' }],
      uploadedArtifacts: [{ name: 'model.patch', sha256: 'sha256:fixture', artifactId: 'artifact-1' }], ...patch }
    write(path.join(record, 'state.json'), state)
    write(path.join(record, 'request.json'), { runId: id })
    write(path.join(record, 'artifacts/model.patch'), 'diff')
    write(path.join(sandbox, 'lease.json'), { directory: sandbox, closed: true, ...leasePatch })
    write(path.join(sandbox, 'server.log'), 'logs')
    write(path.join(sandbox, 'state/session.json'), { messages: ['raw trace'] })
    return { record, sandbox, state }
  }
  function release(n: number, age = 30) {
    const revision = n.toString(16).padStart(40, '0')
    const id = `${revision}-${n.toString(16).padStart(16, '0')}`
    const directory = path.join(installRoot, 'releases', id)
    write(path.join(directory, 'installation.json'), { repository, revision, schemaVersion: 1, installedAt: ago(age) })
    write(path.join(directory, 'source/server'), 'binary')
    return { id, directory }
  }
  return { root, baseDir, installRoot, gc, active, errors, run, release, setDays: (value: number) => { days = value } }
}

test('retention removes only expired terminal runs after cleanup and acknowledged uploads', async t => {
  const f = fixture(t)
  const expired = f.run('expired')
  const failed = f.run('failed', 8, { terminalStatus: 'failed' })
  const cancelled = f.run('cancelled', 8, { terminalStatus: 'cancelled', completionDeliveredAt: undefined })
  const recent = f.run('recent', 6)
  const protectedRuns = [
    f.run('running', 8, { stage: 'agent_running' }),
    f.run('cleanup_pending', 8, { cleanup: { status: 'failed' } }),
    f.run('callback_pending', 8, { stage: 'complete_pending' }),
    f.run('callback_rejected', 8, { completionDeliveredAt: undefined }),
    f.run('artifact_pending', 8, { uploadedArtifacts: [] }),
    f.run('artifact_mismatch', 8, { uploadedArtifacts: [{ name: 'model.patch', sha256: 'wrong', artifactId: 'id' }] }),
    f.run('lease_open', 8, {}, { closed: false }),
    f.run('active'),
    f.run('unknown_date', 8, { terminalAt: 'invalid' }),
  ]
  f.active.add('active')
  write(path.join(f.root, 'platform/result.json'), 'platform data')
  await f.gc.sweep(true)
  for (const run of [expired, failed, cancelled]) {
    assert.equal(fs.existsSync(run.record), false)
    assert.equal(fs.existsSync(run.sandbox), false)
  }
  for (const run of [recent, ...protectedRuns]) assert.equal(fs.existsSync(run.record), true)
  assert.equal(fs.readFileSync(path.join(f.root, 'platform/result.json'), 'utf8'), 'platform data')
  assert.equal(f.errors.length, 0)
  f.setDays(5)
  await f.gc.sweep(true)
  assert.equal(fs.existsSync(recent.record), false)
})

test('Trace checkpoints and upload locks protect pending and torn records beyond retention', async t => {
  const f = fixture(t)
  const pending = f.run('pending_trace')
  const complete = f.run('uploaded_trace')
  const locked = f.run('locked_trace')
  for (const run of [pending, complete, locked]) {
    const spool = path.join(run.sandbox, 'trace-spool')
    write(path.join(spool, '2026-10-01/events.jsonl'), '{"event":1}\n')
    write(path.join(spool, 'uploader-checkpoint.json'), { version: 1, files: { '2026-10-01/events.jsonl': { bytes: run === pending ? 5 : 12 } } })
  }
  const lock = await acquireProcessLock(path.join(locked.sandbox, 'trace-spool/uploader.lock'))
  assert.ok(lock)
  try {
    await f.gc.sweep(true)
    assert.equal(fs.existsSync(pending.sandbox), true)
    assert.equal(fs.existsSync(locked.sandbox), true)
    assert.equal(fs.existsSync(complete.sandbox), false)
  } finally { await releaseProcessLock(lock) }
  await f.gc.sweep(true)
  assert.equal(fs.existsSync(locked.sandbox), false)
})

test('xGovernor Trace uploader can defer retention to Case GC without dropping an old torn tail', async t => {
  const f = fixture(t)
  const run = f.run('torn_trace')
  const spool = path.join(run.sandbox, 'trace-spool')
  const file = path.join(spool, '2020-01-01/events.jsonl')
  write(file, '{"unfinished":')
  const uploader = new DurableTraceUploader({ framework: 'pi-agent', apiKey: 'fixture', stateDir: spool,
    endpoint: 'https://example.invalid', cleanupRetention: false, fetch: async () => { throw new Error('unexpected upload') } })
  await uploader.flushOnce()
  assert.equal(fs.existsSync(file), true)
  await f.gc.sweep(true)
  assert.equal(fs.existsSync(run.record), true)
})

test('history cleanup skips malformed records and symlinks without deleting their targets', async t => {
  const f = fixture(t)
  const corrupt = f.run('corrupt')
  write(path.join(corrupt.record, 'state.json'), '{')
  const outside = path.join(f.root, 'outside')
  write(path.join(outside, 'keep.txt'), 'keep')
  fs.symlinkSync(outside, path.join(f.baseDir, 'benchmark-runs', 'linked'), 'dir')
  const linkedSandbox = f.run('linked_sandbox')
  fs.rmSync(linkedSandbox.sandbox, { recursive: true })
  fs.symlinkSync(outside, linkedSandbox.sandbox, 'dir')
  const healthy = f.run('healthy')
  await f.gc.sweep(true)
  assert.equal(fs.existsSync(corrupt.record), true)
  assert.equal(fs.existsSync(linkedSandbox.record), true)
  assert.equal(fs.existsSync(healthy.record), false)
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
  assert.ok(f.errors.length > 0)
})

test('version GC keeps current, previous, recent and referenced releases and respects update locks', async t => {
  const f = fixture(t)
  const [current, previous, referenced, pending, unused, recent] = [1, 2, 3, 4, 5, 6].map(n => f.release(n, n === 6 ? 1 : 30))
  write(path.join(f.installRoot, 'current.json'), { schemaVersion: 1, current: current.id, previous: previous.id })
  f.run('still_running', 8, { stage: 'agent_running' }, { closed: false, executionConfig: { serverExecutable: path.join(referenced.directory, 'source/server') } })
  f.run('pending_recovery', 8, { stage: 'cleanup_pending', executionHandle: { opaque: { cleanupConfig: { serverExecutable: path.join(pending.directory, 'source/server') } } } })
  write(path.join(f.installRoot, 'update.lock'), 'fixture')
  await f.gc.sweep(true)
  assert.equal(fs.existsSync(unused.directory), true)
  fs.unlinkSync(path.join(f.installRoot, 'update.lock'))
  f.active.add('preparing')
  await f.gc.sweep(true)
  assert.equal(fs.existsSync(unused.directory), true)
  f.active.clear()
  await f.gc.sweep(true)
  assert.equal(fs.existsSync(unused.directory), false)
  for (const release of [current, previous, referenced, pending, recent]) assert.equal(fs.existsSync(release.directory), true)
  assert.equal(f.errors.length, 0)
})

test('a symlink at the sandbox root prevents traversing and deleting external Case directories', async t => {
  const f = fixture(t)
  const run = f.run('outside_case')
  const outside = path.join(f.root, 'external-sandboxes')
  fs.renameSync(path.join(f.baseDir, 'xgovernor-runs'), outside)
  fs.symlinkSync(outside, path.join(f.baseDir, 'xgovernor-runs'), 'dir')
  await f.gc.sweep(true)
  assert.equal(fs.existsSync(run.record), true)
  assert.equal(fs.existsSync(path.join(outside, 'outside_case/server.log')), true)
  assert.ok(f.errors.length > 0)
})

test('an interrupted deletion resumes from its separate approval record on the next sweep', async t => {
  const f = fixture(t)
  const expired = f.run('interrupted')
  const promises = require('node:fs/promises')
  const original = promises.rm
  const mock = t.mock.method(promises, 'rm', async (file: string, options: unknown) => {
    if (String(file).startsWith(path.join(f.baseDir, 'retention-trash') + path.sep)) throw new Error('simulated deletion failure')
    return original(file, options)
  })
  await f.gc.sweep(true)
  assert.equal(fs.existsSync(expired.record), false)
  const trash = path.join(f.baseDir, 'retention-trash')
  assert.equal(fs.readdirSync(trash).some(name => name.endsWith('.json')), true)
  mock.mock.restore()
  await f.gc.sweep(true)
  assert.deepEqual(fs.readdirSync(trash), [])
})

test('terminal time is stable and executor recovery automatically sweeps old local history', async t => {
  const f = fixture(t)
  const store = new FileRunStore(path.join(f.baseDir, 'benchmark-runs'))
  await store.writeState('terminal_clock', { stage: 'terminal', terminalStatus: 'cancelled' })
  const first = (await store.state('terminal_clock')).terminalAt
  await new Promise(resolve => setTimeout(resolve, 5))
  await store.writeState('terminal_clock', { stage: 'terminal', callbackError: 'later callback' })
  assert.equal((await store.state('terminal_clock')).terminalAt, first)
  const expired = f.run('startup_expired', 8, { terminalAt: new Date(Date.now() - 8 * 86400000).toISOString() })
  const executor = createBenchmarkExecutor({ clientId: 'fixture', deviceCredential: 'fixture', insightBaseUrl: 'https://example.invalid',
    baseDir: f.baseDir, executionConfig: { profiles: {}, bindings: [] }, agentPlatforms: [], runAgent: async () => ({}), retention: { days: 7 } })
  try {
    await executor.recover()
    assert.equal(fs.existsSync(expired.record), false)
  } finally { await executor.close() }
})

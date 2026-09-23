import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const helper = path.resolve('scripts/stop-orphan-trace-consumer.cjs')
const hasLsof = spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error === undefined

test('start.sh cleans up a same-project Trace consumer without a listening port', { skip: !hasLsof }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-consumer-start-'))
  const expectedCwd = path.join(root, '.next', 'standalone', 'app')
  const insightHome = path.join(root, 'home')
  const lockPath = path.join(insightHome, 'otel_data', 'traces', 'consumer-owner.lock')
  fs.mkdirSync(expectedCwd, { recursive: true })
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: expectedCwd,
    stdio: 'ignore',
  })
  try {
    assert.ok(child.pid)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, token: 'test-owner' }))
    await new Promise(resolve => setTimeout(resolve, 100))

    const result = spawnSync(process.execPath, [helper, insightHome, root], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Stopping orphan Agent Insight Trace consumer process/)
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
    assert.equal(child.signalCode, 'SIGKILL')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('start.sh refuses to kill a Trace lock owner outside its project', { skip: !hasLsof }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-consumer-foreign-'))
  const insightHome = path.join(root, 'home')
  const lockPath = path.join(insightHome, 'otel_data', 'traces', 'consumer-owner.lock')
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: root,
    stdio: 'ignore',
  })
  try {
    assert.ok(child.pid)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, token: 'foreign-owner' }))
    await new Promise(resolve => setTimeout(resolve, 100))

    const result = spawnSync(process.execPath, [helper, insightHome, root], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /拒绝误杀/)
    assert.equal(child.exitCode, null)
  } finally {
    child.kill('SIGKILL')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

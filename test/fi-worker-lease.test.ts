import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

let prisma: typeof import('@/lib/storage/prisma')['prisma']
let sweep: typeof import('@/lib/fault-injection/worker-protocol')['sweepStaleClaims']
let root: string
const user = 'fi-lease-' + process.pid

test.before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'fi-worker-lease-'))
  process.env.AGENT_INSIGHT_HOME = root
  process.env.DATABASE_URL = 'file:' + path.join(root, 'test.db')
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' })
  ;({ prisma } = await import('@/lib/storage/prisma'))
  ;({ sweepStaleClaims: sweep } = await import('@/lib/fault-injection/worker-protocol'))
})
test.after(async () => {
  await prisma?.$disconnect()
  if (root) rmSync(root, { recursive: true, force: true })
})

/** Create expired claims without requiring a live client or model provider. */
async function fixture(name: string, online: boolean, stopRequested = false) {
  const workerId = user + '-' + name
  await prisma.faultInjectionWorker.create({ data: {
    workerId, user, lastSeenAt: new Date(Date.now() - (online ? 0 : 900_000)),
  } })
  return prisma.faultInjectionRun.create({ data: {
    runId: 'ras-lease-' + name + '-' + process.pid, workerId, user,
    platform: 'opencode', agent: 'build', fault: 'thinking-dead-loop',
    status: 'collecting', claimedAt: new Date(Date.now() - 600_000), stopRequested,
  } })
}

test('healthy workers keep long-running claims even beyond 300 seconds', async () => {
  const run = await fixture('healthy', true)
  assert.equal(await sweep(user), 0)
  const fresh = await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(fresh.status, 'collecting')
  assert.equal(fresh.workerId, run.workerId)
  assert.equal(fresh.claimedAt?.getTime(), run.claimedAt?.getTime())
})
test('orphan claims are requeued and orphan stop requests settle as stopped', async () => {
  const retry = await fixture('offline', false)
  const stopped = await fixture('stopped', false, true)
  assert.equal(await sweep(user), 2)
  for (const [run, expected] of [[retry, 'queued'], [stopped, 'stopped']] as const) {
    const fresh = await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: run.id } })
    assert.equal(fresh.status, expected)
    assert.equal(fresh.workerId, null)
  }
})
test('concurrent reclaim passes do not reset or count the same claim twice', async () => {
  const run = await fixture('race', false)
  const counts = await Promise.all([sweep(user), sweep(user)])
  assert.equal(counts.reduce((a, b) => a + b, 0), 1)
  const fresh = await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(fresh.status, 'queued')
  assert.equal(await sweep(user), 0)
})

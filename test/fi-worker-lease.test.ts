import assert from 'node:assert/strict'
import test from 'node:test'
import { createIsolatedDatabase } from './helpers/isolated-database'

let prisma: typeof import('@/lib/storage/prisma')['prisma']
let sweep: typeof import('@/lib/fault-injection/worker-protocol')['sweepStaleClaims']
let database: ReturnType<typeof createIsolatedDatabase> | undefined
const user = 'fi-lease-' + process.pid

test.before(async () => {
  database = createIsolatedDatabase()
  ;({ prisma } = await import('@/lib/storage/prisma'))
  ;({ sweepStaleClaims: sweep } = await import('@/lib/fault-injection/worker-protocol'))
})
test.after(async () => {
  try { await prisma?.$disconnect() } finally { database?.dispose() }
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

test('current active-run heartbeats protect live work but recover claims lost on restart', async () => {
  const active = await fixture('reported-active', true)
  const lost = await fixture('restarted', true)
  await prisma.faultInjectionWorker.update({ where: { workerId: active.workerId! },
    data: { inventoryJson: JSON.stringify({ activeRunIds: [active.runId] }) } })
  await prisma.faultInjectionWorker.update({ where: { workerId: lost.workerId! },
    data: { inventoryJson: JSON.stringify({ activeRunIds: [] }) } })
  assert.equal(await sweep(user), 1)
  const kept = await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: active.id } })
  const recovered = await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: lost.id } })
  assert.equal(kept.status, 'collecting')
  assert.equal(recovered.status, 'queued')
  assert.equal(recovered.workerId, null)
})

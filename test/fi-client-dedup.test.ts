import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
const require = createRequire(import.meta.url)
const { executeClaimedFiRun } = require('../scripts/reliability-client.cjs')

test('duplicate active FI delivery shares neither a second process nor a second result upload', async () => {
  let release: (payload: unknown) => void = () => {}
  const gate = new Promise((resolve) => { release = resolve })
  let collected = 0
  const uploads: unknown[] = []
  const options = {
    collect: async () => { collected += 1; return gate },
    postResult: async (payload: unknown) => { uploads.push(payload) },
  }
  const run = { runId: 'ras-dedup-active' }
  const first = executeClaimedFiRun({}, run, options)
  assert.equal(await executeClaimedFiRun({}, run, options), false)
  assert.equal(collected, 1)
  release({ taskId: 'ses_business', interactions: [] })
  assert.equal(await first, true)
  assert.deepEqual(uploads, [{ taskId: 'ses_business', interactions: [] }])
})
test('collector failure releases the run guard and uploads the actual error once', async () => {
  const uploads: unknown[] = []
  const run = { runId: 'ras-dedup-failure' }
  assert.equal(await executeClaimedFiRun({}, run, {
    collect: async () => { throw new Error('fixture collector error') },
    postResult: async (payload: unknown) => { uploads.push(payload) },
  }), true)
  assert.deepEqual(uploads, [{ error: 'fixture collector error', interactions: [] }])
  let called = false
  await executeClaimedFiRun({}, run, {
    collect: async () => { called = true; return {} },
    postResult: async () => {},
  })
  assert.equal(called, true)
})

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

import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { prisma } from '@/lib/storage/prisma'
import { defaultEvaluatorTargetResolver } from '@/lib/benchmark/evaluator-target'
import { refreshBenchmarkImagePreparation, waitForBenchmarkImagePreparation } from '@/lib/benchmark/image-preparation'
import { dispatchBenchmarkRun, setBenchmarkCommandDispatcherForTest, stopBenchmarkBackgroundWorkForTest } from '@/lib/benchmark/scheduler'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function stubMethod(t: TestContext, target: object, key: string, replacement: (...args: any[]) => unknown) {
  // Prisma delegates expose methods through a proxy rather than property descriptors.
  const methods = target as Record<string, unknown>
  const original = methods[key]
  const stub = t.mock.fn(replacement)
  methods[key] = stub
  t.after(() => { methods[key] = original })
  return stub
}

test('cleanup waits for coalesced image refreshes without starting new database work', async t => {
  const first = gate()
  const second = gate()
  const entered = gate()
  const secondEntered = gate()
  let queries = 0
  t.mock.method(defaultEvaluatorTargetResolver, 'resolve', () => { throw new Error('No evaluator configured') })
  stubMethod(t, prisma.benchmarkCaseRun, 'findMany', async () => {
    queries++
    if (queries === 1) { entered.release(); await first.promise }
    else { secondEntered.release(); await second.promise }
    return []
  })
  await waitForBenchmarkImagePreparation()
  assert.equal(queries, 0)
  const refresh = refreshBenchmarkImagePreparation()
  await entered.promise
  assert.equal(refreshBenchmarkImagePreparation(), refresh)
  let cleaned = false
  const cleanup = stopBenchmarkBackgroundWorkForTest().then(() => { cleaned = true })
  await setImmediate()
  assert.equal(cleaned, false)
  first.release()
  await secondEntered.promise
  assert.equal(queries, 2)
  assert.equal(cleaned, false)
  second.release()
  await Promise.all([refresh, cleanup])
  await waitForBenchmarkImagePreparation()
  assert.equal(queries, 2)
})

test('cleanup waits for a dispatch and the next Case it starts while settling', async t => {
  const parent = gate()
  const child = gate()
  let childWork: Promise<void> | undefined
  stubMethod(t, prisma.benchmarkCaseRun, 'findUnique', async ({ where }: { where: { id: string } }) => {
    if (where.id === 'parent') {
      await parent.promise
      childWork = dispatchBenchmarkRun('child')
    } else await child.promise
    return null
  })
  const work = dispatchBenchmarkRun('parent')
  const cleanup = stopBenchmarkBackgroundWorkForTest()
  assert.equal(stopBenchmarkBackgroundWorkForTest(), cleanup)
  let cleaned = false
  void cleanup.then(() => { cleaned = true })
  await setImmediate()
  assert.equal(cleaned, false)
  parent.release()
  await setImmediate()
  assert.ok(childWork)
  assert.equal(cleaned, false)
  child.release()
  await Promise.all([work, childWork, cleanup])
  assert.equal(cleaned, true)
})

for (const duringCleanup of [false, true]) {
  test(`cleanup cancels busy retries ${duringCleanup ? 'scheduled during shutdown' : 'already scheduled'}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const outcome = gate()
    const entered = gate()
    let queries = 0
    stubMethod(t, prisma.benchmarkCaseRun, 'findUnique', async () => {
      queries++
      return { status: 'dispatching', experimentId: 'experiment' }
    })
    stubMethod(t, prisma.experiment, 'findUnique', async () => ({ status: 'running', deletedAt: null }))
    stubMethod(t, prisma.experimentCancellation, 'findFirst', async () => null)
    stubMethod(t, prisma.benchmarkDispatchOutbox, 'updateMany', async () => ({ count: 1 }))
    stubMethod(t, prisma.benchmarkDispatchOutbox, 'findUnique', async () => ({
      requestJson: JSON.stringify({ runId: 'run', requestDigest: 'digest' }), requestDigest: 'digest',
      run: { clientId: 'client', experiment: { user: 'user' } },
    }))
    stubMethod(t, prisma.benchmarkDispatchOutbox, 'update', async () => ({}))
    stubMethod(t, prisma.benchmarkCaseRun, 'updateMany', async () => ({ count: 1 }))
    stubMethod(t, prisma, '$transaction', async () => [])
    setBenchmarkCommandDispatcherForTest(async () => {
      entered.release()
      if (duringCleanup) await outcome.promise
      return { commandId: 'command', status: 'busy' }
    })
    t.after(() => setBenchmarkCommandDispatcherForTest())
    const work = dispatchBenchmarkRun('run')
    await entered.promise
    if (!duringCleanup) await work
    const cleanup = stopBenchmarkBackgroundWorkForTest()
    outcome.release()
    await Promise.all([work, cleanup])
    t.mock.timers.tick(1_000)
    await setImmediate()
    assert.equal(queries, 1)
  })
}

test('a failed dispatch is released from cleanup and subsequent work can still run', async t => {
  const lookup = stubMethod(t, prisma.benchmarkCaseRun, 'findUnique', async () => { throw new Error('synthetic failure') })
  const work = dispatchBenchmarkRun('failed')
  await Promise.all([assert.rejects(work, /synthetic failure/), stopBenchmarkBackgroundWorkForTest()])
  lookup.mock.mockImplementation(async () => null)
  await dispatchBenchmarkRun('next')
  await stopBenchmarkBackgroundWorkForTest()
  assert.equal(lookup.mock.callCount(), 2)
})

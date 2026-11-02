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
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import test, { type TestContext } from 'node:test'
import { createIsolatedDatabase } from './helpers/isolated-database'

const database = createIsolatedDatabase()
const { prisma } = require('@/lib/storage/prisma') as typeof import('@/lib/storage/prisma')
const { resolveAgentInsightDataPath } = require('@/lib/env') as typeof import('@/lib/env')
const { canonicalJson } = require('../packages/benchmark-protocol/src/contracts') as typeof import('../packages/benchmark-protocol/src/contracts')
const { zsoftL1Adapter } = require('../benchmarks/zsoft-l1/adapter') as typeof import('../benchmarks/zsoft-l1/adapter')
const preparation = require('@/lib/benchmark/evaluation-preparation-service') as typeof import('@/lib/benchmark/evaluation-preparation-service')
const scheduler = require('@/lib/benchmark/evaluation-scheduler') as typeof import('@/lib/benchmark/evaluation-scheduler')
const { stopBenchmarkBackgroundWorkForTest } = require('@/lib/benchmark/scheduler') as typeof import('@/lib/benchmark/scheduler')
const { waitForBenchmarkEvaluationContinuationsForTest } = require('@/lib/benchmark/evaluation-continuation-service') as typeof import('@/lib/benchmark/evaluation-continuation-service')
const { refreshBenchmarkImagePreparation } = require('@/lib/benchmark/image-preparation') as typeof import('@/lib/benchmark/image-preparation')

test.after(async () => { await stopBenchmarkBackgroundWorkForTest(); await prisma.$disconnect(); database.dispose() })

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'background dispatch did not reach the expected state')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function fixture(t: TestContext, count: number) {
  const windows = new Set<string>()
  const accepted: string[] = []
  let preparationCount = 0
  let waitingCount = 0
  let rejectPreparation = false
  let terminalCode = ''
  let experimentId: string | undefined
  let datasetId: string | undefined
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health') {
      res.end(JSON.stringify({ status: 'healthy', busy: false, maxConcurrency: 2, imagePool: { prefetch: true },
        evaluators: [{ key: 'zsoft-l1', ready: true }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (body.operation === 'prepare-images') {
      preparationCount++
      if (rejectPreparation) { res.statusCode = 503; res.end('{}'); return }
      windows.clear()
      for (const window of body.windows || []) for (const id of window.caseIds) windows.add(id)
      res.end('{}')
      return
    }
    if (terminalCode && body.evaluationJob.payload.taskId === 'synthetic-0') {
      res.statusCode = 422
      res.end(JSON.stringify({ error: { code: terminalCode, message: '旧排序摘要，请重新导入新数据集', retryable: false } }))
      return
    }
    if (!windows.has(body.evaluationJob.executionRunId)) {
      waitingCount++
      res.statusCode = 409
      res.end(JSON.stringify({ error: { code: 'IMAGE_POOL_PREPARING', message: '等待进入镜像准备窗口' } }))
      return
    }
    accepted.push(body.runId)
    res.statusCode = 202
    res.end(JSON.stringify({ runId: body.runId, requestDigest: body.requestDigest, status: 'accepted' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await stopBenchmarkBackgroundWorkForTest()
    rejectPreparation = false
    if (experimentId) await prisma.experiment.update({ where: { id: experimentId }, data: { status: 'done' } })
    await refreshBenchmarkImagePreparation()
    if (experimentId) await prisma.experiment.delete({ where: { id: experimentId } })
    if (datasetId) await prisma.agentEvalDataset.delete({ where: { id: datasetId } })
    delete process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address() as { port: number }
  process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL = `http://127.0.0.1:${address.port}`
  scheduler.setBenchmarkEvaluationDispatchFetchForTest()
  scheduler.setEvaluatorTargetResolverForTest()
  const dataset = await prisma.agentEvalDataset.create({ data: { id: randomUUID(), user: 'retry-user', name: 'retry', datasetKind: 'benchmark' } })
  datasetId = dataset.id
  const benchmark = await prisma.benchmarkDataset.create({ data: { agentEvalDatasetId: dataset.id, user: 'retry-user', name: 'retry', adapterKey: 'zsoft-l1', contentHash: 'fixture' } })
  const experiment = await prisma.experiment.create({ data: { user: 'retry-user', name: 'retry', scope: 'benchmark', status: 'done' } })
  experimentId = experiment.id
  await prisma.benchmarkExperimentBinding.create({ data: { experimentId: experiment.id, datasetId: benchmark.id, datasetContentHash: 'fixture', adapterKey: 'zsoft-l1', selectionJson: '{}', runConfigJson: '{}', expectedCaseCount: count, callbackOrigin: 'http://platform.test', schedulerStatus: 'done' } })
  const cases: Array<{ experimentId: string; resultId: string; user: string; runId: string }> = []
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const raw = { public: { taskId: `synthetic-${ordinal}`, title: 'Synthetic case', description: 'Never executed', submissionKind: 'python', maxBytes: 128, tags: ['userspace'] }, private: { sourceTaskDigest: `sha256:${'a'.repeat(64)}` } }
    const datasetCase = await prisma.benchmarkDatasetCase.create({ data: { datasetId: benchmark.id, externalCaseId: raw.public.taskId, rawCaseJson: JSON.stringify(raw), publicPayloadJson: JSON.stringify(raw.public), privatePayloadJson: JSON.stringify(raw.private), sourceFingerprint: 'fixture', publicFingerprint: 'fixture', privateFingerprint: 'fixture', ordinal } })
    const c = await prisma.experimentCase.create({ data: { experimentId: experiment.id, input: 'synthetic' } })
    const runId = `${experiment.id}-run-${ordinal}`
    const bytes = Buffer.from('synthetic submission; never executed')
    const storagePath = `${runId}-poc`
    await fs.mkdir(resolveAgentInsightDataPath(), { recursive: true })
    await fs.writeFile(resolveAgentInsightDataPath(storagePath), bytes)
    await prisma.benchmarkCaseRun.create({ data: { id: runId, experimentId: experiment.id, experimentCaseId: c.id, datasetCaseId: datasetCase.id, ordinal, adapterKey: 'zsoft-l1', status: 'evaluated', submissionSource: 'imported', submissionContractJson: canonicalJson([...zsoftL1Adapter.manifest.requiredArtifacts]), publicPayloadJson: JSON.stringify(raw.public), privatePayloadJson: JSON.stringify(raw.private),
      artifacts: { create: { id: `${runId}-artifact`, name: 'poc', mediaType: 'application/octet-stream', sizeBytes: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, storagePath } },
      evaluations: { create: { id: `${runId}-original`, adapterKey: 'zsoft-l1', evaluatorKey: 'zsoft-l1', requestJson: '{}', requestDigest: 'original', callbackBaseUrl: 'http://platform.test', timeoutSeconds: 60, status: 'completed', continuationStatus: 'completed' } },
    } })
    const result = await prisma.experimentEvalResult.create({ data: { experimentId: experiment.id, caseId: c.id, evaluatorId: 'benchmark:zsoft-l1', status: 'done', score: 100 } })
    cases.push({ experimentId: experiment.id, resultId: result.id, user: 'retry-user', runId })
  }
  return { cases, windows, accepted, get preparationCount() { return preparationCount }, get waitingCount() { return waitingCount },
    set rejectPreparation(value: boolean) { rejectPreparation = value }, set terminalCode(value: string) { terminalCode = value } }
}

test('different cases can reevaluate concurrently, same-case duplicate clicks create one attempt, and service capacity still applies', async (t) => {
  const f = await fixture(t, 3)
  const duplicates = await Promise.allSettled([preparation.retryBenchmarkEvaluation(f.cases[0]), preparation.retryBenchmarkEvaluation(f.cases[0])])
  assert.equal(duplicates.filter(item => item.status === 'fulfilled').length, 1)
  const rejected = duplicates.find(item => item.status === 'rejected') as PromiseRejectedResult
  assert.equal(rejected.reason.code, 'BENCHMARK_REEVALUATION_BUSY')
  assert.equal(await prisma.benchmarkEvaluation.count({ where: { caseRunId: f.cases[0].runId, attemptNo: 2 } }), 1)
  await eventually(async () => f.accepted.length === 1)
  const more = await Promise.all(f.cases.slice(1).map(c => preparation.retryBenchmarkEvaluation(c)))
  assert.equal(more.length, 2)
  await eventually(async () => {
    const rows = await prisma.benchmarkEvaluationDispatchOutbox.findMany({ where: { evaluation: { caseRun: { experimentId: f.cases[0].experimentId } } } })
    return rows.length === 3 && rows.every((row: { attemptCount: number; status: string }) => row.attemptCount > 0 && row.status !== 'sending')
  })
  assert.equal(f.accepted.length, 2)
  assert.equal(f.waitingCount, 0, 'reevaluation must refresh the image window before first dispatch')
  const queued = await prisma.benchmarkEvaluation.findMany({ where: { caseRun: { experimentId: f.cases[0].experimentId }, attemptNo: 2, status: 'queued' } })
  assert.equal(queued.length, 1)
  await assert.rejects(preparation.retryBenchmarkEvaluation(f.cases[0]), { code: 'BENCHMARK_REEVALUATION_BUSY' })
})

test('an already queued evaluation refreshes its missing image window and recovers without a watchdog', async (t) => {
  const f = await fixture(t, 1)
  await prisma.experiment.update({ where: { id: f.cases[0].experimentId }, data: { status: 'running' } })
  await prisma.benchmarkCaseRun.update({ where: { id: f.cases[0].runId }, data: { status: 'submitted' } })
  const prepared = await preparation.prepareBenchmarkEvaluation(f.cases[0].runId, { forceNewAttempt: true })
  await scheduler.dispatchBenchmarkEvaluation(prepared.evaluationRunId)
  assert.equal(f.waitingCount, 1)
  assert.ok(f.preparationCount > 0)
  assert.ok(f.windows.has(f.cases[0].runId))
  await prisma.benchmarkEvaluationDispatchOutbox.update({ where: { evaluationId: prepared.evaluationRunId }, data: { nextAttemptAt: new Date(0) } })
  await scheduler.dispatchBenchmarkEvaluation(prepared.evaluationRunId)
  assert.deepEqual(f.accepted, [prepared.evaluationRunId])
})

test('permanent metadata rejection fails visibly without retrying or blocking another Case', async t => {
  const f = await fixture(t, 2)
  f.terminalCode = 'ZSOFT_TASK_DIGEST_LEGACY'
  const rejected = await preparation.retryBenchmarkEvaluation(f.cases[0])
  await preparation.waitForBenchmarkReevaluationsForTest()
  await waitForBenchmarkEvaluationContinuationsForTest()
  const failed = await prisma.benchmarkEvaluation.findUniqueOrThrow({ where: { id: rejected.evaluationRunId } })
  assert.equal(failed.status, 'dispatch_failed')
  assert.equal(failed.failureCode, 'ZSOFT_TASK_DIGEST_LEGACY')
  assert.match(failed.failureMessage || '', /重新导入/)
  const run = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: f.cases[0].runId } })
  assert.equal(run.status, 'evaluation_failed')
  const outbox = await prisma.benchmarkEvaluationDispatchOutbox.findUniqueOrThrow({ where: { evaluationId: rejected.evaluationRunId } })
  assert.equal(outbox.status, 'failed')
  await scheduler.dispatchBenchmarkEvaluation(rejected.evaluationRunId)
  assert.equal((await prisma.benchmarkEvaluationDispatchOutbox.findUniqueOrThrow({ where: { evaluationId: rejected.evaluationRunId } })).attemptCount, outbox.attemptCount)
  const good = await preparation.retryBenchmarkEvaluation(f.cases[1])
  await preparation.waitForBenchmarkReevaluationsForTest()
  assert.ok(f.accepted.includes(good.evaluationRunId), JSON.stringify({
    outbox: await prisma.benchmarkEvaluationDispatchOutbox.findUnique({ where: { evaluationId: good.evaluationRunId }, select: { status: true, errorCode: true, errorMessage: true, attemptCount: true } }),
    windows: [...f.windows], waitingCount: f.waitingCount,
  }))
  assert.equal(f.accepted.includes(rejected.evaluationRunId), false)
})

test('a preparation service failure keeps reevaluation queued and a later retry repairs its window', async (t) => {
  const f = await fixture(t, 1)
  f.rejectPreparation = true
  const prepared = await preparation.retryBenchmarkEvaluation(f.cases[0])
  await eventually(async () => (await prisma.benchmarkEvaluationDispatchOutbox.findUnique({ where: { evaluationId: prepared.evaluationRunId } }))?.status === 'pending' && f.waitingCount > 0 && f.preparationCount >= 2)
  assert.equal((await prisma.benchmarkEvaluation.findUniqueOrThrow({ where: { id: prepared.evaluationRunId } })).status, 'queued')
  f.rejectPreparation = false
  for (let attempt = 0; attempt < 2; attempt++) {
    await prisma.benchmarkEvaluationDispatchOutbox.update({ where: { evaluationId: prepared.evaluationRunId }, data: { nextAttemptAt: new Date(0) } })
    await scheduler.dispatchBenchmarkEvaluation(prepared.evaluationRunId)
  }
  assert.deepEqual(f.accepted, [prepared.evaluationRunId])
})

test('a run changed by another worker cannot be claimed from a stale reevaluation snapshot', async (t) => {
  const f = await fixture(t, 1)
  const original = fs.readFile.bind(fs)
  const snapshot = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await original(...args)
    await prisma.benchmarkCaseRun.update({ where: { id: f.cases[0].runId }, data: { updatedAt: new Date(0) } })
    return bytes
  })
  await assert.rejects(preparation.retryBenchmarkEvaluation(f.cases[0]), { code: 'BENCHMARK_REEVALUATION_BUSY' })
  snapshot.mock.restore()
  assert.equal(await prisma.benchmarkEvaluation.count({ where: { caseRunId: f.cases[0].runId } }), 1)
  assert.equal((await prisma.experimentEvalResult.findUniqueOrThrow({ where: { id: f.cases[0].resultId } })).status, 'done')
  assert.equal((await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: f.cases[0].runId } })).status, 'evaluated')
})

test('the evaluation watchdog prepares images and resumes queued work independently of Agent recovery', async (t) => {
  const f = await fixture(t, 1)
  await prisma.experiment.update({ where: { id: f.cases[0].experimentId }, data: { status: 'running' } })
  await prisma.benchmarkCaseRun.update({ where: { id: f.cases[0].runId }, data: { status: 'submitted' } })
  const prepared = await preparation.prepareBenchmarkEvaluation(f.cases[0].runId, { forceNewAttempt: true })
  t.mock.timers.enable({ apis: ['setInterval'] })
  scheduler.startBenchmarkEvaluationWatchdog(1000)
  t.mock.timers.tick(1000)
  await eventually(async () => (await prisma.benchmarkEvaluationDispatchOutbox.findUnique({ where: { evaluationId: prepared.evaluationRunId } }))?.status === 'accepted')
  assert.ok(f.preparationCount > 0)
  assert.equal(f.waitingCount, 0)
  assert.deepEqual(f.accepted, [prepared.evaluationRunId])
  t.mock.timers.reset()
})

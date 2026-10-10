import assert from 'node:assert/strict'
import test from 'node:test'
import { createIsolatedDatabase } from './helpers/isolated-database'

const database = createIsolatedDatabase()
const { prisma } = require('@/lib/storage/prisma') as typeof import('@/lib/storage/prisma')
const scheduler = require('@/lib/benchmark/evaluation-scheduler') as typeof import('@/lib/benchmark/evaluation-scheduler')
test.after(async () => { await prisma.$disconnect(); database.dispose() })

test('concurrent dispatchers respect service capacity and per-user quota across experiments', async () => {
  const posted: string[] = []
  process.env.AGENT_INSIGHT_BENCHMARK_EVAL_MAX_CONCURRENCY_PER_USER = '1'
  scheduler.setEvaluatorTargetResolverForTest({ resolve: (evaluatorKey) => ({ targetKey: 'test', baseUrl: 'http://evaluator.test', evaluatorKey }) })
  scheduler.setBenchmarkEvaluationDispatchFetchForTest(async (input, init) => {
    if (String(input).endsWith('/health')) return new Response(JSON.stringify({ status: 'healthy', busy: false,
      maxConcurrency: 2, evaluators: [{ key: 'swe-bench', ready: true, formalEligible: true }] }))
    const request = JSON.parse(String(init?.body))
    posted.push(request.runId)
    return new Response(JSON.stringify({ runId: request.runId, requestDigest: request.requestDigest, status: 'accepted' }), { status: 202 })
  })
  const ids: string[] = []
  try {
    for (let i = 0; i < 4; i++) {
      const experiment = await prisma.experiment.create({ data: { user: i < 2 ? 'user-a' : 'user-b', name: `quota-${i}`, scope: 'benchmark', status: 'running', cases: { create: { input: 'case' } } }, include: { cases: true } })
      const run = await prisma.benchmarkCaseRun.create({ data: { id: `quota-run-${i}`, experimentId: experiment.id, experimentCaseId: experiment.cases[0].id, ordinal: 0, adapterKey: 'swe-bench', clientId: 'test-client', status: 'submitted' } })
      const id = `quota-evaluation-${i}`
      const request = JSON.stringify({ runId: id, requestDigest: `digest-${i}` })
      await prisma.benchmarkEvaluation.create({ data: { id, caseRunId: run.id, adapterKey: 'swe-bench', evaluatorKey: 'swe-bench', requestJson: request, requestDigest: `digest-${i}`, callbackBaseUrl: 'http://platform.test', timeoutSeconds: 60,
        dispatch: { create: { requestJson: request, requestDigest: `digest-${i}` } } } })
      ids.push(id)
    }
    await Promise.all(ids.map((id) => scheduler.dispatchBenchmarkEvaluation(id)))
    for (let retry = 0; retry < 3 && posted.length < 2; retry++) {
      assert.ok(posted.length <= 2)
      await new Promise((resolve) => setTimeout(resolve, 1100))
      await Promise.all(ids.map((id) => scheduler.dispatchBenchmarkEvaluation(id)))
    }
    const active = await prisma.benchmarkEvaluation.findMany({ where: { status: 'running_evaluator' }, include: { caseRun: { include: { experiment: true } } } })
    assert.equal(active.length, 2)
    assert.deepEqual(active.map((row: any) => row.caseRun.experiment.user).sort(), ['user-a', 'user-b'])
    assert.equal(posted.length, 2)
    assert.equal(await prisma.benchmarkEvaluation.count({ where: { status: 'queued' } }), 2)
    await Promise.all(ids.map((id) => scheduler.dispatchBenchmarkEvaluation(id)))
    assert.equal(posted.length, 2)
    const cancelled = active.find((row: any) => row.caseRun.experiment.user === 'user-a')!
    await prisma.benchmarkEvaluation.update({ where: { id: cancelled.id }, data: { status: 'cancelled' } })
    await prisma.experimentCancellation.create({ data: { id: 'quota-cancellation', user: 'user-a', experimentId: cancelled.caseRun.experimentId,
      targetsJson: JSON.stringify([{ kind: 'evaluation', runId: cancelled.id, baseUrl: 'http://evaluator.test' }]) } })
    const waiting = await prisma.benchmarkEvaluation.findFirst({ where: { status: 'queued', caseRun: { experiment: { user: 'user-a' } } } })
    await prisma.benchmarkEvaluationDispatchOutbox.update({ where: { evaluationId: waiting.id }, data: { nextAttemptAt: new Date(0) } })
    await scheduler.dispatchBenchmarkEvaluation(waiting.id)
    assert.equal(posted.length, 2)
    await prisma.experimentCancellation.update({ where: { id: 'quota-cancellation' }, data: { status: 'completed' } })
    await prisma.benchmarkEvaluationDispatchOutbox.update({ where: { evaluationId: waiting.id }, data: { nextAttemptAt: new Date(0) } })
    await scheduler.dispatchBenchmarkEvaluation(waiting.id)
    assert.equal(posted.length, 3)
  } finally {
    await prisma.experimentCancellation.deleteMany({ where: { id: 'quota-cancellation' } })
    await prisma.experiment.deleteMany({ where: { name: { startsWith: 'quota-' } } })
    scheduler.setBenchmarkEvaluationDispatchFetchForTest()
    scheduler.setEvaluatorTargetResolverForTest()
    delete process.env.AGENT_INSIGHT_BENCHMARK_EVAL_MAX_CONCURRENCY_PER_USER
  }
})

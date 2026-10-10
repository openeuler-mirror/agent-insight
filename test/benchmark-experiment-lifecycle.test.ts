import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { createHash } from 'node:crypto'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-lifecycle-'))
process.env.AGENT_INSIGHT_HOME = root
process.env.DATABASE_URL = `file:${path.join(root, 'test.db')}`
fs.closeSync(fs.openSync(path.join(root, 'test.db'), 'a'))

let prisma: typeof import('../src/lib/storage/prisma').prisma
let lifecycle: typeof import('../src/lib/benchmark/experiment-lifecycle')
let scheduler: typeof import('../src/lib/benchmark/scheduler')
let datasetId: string

test.before(async () => {
  const schema = spawnSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push',
    '--schema', path.resolve('prisma/schema.prisma'), '--skip-generate'], { env: process.env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(schema.status, 0, schema.stderr)
  ;({ prisma } = await import('../src/lib/storage/prisma'))
  lifecycle = await import('../src/lib/benchmark/experiment-lifecycle')
  scheduler = await import('../src/lib/benchmark/scheduler')
  await prisma.agentEvalDataset.create({ data: { id: 'lifecycle-dataset', user: 'fixture-user', name: 'fixture', datasetKind: 'benchmark' } })
  const dataset = await prisma.benchmarkDataset.create({ data: {
    agentEvalDatasetId: 'lifecycle-dataset', user: 'fixture-user', name: 'fixture', adapterKey: 'swe-bench', contentHash: 'fixture',
  } })
  datasetId = dataset.id
})

test.after(async () => {
  await prisma?.$disconnect()
  fs.rmSync(root, { recursive: true, force: true })
})

async function fixture(t: TestContext, cases: Array<{ run: string; result: string }>) {
  const experiment = await prisma.experiment.create({ data: {
    user: 'fixture-user', name: 'fixture', scope: 'benchmark', status: 'running', evaluatorIdsJson: '["benchmark:swe-bench"]',
  } })
  t.after(async () => { await prisma.experiment.delete({ where: { id: experiment.id } }) })
  await prisma.benchmarkExperimentBinding.create({ data: {
    experimentId: experiment.id, datasetId, datasetContentHash: 'fixture', adapterKey: 'swe-bench',
    selectionJson: '{}', runConfigJson: '{"timeoutSeconds":60}', expectedCaseCount: cases.length,
    schedulerStatus: 'running', callbackOrigin: 'http://fixture.invalid',
  } })
  const runIds: string[] = []
  for (const [ordinal, item] of cases.entries()) {
    const c = await prisma.experimentCase.create({ data: { experimentId: experiment.id, input: 'fixture' } })
    const runId = `${experiment.id}-run-${ordinal}`
    await prisma.benchmarkCaseRun.create({ data: {
      id: runId, experimentId: experiment.id, experimentCaseId: c.id, ordinal,
      status: item.run, adapterKey: 'swe-bench', clientId: 'fixture-client',
    } })
    await prisma.experimentEvalResult.create({ data: {
      experimentId: experiment.id, caseId: c.id, evaluatorId: 'benchmark:swe-bench', status: item.result,
      score: item.result === 'done' ? 0 : null,
    } })
    runIds.push(runId)
  }
  return { id: experiment.id, runIds }
}

async function assertStatus(id: string, status: string) {
  assert.equal((await prisma.experiment.findUnique({ where: { id } }))?.status, status)
  assert.equal((await prisma.benchmarkExperimentBinding.findUnique({ where: { experimentId: id } }))?.schedulerStatus, status)
}

for (const scenario of [
  { name: 'the only Case failed', cases: [{ run: 'execution_failed', result: 'failed' }], status: 'failed' },
  { name: 'successful evaluations and execution failures coexist', cases: [{ run: 'evaluated', result: 'done' }, { run: 'execution_failed', result: 'failed' }], status: 'partial' },
  { name: 'evaluation completed with a zero score', cases: [{ run: 'evaluated', result: 'done' }], status: 'done' },
  { name: 'a Case is still executing', cases: [{ run: 'running_agent', result: 'failed' }], status: 'running' },
  { name: 'evaluation is still pending', cases: [{ run: 'evaluated', result: 'pending' }], status: 'running' },
]) {
  test(`Benchmark settles when ${scenario.name}`, async (t) => {
    const f = await fixture(t, scenario.cases)
    await lifecycle.settleBenchmarkExperimentStatus(f.id)
    await assertStatus(f.id, scenario.status)
  })
}

test('a queued retry supersedes the previous failure and keeps the experiment running', async (t) => {
  const f = await fixture(t, [{ run: 'execution_failed', result: 'failed' }])
  const oldRun = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: f.runIds[0] } })
  await prisma.benchmarkCaseRun.create({ data: {
    id: `${f.id}-retry`, experimentId: f.id, experimentCaseId: oldRun.experimentCaseId,
    retryOfRunId: oldRun.id, ordinal: 0, status: 'pending', adapterKey: 'swe-bench', clientId: 'fixture-client',
  } })
  await lifecycle.settleBenchmarkExperimentStatus(f.id)
  await assertStatus(f.id, 'running')
})

for (const status of ['failed', 'partial', 'done']) {
  test(`automatic scheduling cannot restart an experiment that just became ${status}`, async (t) => {
    const f = await fixture(t, [{ run: 'execution_failed', result: 'failed' }])
    await prisma.experiment.update({ where: { id: f.id }, data: { status } })
    await prisma.benchmarkExperimentBinding.update({ where: { experimentId: f.id }, data: { schedulerStatus: status } })
    const result = await scheduler.startBenchmarkExperiment({
      experimentId: f.id, user: 'fixture-user', publicCallbackOrigin: 'http://fixture.invalid',
      executorCallbackOrigin: 'http://fixture.invalid', resumeOnly: true,
    })
    assert.equal(result, null)
    await assertStatus(f.id, status)
  })
}

test('automatic continuation settles the last failure before trying to refill', async (t) => {
  const f = await fixture(t, [{ run: 'execution_failed', result: 'failed' }])
  await lifecycle.continueExperiment(f.id)
  await assertStatus(f.id, 'failed')
})

test('background recovery repairs a stale running experiment whose Case already failed', async (t) => {
  const f = await fixture(t, [{ run: 'execution_failed', result: 'failed' }])
  assert.equal(await scheduler.resumeBenchmarkDispatchesAtStartup(), 0)
  await assertStatus(f.id, 'failed')
})

for (const legacy of [false, true]) {
  test(`MCTS failure links its exact coordinator Trace with ${legacy ? 'legacy OTLP hash' : 'session ID'}`, async (t) => {
    const f = await fixture(t, [{ run: 'execution_failed', result: 'failed' }])
    const sessionId = `mcts.run.${(legacy ? 'b' : 'a').repeat(32)}`
    const traceId = legacy ? createHash('sha256').update(`mcts-xgovernor\u001f${sessionId}`).digest('hex').slice(0, 32) : sessionId
    const execution = await prisma.execution.create({ data: {
      taskId: sessionId, framework: 'mcts-xgovernor', agentName: 'mcts-coordinator', user: 'fixture-user',
    } })
    t.after(async () => { await prisma.execution.delete({ where: { id: execution.id } }) })
    const run = await prisma.benchmarkCaseRun.update({ where: { id: f.runIds[0] }, data: { runFactsJson: JSON.stringify({ traceId }) } })
    if (legacy) {
      const { findBenchmarkExecution } = await import('../src/lib/benchmark/trace-reference')
      assert.equal(await findBenchmarkExecution('other-user', traceId), null)
      assert.equal(await findBenchmarkExecution('fixture-user', 'f'.repeat(32)), null)
      await prisma.experiment.update({ where: { id: f.id }, data: {
        agentName: 'pi-mcts', configSnapshotJson: '{"runConfig":{"platform":"pi-mcts","agent":"pi-mcts"}}',
      } })
      await prisma.experimentCase.update({ where: { id: run.experimentCaseId }, data: { taskId: traceId } })
      const { GET } = await import('../src/app/api/experiments/[id]/route')
      const response = await GET(new Request(`http://fixture.invalid/api/experiments/${f.id}?user=fixture-user`),
        { params: Promise.resolve({ id: f.id }) })
      assert.equal(response.status, 200)
      const detail = await response.json()
      assert.equal(detail.agentName, 'mcts-coordinator')
      assert.equal(detail.reusableConfig.agentName, 'mcts-coordinator')
      assert.equal(detail.reusableConfig.executionTarget.platform, 'pi-mcts')
      assert.equal(detail.cases[0].taskId, sessionId)
      assert.equal(detail.cases[0].executionId, execution.id)
      assert.equal((await prisma.experimentCase.findUniqueOrThrow({ where: { id: run.experimentCaseId } })).taskId, traceId)
    }
    await lifecycle.finalizeBenchmarkCase({ caseRunId: run.id, runSupplementalEvaluators: false, continueCases: false })
    const c = await prisma.experimentCase.findUniqueOrThrow({ where: { id: run.experimentCaseId } })
    assert.equal(c.taskId, sessionId)
    assert.equal(c.executionId, execution.id)
  })
}

test('MCTS interrupted Trace is failed in SQL filtering and aggregate counts', async (t) => {
  const taskId = 'mcts.run.' + 'c'.repeat(32)
  const execution = await prisma.execution.create({ data: {
    user: 'fixture-user', taskId, framework: 'mcts-xgovernor',
    failures: JSON.stringify([{ failure_type: 'agent-process-exit', context: '{"signal":"SIGINT"}' }]),
  } })
  const session = await prisma.session.create({ data: { taskId, endTime: new Date() } })
  t.after(async () => {
    await prisma.session.delete({ where: { id: session.id } })
    await prisma.execution.delete({ where: { id: execution.id } })
  })
  const { selectComputedRecordPage } = await import('../src/lib/storage/computed-record-page')
  const { aggregateExecutionList } = await import('../src/lib/storage/execution-list-sql')
  const where = { id: execution.id, user: 'fixture-user' }
  const page = await selectComputedRecordPage(where, { status: 'failed', anomaly: 'all', sortKey: 'status', sortDir: 'asc', page: 1, pageSize: 20 })
  assert.deepEqual(page.ids, [execution.id])
  assert.equal(page.total, 1)
  assert.equal(page.stats.failedCount, 1)
  assert.equal((await aggregateExecutionList(where)).failedCount, 1)
})

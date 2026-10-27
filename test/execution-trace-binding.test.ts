import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createIsolatedDatabase } from './helpers/isolated-database'

const database = createIsolatedDatabase()
const { prisma } = require('@/lib/storage/prisma') as typeof import('@/lib/storage/prisma')
const { applyCommandStatus } = require('@/lib/reliability/command-bus') as typeof import('@/lib/reliability/command-bus')
const { loadCaseExecutionProgress } = require('@/lib/engine/experiment/execution-progress-service') as typeof import('@/lib/engine/experiment/execution-progress-service')
const { recordBenchmarkRunProgress, completeBenchmarkRun } = require('@/lib/benchmark/run-callback-service') as typeof import('@/lib/benchmark/run-callback-service')
const { GET } = require('@/app/api/experiments/[id]/route') as typeof import('@/app/api/experiments/[id]/route')

test.after(async () => { await prisma.$disconnect(); database.dispose() })
const user = 'trace-binding-fixture'
const clientId = 'trace-binding-client'
test.before(async () => { await prisma.reliabilityClient.create({ data: { clientId, user, name: 'fixture', lastSeenAt: new Date() } }) })

async function fixture(scope = '') {
  const experiment = await prisma.experiment.create({ data: { user, name: 'fixture', scope, status: 'running', evaluatorIdsJson: '[]', cases: { create: { input: 'run' } } }, include: { cases: true } })
  return { experimentId: experiment.id, caseId: experiment.cases[0].id }
}
async function ordinary(f: Awaited<ReturnType<typeof fixture>>, attemptNo: number) {
  const id = randomUUID(), commandId = randomUUID()
  await prisma.reliabilityCommand.create({ data: { commandId, clientId, user, action: 'RUN_EXPERIMENT_CASE', status: 'RUNNING', expiresAt: new Date(Date.now() + 600000), payloadJson: JSON.stringify({ correlation: { experimentId: f.experimentId, caseRunId: f.caseId, traceAttemptId: id } }) } })
  return prisma.experimentTraceAttempt.create({ data: { ...f, id, attemptNo, commandId, workerId: clientId, platform: 'opencode', agent: 'build', status: 'running' } })
}
async function benchmark(f: Awaited<ReturnType<typeof fixture>>, retryOfRunId?: string) {
  return prisma.benchmarkCaseRun.create({ data: { id: randomUUID(), experimentId: f.experimentId, experimentCaseId: f.caseId, ordinal: 0, adapterKey: 'swe-bench', clientId, status: 'running_agent', retryOfRunId } })
}
async function root(traceId: string) {
  return prisma.execution.create({ data: { user, taskId: traceId, agentName: 'build', timestamp: new Date(), isSubagent: false } })
}
const receipt = (commandId: string, traceId: string) => applyCommandStatus({ commandId, clientId, status: 'RUNNING', result: { state: 'TRACE_STARTED', traceId } })
const progress = (runId: string, stage: 'preparing' | 'agent_running' | 'collecting' | 'uploading' | 'cleaning', traceId?: string, occurredAt = new Date().toISOString()) => recordBenchmarkRunProgress({ runId, clientId, progress: { kind: 'execution', stage, occurredAt, progress: { ...(traceId ? { traceId } : {}), message: stage } } })
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected

test('普通实验在命令结束前绑定根链路，缺少入库记录时保留上传状态', async () => {
  const f = await fixture(), attempt = await ordinary(f, 1)
  await receipt(attempt.commandId!, 'ordinary-live')
  let snapshot = (await loadCaseExecutionProgress(f.experimentId, user, [f.caseId], [] as string[])).get(f.caseId)!
  assert.equal(snapshot.progress.traceId, 'ordinary-live')
  assert.equal(snapshot.executionId, null)
  assert.equal(snapshot.progress.stage, 1)
  const execution = await root('ordinary-live')
  snapshot = (await loadCaseExecutionProgress(f.experimentId, user, [f.caseId], [])).get(f.caseId)!
  assert.equal(snapshot.executionId, execution.id)
  assert.equal(snapshot.progress.status, 'running')
  assert.equal((await prisma.reliabilityCommand.findUnique({ where: { commandId: attempt.commandId! } }))?.status, 'RUNNING')
})

test('普通实验同轮绑定幂等、冲突不可覆盖，终态不回退', async () => {
  const f = await fixture(), attempt = await ordinary(f, 1)
  await Promise.all([receipt(attempt.commandId!, 'ordinary-fixed'), receipt(attempt.commandId!, 'ordinary-fixed')])
  await assert.rejects(receipt(attempt.commandId!, 'ordinary-conflict'), code('TRACE_ID_CONFLICT'))
  await applyCommandStatus({ commandId: attempt.commandId!, clientId, status: 'SUCCEEDED', result: { state: 'AGENT_EXITED', exitCode: 0 } })
  await receipt(attempt.commandId!, 'ordinary-late')
  const command = await prisma.reliabilityCommand.findUniqueOrThrow({ where: { commandId: attempt.commandId! } })
  assert.equal(command.status, 'SUCCEEDED')
  assert.equal(JSON.parse(command.resultJson!).traceId, 'ordinary-fixed')
  assert.equal((await prisma.experimentTraceAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).traceId, 'ordinary-fixed')
})

test('普通实验重试后丢弃旧轮绑定，拒绝复用历史 ID，迟到入库不能带回旧链路', async () => {
  const f = await fixture(), old = await ordinary(f, 1)
  await receipt(old.commandId!, 'ordinary-old')
  await prisma.experimentTraceAttempt.update({ where: { id: old.id }, data: { status: 'failed' } })
  const next = await ordinary(f, 2)
  await root('ordinary-old')
  await receipt(old.commandId!, 'ordinary-old')
  let snapshot = (await loadCaseExecutionProgress(f.experimentId, user, [f.caseId], [])).get(f.caseId)!
  assert.equal(snapshot.progress.identity, next.id)
  assert.equal(snapshot.progress.traceId, null)
  assert.equal(snapshot.executionId, null)
  await assert.rejects(receipt(next.commandId!, 'ordinary-old'), code('TRACE_ID_REUSED'))
  await receipt(next.commandId!, 'ordinary-new')
  snapshot = (await loadCaseExecutionProgress(f.experimentId, user, [f.caseId], [])).get(f.caseId)!
  assert.equal(snapshot.progress.traceId, 'ordinary-new')
  assert.equal(snapshot.progress.stage, 1)
})

test('Benchmark 乱序阶段回调可补链路，但进度和当前阶段时钟不回退', async () => {
  const f = await fixture('benchmark'), run = await benchmark(f)
  const later = new Date(Date.now() + 1000).toISOString()
  await progress(run.id, 'collecting', undefined, later)
  await progress(run.id, 'agent_running', 'benchmark-live', new Date(0).toISOString())
  await progress(run.id, 'preparing', undefined, later)
  const stored = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(stored.status, 'collecting')
  assert.equal(JSON.parse(stored.progressJson!).stage, 'collecting')
  assert.equal(JSON.parse(stored.runFactsJson!).traceId, 'benchmark-live')
  assert.equal(JSON.parse(stored.progressJson!).progress.traceId, 'benchmark-live')
  assert.equal(JSON.parse(stored.progressJson!).occurredAt, later)
  await assert.rejects(progress(run.id, 'cleaning', 'benchmark-conflict'), code('TRACE_ID_CONFLICT'))
  assert.equal((await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: run.id } })).status, 'collecting')
})

test('Benchmark 并发重复回调与完成回调保持唯一绑定且终态不可回退', async () => {
  const f = await fixture('benchmark'), run = await benchmark(f)
  await Promise.all([progress(run.id, 'agent_running', 'benchmark-fixed'), progress(run.id, 'collecting', 'benchmark-fixed')])
  const completion = { kind: 'execution' as const, status: 'failed' as const, artifacts: [], runFacts: { exitCode: 1 }, cleanup: { status: 'succeeded' }, error: { code: 'AGENT_FAILED', message: 'fixture failure' } }
  await completeBenchmarkRun({ runId: run.id, clientId, completion })
  await progress(run.id, 'agent_running', 'benchmark-fixed')
  let stored = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(stored.status, 'execution_failed')
  assert.equal(JSON.parse(stored.runFactsJson!).traceId, 'benchmark-fixed')
  await assert.rejects(progress(run.id, 'agent_running', 'benchmark-changed'), code('TRACE_ID_CONFLICT'))
  stored = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(stored.status, 'execution_failed')
})

test('Benchmark 重试隐藏历史链接，旧回调和迟到失败不能覆盖新轮 Case', async () => {
  const f = await fixture('benchmark'), old = await benchmark(f)
  await progress(old.id, 'agent_running', 'benchmark-old')
  const oldRoot = await root('benchmark-old')
  await prisma.benchmarkCaseRun.update({ where: { id: old.id }, data: { status: 'execution_failed' } })
  await prisma.experimentCase.update({ where: { id: f.caseId }, data: { taskId: 'benchmark-old', executionId: oldRoot.id } })
  const next = await benchmark(f, old.id)
  await prisma.experimentEvalResult.create({ data: { experimentId: f.experimentId, caseId: f.caseId, evaluatorId: 'fixture', status: 'pending' } })
  await progress(old.id, 'agent_running', 'benchmark-old')
  const { failBenchmarkCaseResults } = require('@/lib/benchmark/experiment-lifecycle') as typeof import('@/lib/benchmark/experiment-lifecycle')
  await failBenchmarkCaseResults(old.id, 'late failure')
  let response = await GET(new Request(`http://localhost/api/experiments/${f.experimentId}?user=${user}`), { params: Promise.resolve({ id: f.experimentId }) })
  assert.equal(response.status, 200)
  let current = (await response.json()).cases[0]
  assert.equal(current.benchmark.runId, next.id)
  assert.equal(current.taskId, null)
  assert.equal(current.executionId, null)
  assert.equal((await prisma.experimentEvalResult.findFirstOrThrow({ where: { caseId: f.caseId } })).status, 'pending')
  await assert.rejects(progress(next.id, 'agent_running', 'benchmark-old'), code('TRACE_ID_REUSED'))
  await progress(next.id, 'agent_running', 'benchmark-new')
  const newRoot = await root('benchmark-new')
  response = await GET(new Request(`http://localhost/api/experiments/${f.experimentId}?user=${user}`), { params: Promise.resolve({ id: f.experimentId }) })
  current = (await response.json()).cases[0]
  assert.equal(current.benchmark.executionId, newRoot.id)
  assert.equal(current.taskId, 'benchmark-new')
  assert.equal(current.benchmark.progressStage, 'agent_running')
})

test('不同客户端不能提前绑定 Benchmark 链路', async () => {
  const f = await fixture('benchmark'), run = await benchmark(f)
  await assert.rejects(recordBenchmarkRunProgress({ runId: run.id, clientId: 'other', progress: { kind: 'execution', stage: 'agent_running', occurredAt: new Date().toISOString(), progress: { traceId: 'foreign' } } }), code('RUN_CLIENT_MISMATCH'))
})

test('Benchmark 并发不同根只能首次绑定一个，随后进度与完成竞争不能覆盖终态', async () => {
  const f = await fixture('benchmark'), run = await benchmark(f)
  const results = await Promise.allSettled([progress(run.id, 'agent_running', 'concurrent-a'), progress(run.id, 'agent_running', 'concurrent-b')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'TRACE_ID_CONFLICT').length, 1)
  const bound = JSON.parse((await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: run.id } })).runFactsJson!).traceId
  await Promise.all([
    progress(run.id, 'agent_running', bound),
    completeBenchmarkRun({ runId: run.id, clientId, completion: { kind: 'execution', status: 'failed', runFacts: {}, artifacts: [], cleanup: { status: 'succeeded' }, error: { code: 'FAILED', message: 'fixture' } } }),
  ])
  const stored = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(stored.status, 'execution_failed')
  assert.equal(JSON.parse(stored.runFactsJson!).traceId, bound)
})

test('Benchmark 终态之后补根引用不更改阶段、完成时间或终态', async () => {
  const f = await fixture('benchmark'), run = await benchmark(f)
  const ended = new Date()
  await prisma.benchmarkCaseRun.update({ where: { id: run.id }, data: { status: 'execution_failed', finishedAt: ended, progressJson: JSON.stringify({ kind: 'execution', stage: 'collecting', occurredAt: ended.toISOString() }) } })
  await progress(run.id, 'agent_running', 'late-terminal-root')
  const stored = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(stored.status, 'execution_failed')
  assert.equal(stored.finishedAt?.getTime(), ended.getTime())
  assert.equal(JSON.parse(stored.progressJson!).stage, 'collecting')
  assert.equal(JSON.parse(stored.runFactsJson!).traceId, 'late-terminal-root')
})

test('旧轮在重试开始后才首次上报，只能补自己的根，新轮不得复用', async () => {
  const f = await fixture(), old = await ordinary(f, 1)
  const next = await ordinary(f, 2)
  await receipt(old.commandId!, 'first-late-old-root')
  assert.equal((await prisma.experimentTraceAttempt.findUniqueOrThrow({ where: { id: old.id } })).traceId, 'first-late-old-root')
  assert.equal((await prisma.experimentTraceAttempt.findUniqueOrThrow({ where: { id: next.id } })).traceId, null)
  await assert.rejects(receipt(next.commandId!, 'first-late-old-root'), code('TRACE_ID_REUSED'))
})

test('过期指令回执返回错误后仍持久化 EXPIRED，迟到状态不能复活它', async () => {
  const f = await fixture(), attempt = await ordinary(f, 1)
  await prisma.reliabilityCommand.update({ where: { commandId: attempt.commandId! }, data: { expiresAt: new Date(0) } })
  await assert.rejects(receipt(attempt.commandId!, 'expired-root'), code('COMMAND_EXPIRED'))
  await receipt(attempt.commandId!, 'expired-root')
  const command = await prisma.reliabilityCommand.findUniqueOrThrow({ where: { commandId: attempt.commandId! } })
  assert.equal(command.status, 'EXPIRED')
  assert.equal(command.resultJson, null)
})

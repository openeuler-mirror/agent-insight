import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

let prisma: typeof import('@/lib/storage/prisma')['prisma']
let fi: typeof import('@/lib/engine/experiment/fi-orchestrate')
let detail: typeof import('@/app/api/experiments/[id]/route')['GET']
let store: typeof import('@/lib/fault-injection/store')
let root: string
let sequence = 0
const user = 'fi-readiness-' + process.pid

test.before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'fi-trace-readiness-'))
  process.env.AGENT_INSIGHT_HOME = root
  process.env.DATABASE_URL = 'file:' + path.join(root, 'test.db')
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' })
  ;({ prisma } = await import('@/lib/storage/prisma'))
  store = await import('@/lib/fault-injection/store')
  fi = await import('@/lib/engine/experiment/fi-orchestrate')
  ;({ GET: detail } = await import('@/app/api/experiments/[id]/route'))
})
test.after(async () => {
  await prisma?.$disconnect()
  if (root) rmSync(root, { recursive: true, force: true })
})

/** Build real FI/Case records without executing any model or worker. */
async function fixture(status = 'queued', agent = 'build', messages?: unknown[]) {
  const tag = String(++sequence)
  const experiment = await prisma.experiment.create({ data: {
    user, name: 'FI regression ' + tag, agentName: 'build', status: 'partial',
    evaluatorIdsJson: '["preset-ras-reliability-detection-recovery"]',
    configSnapshotJson: JSON.stringify({ traceSource: 'generate', fiOrchestrate: true }),
  } })
  const taskId = messages ? 'ses_fixture_' + tag : null
  const run = await prisma.faultInjectionRun.create({ data: {
    user, runId: 'ras-fi-readiness-' + tag, platform: 'opencode',
    agent: 'build', fault: 'thinking-dead-loop', status, sessionTaskId: taskId,
  } })
  const row = await prisma.experimentCase.create({ data: {
    experimentId: experiment.id, input: 'Review target.py', fiRunId: run.runId,
    faultInjectionType: 'thinking-dead-loop', taskId,
  } })
  if (taskId) {
    await prisma.execution.create({ data: { user, taskId, agentName: agent, framework: 'opencode', isSubagent: false } })
    await prisma.session.create({ data: { user, taskId, interactions: JSON.stringify(messages), endTime: new Date() } })
  }
  return { experiment, run, row }
}

test('FI traces require the requested business agent and a substantive response', () => {
  const base = { platform: 'opencode', agent: 'build', executionAgent: 'build', endTime: new Date() }
  assert.equal(fi.isFiBusinessTraceUsable({ ...base, interactions: '[{"role":"user","content":"prompt"}]' }), false)
  assert.equal(fi.isFiBusinessTraceUsable({ ...base, interactions: '[{"role":"assistant","content":""}]' }), false)
  assert.equal(fi.isFiBusinessTraceUsable({ ...base, interactions: '[{"role":"assistant","content":"done"}]', executionAgent: 'ras-judge' }), false)
  assert.equal(fi.isFiBusinessTraceUsable({ ...base, interactions: '[{"role":"assistant","content":"done"}]', endTime: null }), false)
  assert.equal(fi.isFiBusinessTraceUsable({ ...base, interactions: '[{"role":"assistant","content":"done"}]' }), true)
  assert.equal(fi.isFiBusinessTraceUsable({ ...base, interactions: '[{"role":"assistant","tool_calls":[{"id":"call1"}]}]' }), true)
  assert.equal(fi.isFiBusinessTraceUsable({ ...base, platform: 'xiaoo', agent: 'defaultagent', executionAgent: 'xiaoo', interactions: '[{"role":"assistant","content":"done"}]' }), true)
})
test('internal reviewer sessions cannot bind a business Case or appear ready in the detail API', async () => {
  const data = await fixture('completed', 'ras-judge', [{ role: 'assistant', content: 'internal verdict' }])
  assert.equal(await fi.bindExperimentCaseToFiSession({ fiRunKey: data.run.runId, sessionTaskId: data.run.sessionTaskId! }), 0)
  const response = await detail(new Request('http://localhost/api/experiments/' + data.experiment.id + '?user=' + user), { params: Promise.resolve({ id: data.experiment.id }) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.traceProgress.ready, 0)
  assert.equal(body.traceProgress.failed, 1)
})
test('queued and collecting FI Cases remain pending even when the experiment was partial', async () => {
  for (const status of ['queued', 'collecting']) {
    const data = await fixture(status)
    const response = await detail(new Request('http://localhost/api/experiments/' + data.experiment.id + '?user=' + user), { params: Promise.resolve({ id: data.experiment.id }) })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.traceProgress.pending, 1)
    assert.equal(body.traceProgress.failed, 0)
    assert.equal(body.status, 'running')
  }
})
test('queued work may complete after the initial collection window and still binds', async () => {
  const data = await fixture('queued')
  const timer = setTimeout(() => {
    void (async () => {
      const taskId = 'ses_late_batch'
      await prisma.execution.create({ data: { user, taskId, agentName: 'build', framework: 'opencode' } })
      await prisma.session.create({ data: { user, taskId, interactions: '[{"role":"assistant","content":"late result"}]', endTime: new Date() } })
      await prisma.faultInjectionRun.update({ where: { id: data.run.id }, data: { status: 'completed', sessionTaskId: taskId } })
    })()
  }, 5300)
  try {
    const result = await fi.awaitFiSessionsAndBindExperimentCases({
      runIds: [data.run.runId], timeoutMs: 5000, pollMs: 50, waitForActiveRuns: true,
    })
    assert.deepEqual(result.readyRunIds, [data.run.runId])
    assert.deepEqual(result.pendingRunIds, [])
    const bound = await prisma.experimentCase.findUniqueOrThrow({ where: { id: data.row.id } })
    assert.ok(bound.executionId)
  } finally { clearTimeout(timer) }
})
test('terminal empty traces stop waiting after grace, and cancellation ends active waits', async () => {
  const data = await fixture('completed', 'build', [{ role: 'user', content: 'only prompt' }])
  const result = await fi.awaitFiSessionsAndBindExperimentCases({ runIds: [data.run.runId], waitForActiveRuns: true, traceWaitMs: 0 })
  assert.deepEqual(result.failedRunIds, [data.run.runId])
  const queued = await fixture('queued')
  const cancelled = await fi.awaitFiSessionsAndBindExperimentCases({ runIds: [queued.run.runId], waitForActiveRuns: true, shouldContinue: async () => false })
  assert.deepEqual(cancelled.pendingRunIds, [queued.run.runId])
})

test('collection completes but binds only valid business traces', async () => {
  for (const [agent, messages, expected] of [
    ['ras-judge', [{ role: 'assistant', content: 'internal verdict' }], false],
    ['build', [{ role: 'user', content: 'prompt only' }], false],
    ['build', [{ role: 'assistant', content: 'business response' }], true],
  ] as const) {
    const data = await fixture('collecting', agent, [...messages])
    await prisma.experimentCase.update({ where: { id: data.row.id }, data: { taskId: null } })
    const collected = await store.persistFiCollectIngress({ runId: data.run.runId, user, payload: {
      runId: data.run.runId, taskId: data.run.sessionTaskId!, framework: 'opencode',
      fault: 'thinking-dead-loop', injectionMethod: 'skill_inject',
      faultActivated: true, interactions: [], markers: [],
    } })
    assert.equal(collected.status, 'completed')
    assert.equal(collected.judgedAt, null)
    const row = await prisma.experimentCase.findUniqueOrThrow({ where: { id: data.row.id } })
    assert.equal(Boolean(row.executionId), expected)
  }
})

test('terminal empty FI traces fail after uploader grace even while the parent remains running', async () => {
  for (const status of ['judge_skipped', 'completed']) {
    const data = await fixture(status, 'build', [{ role: 'user', content: 'no response' }])
    await prisma.experiment.update({ where: { id: data.experiment.id }, data: { status: 'running' } })
    await prisma.faultInjectionRun.update({ where: { id: data.run.id },
      data: { updatedAt: new Date(Date.now() - 240_000) } })
    const response = await detail(new Request('http://localhost/api/experiments/' + data.experiment.id + '?user=' + user),
      { params: Promise.resolve({ id: data.experiment.id }) })
    const body = await response.json()
    assert.equal(body.traceProgress.failed, 1)
    assert.equal(body.traceProgress.pending, 0)
  }
})

test('finished FI batches persist generation failures and settle as partial alongside completed evaluations', async () => {
  const good = await fixture('completed', 'build', [{ role: 'assistant', content: 'valid response' }])
  const bad = await fixture('judge_skipped', 'build', [{ role: 'user', content: 'empty' }])
  await prisma.experimentCase.update({ where: { id: bad.row.id }, data: { experimentId: good.experiment.id } })
  const bound = await fi.awaitFiSessionsAndBindExperimentCases({
    runIds: [good.run.runId, bad.run.runId], waitForActiveRuns: true, traceWaitMs: 0,
  })
  assert.deepEqual(bound.failedRunIds, [bad.run.runId])
  const failed = await prisma.experimentCase.findUniqueOrThrow({ where: { id: bad.row.id } })
  assert.ok(failed.traceGenerationError)
  await prisma.experimentEvalResult.create({ data: {
    experimentId: good.experiment.id, caseId: good.row.id,
    evaluatorId: 'preset-ras-reliability-detection-recovery', status: 'done', score: 50,
  } })
  const { settleExperimentStatus } = await import('@/lib/engine/experiment/run-experiment')
  await settleExperimentStatus(good.experiment.id)
  assert.equal((await prisma.experiment.findUniqueOrThrow({ where: { id: good.experiment.id } })).status, 'partial')
  const response = await detail(new Request('http://localhost/api/experiments/' + good.experiment.id + '?user=' + user),
    { params: Promise.resolve({ id: good.experiment.id }) })
  const body = await response.json()
  assert.equal(body.status, 'partial')
  assert.equal(body.traceProgress.failed, 1)
  assert.equal(body.overall, 50)
})


test('an existing pending FI evaluation starts and settles without rerunning its Agent', async () => {
  const data = await fixture('completed', 'build', [{ role: 'assistant', content: 'business output' }])
  await fi.bindExperimentCaseToFiSession({ fiRunKey: data.run.runId, sessionTaskId: data.run.sessionTaskId! })
  const row = await prisma.experimentEvalResult.create({ data: {
    experimentId: data.experiment.id, caseId: data.row.id,
    evaluatorId: 'preset-ras-reliability-detection-recovery', status: 'pending',
  } })
  const { setJudgeLlmCallerForTest } = await import('@/lib/engine/experiment/judge-llm')
  const { retryResultRow } = await import('@/lib/engine/experiment/run-experiment')
  setJudgeLlmCallerForTest(async () => JSON.stringify({
    summary: 'test evidence', faultOccurred: { verdict: 'met', reason: 'observed', suggestion: '' },
    dimensions: ['fault_detected', 'mitigation_triggered', 'fault_mitigated'].map(dimension => ({
      dimension, verdict: 'met', reason: 'observed', suggestion: '',
    })),
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      retryResultRow(data.experiment.id, row.id, user),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('pending evaluator did not start')), 2500) }),
    ])
    assert.equal(result, 'done')
  } finally {
    clearTimeout(timer)
    setJudgeLlmCallerForTest(null)
  }
})


test('a startup failure survives client collection, upload, and business Trace failure reporting', async () => {
  const data = await fixture('collecting')
  const artifacts = path.join(root, 'artifacts', data.run.runId)
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(path.join(artifacts, 'collect-result.json'), JSON.stringify({
    runId: data.run.runId, taskId: null, sessionAligned: false, faultActivated: false, interactions: [], markers: [],
  }))
  writeFileSync(path.join(artifacts, 'manifest.json'), JSON.stringify({
    status: 'failed', termination_reason: 'plugin_start_failed',
    error: 'PluginStartupError: plugin did not become ready; api_key=sk-fi-test-secret-value',
  }))
  const { readCollectResult } = createRequire(import.meta.url)('../scripts/reliability-client.cjs')
  const payload = readCollectResult(path.join(root, 'artifacts'), data.run.runId)
  assert.match(payload.error, /^plugin_start_failed:/)
  assert.doesNotMatch(payload.error, /sk-fi-test-secret-value/)
  const apiKey = 'fi-startup-error-api-key'
  await prisma.user.create({ data: { username: user, apiKey } })
  const { POST } = await import('@/app/api/fault-injection/runs/[runId]/collect-result/route')
  const response = await POST(new Request('http://localhost/api/fault-injection/runs/' + data.run.runId + '/collect-result', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-witty-api-key': apiKey },
    body: JSON.stringify(payload),
  }), { params: Promise.resolve({ runId: data.run.runId }) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).status, 'failed')
  const saved = await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: data.run.id } })
  assert.match(saved.error || '', /^plugin_start_failed:/)
  assert.doesNotMatch(saved.error || '', /session_unaligned/)
  await fi.awaitFiSessionsAndBindExperimentCases({ runIds: [data.run.runId], traceWaitMs: 0 })
  const failedCase = await prisma.experimentCase.findUniqueOrThrow({ where: { id: data.row.id } })
  assert.match(failedCase.traceGenerationError || '', /^plugin_start_failed:/)
  assert.equal(await prisma.experimentEvalResult.count({ where: { experimentId: data.experiment.id } }), 0)
})

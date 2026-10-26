import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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

test('collect ingress and FI judge both reject internal sessions and prompt-only traces', async () => {
  process.env.FI_JUDGE_SESSION_WAIT_MS = '0'
  try {
    for (const [agent, messages, expected] of [
      ['ras-judge', [{ role: 'assistant', content: 'internal verdict' }], false],
      ['build', [{ role: 'user', content: 'prompt only' }], false],
      ['build', [{ role: 'assistant', content: 'business response' }], true],
    ] as const) {
      const data = await fixture('collecting', agent, [...messages])
      await prisma.experimentCase.update({ where: { id: data.row.id }, data: { taskId: null } })
      await store.persistFiCollectIngress({ runId: data.run.runId, user, payload: {
        runId: data.run.runId, taskId: data.run.sessionTaskId!, framework: 'opencode',
        fault: 'thinking-dead-loop', injectionMethod: 'skill_inject',
        faultActivated: true, interactions: [], markers: [],
      } })
      const row = await prisma.experimentCase.findUniqueOrThrow({ where: { id: data.row.id } })
      assert.equal(Boolean(row.executionId), expected)
      const loaded = await store.loadPersistedFiCollectForJudge(data.run.runId)
      assert.equal(loaded.sessionTraceReady, expected)
      assert.equal(loaded.interactions.length > 0, expected)
    }
  } finally { delete process.env.FI_JUDGE_SESSION_WAIT_MS }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptCaseProgress, caseExecutionTraceHref, type CaseExecutionProgress } from '@/lib/engine/experiment/execution-progress'

function snapshot(overrides: Partial<CaseExecutionProgress> = {}): CaseExecutionProgress {
  return { identity: 'attempt-2', attemptNo: 2, generation: 2000, revision: 2100, evaluationVersion: 0,
    source: 'generated', stage: 1, status: 'running', label: 'Agent 执行中', startedAt: new Date(2000).toISOString(),
    finishedAt: null, updatedAt: new Date(2100).toISOString(), traceId: null, executionId: null, error: null, evaluators: [], ...overrides }
}

test('迟到的旧轮次、旧快照和阶段回退均不能覆盖当前执行', () => {
  const current = snapshot({ stage: 2, executionId: 'root-2' })
  for (const stale of [snapshot({ identity: 'attempt-1', attemptNo: 1, generation: 1000, stage: 4, status: 'done' }),
    snapshot({ revision: 2001, stage: 2 }), snapshot({ revision: 2200, stage: 1 })]) {
    assert.equal(acceptCaseProgress(current, stale), current)
  }
  const next = snapshot({ identity: 'attempt-3', attemptNo: 3, generation: 1000, stage: 0, status: 'waiting' })
  assert.equal(acceptCaseProgress(current, next), next, '轮次比本机时钟更可靠')
})

test('终态不能变回运行态，显式重评可以回到评测阶段但保持执行身份', () => {
  const current = snapshot({ stage: 4, status: 'done', evaluationVersion: 1 })
  assert.equal(acceptCaseProgress(current, snapshot({ revision: 2200, stage: 3, evaluationVersion: 1 })), current)
  const retry = snapshot({ revision: 2201, stage: 3, evaluationVersion: 2 })
  assert.equal(acceptCaseProgress(current, retry), retry)
  assert.equal(acceptCaseProgress(retry, current), retry)
})

test('链路入口锁定 executionId；缺少记录时不按 taskId 猜测跳转', () => {
  assert.equal(caseExecutionTraceHref({ executionId: null, traceId: 'old-session' }), null)
  const href = caseExecutionTraceHref({ executionId: 'root/2', traceId: 'session&2' })!
  const url = new URL(href, 'http://fixture.invalid')
  assert.equal(url.searchParams.get('executionId'), 'root/2')
  assert.equal(url.searchParams.get('taskId'), 'session&2')
})

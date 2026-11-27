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

test('同一轮新快照缺少链路时保留已绑定链路，不允许切换到其他根', () => {
  const current = snapshot({ traceId: 'session-2', executionId: 'root-2' })
  const missing = snapshot({ revision: 2200 })
  const accepted = acceptCaseProgress(current, missing)
  assert.equal(accepted.traceId, 'session-2')
  assert.equal(accepted.executionId, 'root-2')
  assert.equal(acceptCaseProgress(current, snapshot({ revision: 2200, traceId: 'another' })), current)
  const retry = snapshot({ identity: 'attempt-3', attemptNo: 3, stage: 0 })
  assert.equal(acceptCaseProgress(current, retry).traceId, null)
})

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
import { benchmarkExecutionProgress, type BenchmarkProgressInput } from '@/lib/benchmark/execution-progress'

const now = Date.parse('2026-10-26T06:10:00Z')
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
function fixture(overrides: Partial<BenchmarkProgressInput> = {}): BenchmarkProgressInput {
  return {
    runStatus: 'running_agent', progressStage: 'agent_running', evaluationStatus: null,
    progressDetails: {
      createdAt: ago(200), finishedAt: null,
      execution: { startedAt: ago(190), lastProgressAt: ago(5), stageStartedAt: ago(150) },
      evaluation: null,
    }, ...overrides,
  }
}

test('执行中展示已到达阶段、可靠耗时和最近上报，不拆分 Agent 阶段', () => {
  const result = benchmarkExecutionProgress(fixture(), now)
  assert.equal(result.label, 'Agent 执行中')
  assert.deepEqual(result.steps.map(s => s.state), ['done', 'done', 'running', 'pending', 'pending', 'pending', 'pending'])
  assert.equal(result.elapsed, 200_000)
  assert.equal(result.stageElapsed, 150_000)
  assert.equal(result.reportAge, 5_000)
  assert.equal(result.delayed, false)
})

test('上报延迟只是提示，重新收到上报后恢复；从未收到上报也不无限等待', () => {
  const input = fixture()
  input.progressDetails!.execution.lastProgressAt = ago(300)
  let result = benchmarkExecutionProgress(input, now)
  assert.equal(result.delayed, true)
  assert.equal(result.failed, false)
  assert.equal(result.active, true)
  input.progressDetails!.execution.lastProgressAt = ago(10)
  assert.equal(benchmarkExecutionProgress(input, now).delayed, false)
  input.progressDetails!.execution.lastProgressAt = null
  input.progressDetails!.execution.startedAt = ago(600)
  result = benchmarkExecutionProgress(input, now)
  assert.equal(result.delayed, true)
  assert.equal(result.reportAge, null)
})

test('长时间排队不误报执行进度更新延迟', () => {
  const input = fixture({ runStatus: 'pending', progressStage: null })
  input.progressDetails!.execution.lastProgressAt = ago(600)
  const result = benchmarkExecutionProgress(input, now)
  assert.equal(result.waiting, true)
  assert.equal(result.delayed, false)
  assert.equal(result.steps[0].state, 'running')
})

test('上传中保留整理提交物进度，不提前显示评测完成', () => {
  const result = benchmarkExecutionProgress(fixture({ runStatus: 'uploading', progressStage: 'uploading' }), now)
  assert.equal(result.steps[3].state, 'running')
  assert.equal(result.steps[4].state, 'pending')
  assert.equal(result.completed, false)
})

test('执行失败和取消停止转圈，后续阶段标为未执行，终态耗时冻结', () => {
  for (const runStatus of ['execution_failed', 'cancelled']) {
    const input = fixture({ runStatus, failure: { code: 'AGENT_TIMEOUT', message: '执行超时' } })
    input.progressDetails!.finishedAt = ago(30)
    const result = benchmarkExecutionProgress(input, now)
    assert.equal(result.active, false)
    assert.equal(result.delayed, false)
    assert.equal(result.steps[2].state, runStatus === 'cancelled' ? 'cancelled' : 'failed')
    assert.equal(result.steps[3].state, 'unreached')
    assert.equal(result.elapsed, 170_000)
    assert.equal(benchmarkExecutionProgress(input, now + 60_000).elapsed, result.elapsed)
  }
})

test('导入提交物跳过执行阶段，评测排队不借用旧执行上报', () => {
  const result = benchmarkExecutionProgress(fixture({ submissionSource: 'imported', runStatus: 'submitted', evaluationStatus: 'queued' }), now)
  assert.deepEqual(result.steps.slice(0, 4).map(s => s.state), ['skipped', 'skipped', 'skipped', 'skipped'])
  assert.equal(result.steps[4].state, 'running')
  assert.equal(result.reportAge, null)
  assert.equal(result.delayed, false)
})

test('重评中的状态优先于旧终态，使用新评测上报和阶段', () => {
  const input = fixture({ runStatus: 'evaluated', evaluationStatus: 'running_evaluator' })
  input.progressDetails!.finishedAt = ago(100)
  input.progressDetails!.evaluation = {
    stage: 'running_harness', createdAt: ago(30), startedAt: ago(20), finishedAt: null,
    lastProgressAt: ago(10), failureMessage: null,
  }
  const result = benchmarkExecutionProgress(input, now)
  assert.equal(result.completed, false)
  assert.equal(result.active, true)
  assert.equal(result.steps[5].state, 'running')
  assert.equal(result.reportAge, 10_000)
  assert.equal(result.stageElapsed, null)
  assert.equal(result.elapsed, 200_000)
})

test('评测准备、结果处理、无效提交和基础设施失败正确定位', () => {
  const input = fixture({ runStatus: 'submitted', evaluationStatus: 'running_evaluator' })
  input.progressDetails!.evaluation = {
    stage: 'resolving_image', createdAt: ago(60), startedAt: ago(50), finishedAt: null,
    lastProgressAt: ago(10), failureMessage: '评测失败原因',
  }
  assert.equal(benchmarkExecutionProgress(input, now).steps[4].state, 'running')
  input.evaluationStatus = 'normalizing'
  assert.equal(benchmarkExecutionProgress(input, now).steps[6].state, 'running')
  input.evaluationStatus = 'normalization_failed'
  let result = benchmarkExecutionProgress(input, now)
  assert.equal(result.steps[6].state, 'failed')
  assert.equal(result.failureMessage, '评测失败原因')
  input.evaluationStatus = 'submission_invalid'
  result = benchmarkExecutionProgress(input, now)
  assert.equal(result.active, false)
  assert.equal(result.label, '提交物无效')
})

test('评测完成表示流程完成，无论业务得分；未知状态和旧数据不编造进度', () => {
  const completed = benchmarkExecutionProgress(fixture({ runStatus: 'evaluated', evaluationStatus: 'completed' }), now)
  assert.equal(completed.completed, true)
  assert.equal(completed.steps.every(s => s.state === 'done'), true)
  const unknown = benchmarkExecutionProgress(fixture({ runStatus: 'unexpected', progressDetails: undefined }), now)
  assert.equal(unknown.active, false)
  assert.equal(unknown.label, '进度暂不可用')
  assert.equal(unknown.elapsed, null)
  assert.equal(unknown.stageElapsed, null)
})

test('Benchmark 迟到旧轮和旧快照不能带回链路或阶段，新重试立即清空旧链接', async () => {
  const { acceptBenchmarkProgress } = await import('@/lib/benchmark/execution-progress')
  const current = { ...fixture({ progressStage: 'collecting', runStatus: 'collecting' }), runId: 'run-2', runAttemptNo: 2, generation: 2000, revision: 2100, traceId: 'trace-2' as string | null, executionId: 'root-2' as string | null, evaluationAttemptNo: 0 }
  assert.equal(acceptBenchmarkProgress(current, { ...current, runId: 'run-1', runAttemptNo: 1, generation: 3000, revision: 3000 }), current)
  assert.equal(acceptBenchmarkProgress(current, { ...current, revision: 2101, progressStage: 'agent_running', runStatus: 'running_agent' }), current)
  assert.equal(acceptBenchmarkProgress(current, { ...current, revision: 2000 }), current)
  const missing = acceptBenchmarkProgress(current, { ...current, revision: 2200, traceId: null, executionId: null })
  assert.equal(missing.traceId, 'trace-2')
  assert.equal(missing.executionId, 'root-2')
  const next = { ...current, runId: 'run-3', runAttemptNo: 3, generation: 1000, traceId: null, executionId: null, runStatus: 'pending', progressStage: null }
  assert.equal(acceptBenchmarkProgress(current, next), next)
})

test('Benchmark 终态不会退回执行，新的评测轮次可以进入重评', async () => {
  const { acceptBenchmarkProgress } = await import('@/lib/benchmark/execution-progress')
  const current = { ...fixture({ runStatus: 'evaluated', evaluationStatus: 'completed' }), runId: 'run', revision: 2000, evaluationAttemptNo: 1 }
  assert.equal(acceptBenchmarkProgress(current, { ...current, revision: 2100, runStatus: 'running_agent', evaluationStatus: null }), current)
  const reevaluation = { ...current, revision: 2100, evaluationAttemptNo: 2, evaluationStatus: 'running_evaluator' }
  assert.equal(acceptBenchmarkProgress(current, reevaluation), reevaluation)
})

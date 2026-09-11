import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveBenchmarkTraceStatus,
  isBenchmarkEvaluationInProgress,
  isBenchmarkSubmissionAwaitingCompletion,
} from '@/lib/benchmark/detail-status'

test('Benchmark Agent 执行阶段仍显示 Trace 生成中', () => {
  for (const runStatus of [
    'pending',
    'preparing',
    'dispatching',
    'dispatch_unknown',
    'running_agent',
    'collecting',
    'uploading',
    'cleaning',
  ]) {
    assert.equal(deriveBenchmarkTraceStatus({
      runStatus,
      hasSubmission: false,
      hasExecution: false,
      hasTask: false,
    }), 'pending')
  }
})

test('Patch 提交后 Trace 已就绪，官方评测进入独立的进行中状态', () => {
  for (const evaluationStatus of ['queued', 'dispatch_unknown', 'running_evaluator', 'normalizing']) {
    assert.equal(deriveBenchmarkTraceStatus({
      runStatus: 'submitted',
      hasSubmission: true,
      hasExecution: true,
      hasTask: true,
    }), 'ready')
    assert.equal(isBenchmarkEvaluationInProgress({ runStatus: 'submitted', evaluationStatus }), true)
  }
})

test('Patch 已上传但执行器终态未确认时不再显示为 Trace 生成中', () => {
  assert.equal(deriveBenchmarkTraceStatus({
    runStatus: 'uploading',
    hasSubmission: true,
    hasExecution: false,
    hasTask: false,
  }), 'ready')
  assert.equal(isBenchmarkSubmissionAwaitingCompletion({
    runStatus: 'uploading',
    hasSubmission: true,
  }), true)
  assert.equal(isBenchmarkSubmissionAwaitingCompletion({
    runStatus: 'submitted',
    hasSubmission: true,
  }), false)
})

test('官方评测完成后不再显示进行中状态', () => {
  assert.equal(deriveBenchmarkTraceStatus({
    runStatus: 'evaluated',
    hasSubmission: true,
    hasExecution: true,
    hasTask: true,
  }), 'ready')
  assert.equal(isBenchmarkEvaluationInProgress({
    runStatus: 'evaluated',
    evaluationStatus: 'completed',
  }), false)
})

test('Agent 执行失败仍属于 Trace 失败', () => {
  for (const runStatus of ['execution_failed', 'dispatch_failed', 'blocked']) {
    assert.equal(deriveBenchmarkTraceStatus({
      runStatus,
      hasSubmission: false,
      hasExecution: false,
      hasTask: false,
    }), 'failed')
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  benchmarkCaseProgressLabel,
  deriveBenchmarkTraceStatus,
  isBenchmarkEvaluationInProgress,
  isBenchmarkSubmissionAwaitingCompletion,
} from '@/lib/benchmark/detail-status'

test('Benchmark 排队与执行阶段使用公共进度文案', () => {
  assert.equal(benchmarkCaseProgressLabel({ runStatus: 'pending' }), '等待开始')
  assert.equal(benchmarkCaseProgressLabel({ runStatus: 'preparing' }), '正在准备任务…')
  assert.equal(benchmarkCaseProgressLabel({ runStatus: 'dispatching' }), '正在下发任务…')
  assert.equal(benchmarkCaseProgressLabel({ runStatus: 'running_agent' }), '等待执行器启动…')
  assert.equal(benchmarkCaseProgressLabel({ runStatus: 'running_agent', progressStage: 'agent_running' }), 'Agent 执行中…')
  assert.equal(benchmarkCaseProgressLabel({ runStatus: 'collecting' }), '正在收集提交物…')
})

test('只有 Git 工作区的准备阶段显示 Git 文案', () => {
  assert.equal(benchmarkCaseProgressLabel({
    runStatus: 'running_agent', progressStage: 'preparing', workspaceProvider: 'git',
  }), '正在准备 Git 工作区…')
  assert.equal(benchmarkCaseProgressLabel({
    runStatus: 'running_agent', progressStage: 'preparing', workspaceProvider: 'other',
  }), '正在准备执行环境…')
  assert.equal(benchmarkCaseProgressLabel({
    runStatus: 'pending', progressStage: 'preparing', workspaceProvider: 'git',
  }), '等待开始')
})

test('Benchmark 活动阶段保持未完成的聚合状态', () => {
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

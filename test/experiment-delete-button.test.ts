import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';

import { DeleteExperimentButton, isCompletedExperimentCase, emptyCaseEvaluationMessage } from '../src/components/eval/DeleteExperimentButton';
import { isCompletedWorkbenchCase, type AbSideState } from '../src/lib/skill-workbench/ab-comparison';

test('触发分析按单条 Case 状态显示删除，不跟随其他 Case 的运行状态', () => {
  assert.equal(isCompletedExperimentCase('running', null, { traceStatus: 'failed' }), true);
  assert.equal(isCompletedExperimentCase('running', null, { traceStatus: 'ready', evaluatorIds: ['a'], results: [{ evaluatorId: 'a', status: 'done' }] }), true);
  assert.equal(isCompletedExperimentCase('running', null, { traceStatus: 'failed', traceAttemptStatus: 'running' }), false);
  assert.equal(isCompletedExperimentCase('running', null, { traceStatus: 'ready', results: [{ evaluatorId: 'a', status: 'running' }] }), false);
  assert.equal(isCompletedExperimentCase('running', null, { traceStatus: 'pending' }), false);
  assert.match(emptyCaseEvaluationMessage('running', { traceStatus: 'failed' }), /执行失败，未进入评测/);
  assert.match(emptyCaseEvaluationMessage('running', { traceStatus: 'ready' }), /等待评测/);
  assert.match(emptyCaseEvaluationMessage('done', { traceStatus: 'ready' }), /实验已结束/);
});

test('resolved Benchmark Case shows 删除 while active Case shows 停止并删除', () => {
  const labelFor = (experimentStatus: string, runStatus: string) => renderToStaticMarkup(createElement(DeleteExperimentButton, {
    user: 'owner', experimentId: 'experiment', caseId: 'case',
    completed: isCompletedExperimentCase(experimentStatus, runStatus), onDeleted: () => {},
  }));

  assert.match(labelFor('done', 'evaluated'), />删除<\/button>/);
  assert.match(labelFor('running', 'evaluated'), />删除<\/button>/);
  assert.match(labelFor('running', 'running_agent'), />停止并删除<\/button>/);
  assert.match(labelFor('failed', 'running_evaluator'), />停止并删除<\/button>/);
  assert.equal(isCompletedExperimentCase('done'), true);
  assert.equal(isCompletedExperimentCase('running'), false);
});

function workbenchLabel(experimentStatus: string, sides: Array<AbSideState | undefined>) {
  return renderToStaticMarkup(createElement(DeleteExperimentButton, {
    user: 'owner', experimentId: 'experiment', caseId: 'dataset:case',
    completed: isCompletedWorkbenchCase(experimentStatus, sides), onDeleted: () => {},
  }));
}

test('finished use-case shows 删除 for both successful and failed runs while other cases continue', () => {
  for (const status of ['pass', 'fail', 'done', 'failed', 'cancelled']) {
    assert.match(workbenchLabel('running', [{ runs: [{ status }] }]), />删除<\/button>/);
  }
  for (const status of ['pending', 'running', 'executed', 'evaluating']) {
    assert.match(workbenchLabel('running', [{ runs: [{ status }] }]), />停止并删除<\/button>/);
  }
});

test('A/B deletion waits for both sides and every round, including retried scored runs', () => {
  const finished: AbSideState = { status: 'pass', runs: [{ status: 'pass' }, { status: 'fail' }] };
  assert.match(workbenchLabel('running', [finished, finished]), />删除<\/button>/);
  for (const status of ['pending', 'running', 'executed', 'evaluating']) {
    const unfinished: AbSideState = { status: 'pass', runs: [{ status, score: 80 }, { status: 'pass' }] };
    assert.match(workbenchLabel('done', [unfinished, finished]), />停止并删除<\/button>/);
    assert.match(workbenchLabel('done', [finished, unfinished]), />停止并删除<\/button>/);
  }
});

test('cases without run details use the experiment state without treating a missing A/B side as finished', () => {
  for (const status of ['done', 'partial', 'failed', 'cancelled']) {
    assert.match(workbenchLabel(status, [undefined]), />删除<\/button>/);
  }
  assert.match(workbenchLabel('running', [undefined]), />停止并删除<\/button>/);
  assert.match(workbenchLabel('running', [{ status: 'pass' }, undefined]), />停止并删除<\/button>/);
});

test('删除按钮支持由所在操作列统一字号', () => {
  const html = renderToStaticMarkup(createElement(DeleteExperimentButton, {
    user: 'owner', experimentId: 'experiment', caseId: 'dataset:case', completed: true,
    className: 'text-sm', onDeleted: () => {},
  }));
  assert.match(html, /class="text-sm text-foreground-muted/);
  assert.doesNotMatch(html, /class="text-xs text-foreground-muted/);
});

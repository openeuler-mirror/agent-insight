import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';

import { DeleteExperimentButton, isCompletedExperimentCase } from '../src/components/eval/DeleteExperimentButton';

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

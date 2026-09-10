import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperimentCaseComparisonTable, type ComparisonTableCase } from '@/components/evaluation-harness/ExperimentCaseComparisonTable';

test('两侧 Case 都存在时，未标注的预期不会被另一组预期覆盖', () => {
  const a: ComparisonTableCase = { id: 'a', input: '问题', referenceOutput: null, actualOutput: '', traceStatus: null, traceError: null, traceAttemptNo: null, scores: {overall:null,res:null,traj:null,failed:0,adjusted:0} };
  const html = renderToStaticMarkup(createElement(ExperimentCaseComparisonTable, { experimentId: 'experiment', rows: [{key:'case',a,b:{...a,id:'b',referenceOutput:'B 预期答案'}}] }));
  assert.match(html, /A：未标注/);
  assert.match(html, /B：B 预期答案/);
});

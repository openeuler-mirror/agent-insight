import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  defaultDiagnosisResultIds,
  type DiagnosisResultOption,
} from '../src/components/diagnosis/CaseDiagnosisInput';

function result(
  id: string,
  status: string,
  verdict: DiagnosisResultOption['verdict'],
): DiagnosisResultOption {
  return {
    id,
    evaluatorId: `evaluator-${id}`,
    name: id,
    status,
    verdict,
    score: null,
    summary: null,
  };
}

test('diagnosis defaults to completed results that did not fully pass', () => {
  assert.deepEqual(defaultDiagnosisResultIds([
    result('pass', 'done', 'pass'),
    result('warn', 'done', 'warn'),
    result('fail', 'done', 'fail'),
    result('running', 'running', 'fail'),
    result('evaluation-failed', 'failed', 'fail'),
    result('unscored', 'done', null),
  ]), ['warn', 'fail']);
});

test('case detail keeps input, evaluations, diagnosis, and comments in one continuous page', () => {
  const source = readFileSync('src/components/eval/ExperimentCaseDetail.tsx', 'utf8');
  const input = source.indexOf("{ label: '任务输入'");
  const evaluations = source.indexOf("(['res', 'traj'] as EvaluatorCategory[])");
  const diagnosis = source.lastIndexOf('<CaseDiagnosisInput');
  const comments = source.indexOf('{/* 本条 case 的整体评论');

  assert.doesNotMatch(source, /role="tablist"/);
  assert.ok(input >= 0 && input < evaluations);
  assert.ok(evaluations < diagnosis);
  assert.ok(diagnosis < comments);
});

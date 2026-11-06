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

test('diagnosis input refreshes automatically without repeating Case evidence', () => {
  const source = readFileSync('src/components/diagnosis/CaseDiagnosisInput.tsx', 'utf8');

  assert.match(source, /setTimeout\(\(\) => void loadPreview\(\), 250\)/);
  assert.match(source, /正在根据所选评测准备诊断输入/);
  assert.match(source, /诊断输入已根据当前选择自动更新/);
  assert.doesNotMatch(source, /刷新诊断输入|查看任务、输出与评测证据/);
  assert.doesNotMatch(source, /<dt className="text-foreground-muted">(?:Trace|Attempt|Skill)<\/dt>/);
});

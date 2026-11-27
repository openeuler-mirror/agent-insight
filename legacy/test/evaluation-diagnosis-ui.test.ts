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

test('diagnosis optimization uses the selected findings without a redundant confirmation checkbox', () => {
  const source = readFileSync('src/components/diagnosis/DiagnosisOptimizationCard.tsx', 'utf8');
  const panel = readFileSync('src/components/diagnosis/DiagnosisRunPanel.tsx', 'utf8');

  assert.doesNotMatch(source, /我已确认所选问题|I confirm these findings/);
  assert.doesNotMatch(source, /const \[confirmed, setConfirmed\]/);
  assert.match(source, /skillRelevanceConfirmed: true/);
  assert.doesNotMatch(panel, /<h2 className="font-medium">\{zh \? '选择诊断发现用于 Skill 优化'/);
  assert.match(source, /function FindingMultiSelect/);
  assert.match(source, /选择要带入优化计划的发现/);
  assert.match(source, /PopoverContent/);
  assert.ok(source.indexOf("'目标 Skill'") < source.indexOf('<FindingMultiSelect'));
  const selector = source.slice(source.indexOf('function FindingMultiSelect'), source.indexOf('function OptimizationForm'));
  assert.doesNotMatch(selector, /correctionGuidance|finding\.evidence|issueRefs|Trace #/);
});

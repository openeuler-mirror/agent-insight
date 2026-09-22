import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  summarizeExistingTraceItemProgress,
  summarizeWorkbenchItemProgress,
} from '@/lib/skill-workbench/item-progress';

test('用例分析按执行项聚合多个评估器，执行总数与评测总数一致', () => {
  const progress = summarizeWorkbenchItemProgress({
    caseIds: ['case-1', 'case-2', 'case-3'],
    executionSides: ['b'],
    repeatRounds: 1,
    evaluatorIds: ['result', 'trajectory'],
    caseStates: {
      'case-1': { b: { runs: [{ status: 'pass', runIndex: 1, evaluations: [
        { evaluatorId: 'result', status: 'done' },
        { evaluatorId: 'trajectory', status: 'done' },
      ] }] } },
      'case-2': { b: { runs: [{ status: 'fail', runIndex: 1, evaluations: [
        { evaluatorId: 'result', status: 'done' },
        { evaluatorId: 'trajectory', status: 'failed' },
      ] }] } },
      'case-3': { b: { runs: [{ status: 'fail', failureType: 'agent_timeout', runIndex: 1 }] } },
    },
  });

  assert.deepEqual(progress.executionProgress, { total: 3, succeeded: 2, failed: 1, pending: 0 });
  assert.deepEqual(progress.evaluationProgress, { total: 3, succeeded: 1, failed: 2, pending: 0 });
});

test('A/B 测试按两侧分别计项，不按评估器数量扩大评测总数', () => {
  const progress = summarizeWorkbenchItemProgress({
    caseIds: ['case-1', 'case-2'],
    executionSides: ['a', 'b'],
    repeatRounds: 1,
    evaluatorIds: ['result', 'trajectory', 'safety'],
    caseStates: {
      'case-1': {
        a: { runs: [{ status: 'pass', runIndex: 1 }] },
        b: { runs: [{ status: 'pass', runIndex: 1 }] },
      },
      'case-2': {
        a: { runs: [{ status: 'fail', failureType: 'agent_error', runIndex: 1 }] },
        b: { runs: [{ status: 'evaluating', runIndex: 1 }] },
      },
    },
  });

  assert.deepEqual(progress.executionProgress, { total: 4, succeeded: 3, failed: 1, pending: 0 });
  assert.deepEqual(progress.evaluationProgress, { total: 4, succeeded: 2, failed: 1, pending: 1 });
});

test('已有 Trace 用例按 Case 聚合评估器结果', () => {
  const progress = summarizeExistingTraceItemProgress({
    caseIds: ['case-1', 'case-2'],
    evaluatorIds: ['result', 'trajectory'],
    settled: true,
    results: [
      { caseId: 'case-1', evaluatorId: 'result', status: 'done' },
      { caseId: 'case-1', evaluatorId: 'trajectory', status: 'done' },
      { caseId: 'case-2', evaluatorId: 'result', status: 'done' },
      { caseId: 'case-2', evaluatorId: 'trajectory', status: 'failed' },
    ],
  });

  assert.deepEqual(progress.executionProgress, { total: 2, succeeded: 2, failed: 0, pending: 0 });
  assert.deepEqual(progress.evaluationProgress, { total: 2, succeeded: 1, failed: 1, pending: 0 });
});

test('Skill 用例分析和 A/B 结果页统一展示四项统计', () => {
  const skillResult = readFileSync('src/components/skill-workbench/SkillExperimentResult.tsx', 'utf8');
  const experimentDetail = readFileSync('src/components/eval/ExperimentDetail.tsx', 'utf8');
  for (const label of ['执行成功', '执行失败', '评测成功', '评测失败']) {
    assert.match(skillResult, new RegExp(label));
    assert.match(experimentDetail, new RegExp(label));
  }
  assert.match(skillResult, /多个评估器只决定该评测项是否成功，不扩大评测项总数/);
});

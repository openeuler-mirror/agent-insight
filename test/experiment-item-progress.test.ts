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
  assert.deepEqual(progress.evaluationProgress, { total: 3, succeeded: 1, failed: 1, pending: 0, skipped: 1, unscored: 0 });
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
  assert.deepEqual(progress.evaluationProgress, { total: 4, succeeded: 2, failed: 0, pending: 1, skipped: 1, unscored: 0 });
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
  assert.deepEqual(progress.evaluationProgress, { total: 2, succeeded: 1, failed: 1, pending: 0, skipped: 0, unscored: 0 });
});

test('一个评估器失败时，仍在运行或排队的评估器阻止该项提前结束', () => {
  for (const status of ['pending', 'running']) {
    for (const settled of [false, true]) {
      const evaluations = [
        { evaluatorId: 'result', status: 'failed' },
        { evaluatorId: 'trajectory', status },
      ];
      const generated = summarizeWorkbenchItemProgress({
        caseIds: ['case'], executionSides: ['b'], repeatRounds: 1,
        evaluatorIds: ['result', 'trajectory'], settled,
        caseStates: { case: { b: { status: 'fail', evaluations } } },
      });
      const existing = summarizeExistingTraceItemProgress({
        caseIds: ['case'], evaluatorIds: ['result', 'trajectory'], settled,
        results: evaluations.map((evaluation) => ({ caseId: 'case', ...evaluation })),
      });
      for (const progress of [generated, existing]) {
        assert.equal(progress.executionProgress.succeeded, 1);
        assert.equal(progress.evaluationProgress.pending, 1);
        assert.equal(progress.evaluationProgress.failed, 0);
      }
    }
  }
});

test('运行中缺失评估器结果时不提前结束，结果全部收敛后再计为失败', () => {
  const input = {
    caseIds: ['case'], executionSides: ['b'] as Array<'b'>, repeatRounds: 1,
    evaluatorIds: ['result', 'trajectory'],
    caseStates: { case: { b: { status: 'evaluating', evaluations: [{ evaluatorId: 'result', status: 'failed' }] } } },
  };
  assert.equal(summarizeWorkbenchItemProgress(input).evaluationProgress.pending, 1);
  assert.equal(summarizeExistingTraceItemProgress({
    caseIds: ['case'], evaluatorIds: input.evaluatorIds, settled: false,
    results: [{ caseId: 'case', evaluatorId: 'result', status: 'failed' }],
  }).evaluationProgress.pending, 1);
  input.caseStates.case.b.evaluations.push({ evaluatorId: 'trajectory', status: 'done' });
  assert.equal(summarizeWorkbenchItemProgress(input).evaluationProgress.failed, 1);
  assert.equal(summarizeWorkbenchItemProgress(input).evaluationProgress.pending, 0);
});

test('A/B 每侧按冻结轮次补齐未执行项，跳过与未计分也属于结束项', () => {
  const input = {
    caseIds: ['case'], repeatRounds: 2, evaluatorIds: ['result'],
    caseStates: { case: {
      a: { runs: [
        { runIndex: 1, status: 'fail', failureType: 'agent_error' },
        { runIndex: 2, status: 'pass', evaluations: [{ evaluatorId: 'result', status: 'done', score: null }] },
      ] },
      b: { runs: [{ runIndex: 1, status: 'executed' }] },
    } },
  };
  const a = summarizeWorkbenchItemProgress({ ...input, executionSides: ['a'] });
  const b = summarizeWorkbenchItemProgress({ ...input, executionSides: ['b'] });
  const both = summarizeWorkbenchItemProgress({ ...input, executionSides: ['a', 'b'] });
  assert.deepEqual(a.evaluationProgress, { total: 2, succeeded: 0, failed: 0, pending: 0, skipped: 1, unscored: 1 });
  assert.equal(b.executionProgress.pending, 1);
  assert.equal(b.evaluationProgress.pending, 2);
  assert.equal(both.executionProgress.total, 4);
  assert.equal(both.evaluationProgress.total, 4);
  assert.equal(both.evaluationProgress.pending, a.evaluationProgress.pending + b.evaluationProgress.pending);
});

test('Skill 用例分析和 A/B 结果页统一展示四项统计', () => {
  const skillResult = readFileSync('src/components/skill-workbench/SkillExperimentResult.tsx', 'utf8');
  const experimentDetail = readFileSync('src/components/eval/ExperimentDetail.tsx', 'utf8');
  for (const label of ['执行成功', '执行失败', '评测成功', '评测失败']) {
    assert.match(skillResult, new RegExp(label));
    assert.match(experimentDetail, new RegExp(label));
  }
  assert.match(skillResult, /多个评估器.*不扩大评测项总数/);
});

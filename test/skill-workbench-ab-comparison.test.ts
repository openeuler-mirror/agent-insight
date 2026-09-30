import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAbComparison, formatWorkbenchScore, summarizeAbSide } from '../src/lib/skill-workbench/ab-comparison';

test('用例得分列按实际阶段区分等待执行、执行中、待评测和评测中', () => {
  for (const [status, expected] of [
    ['pending', '等待执行'], ['running', '执行中'],
    ['executed', '待评测'], ['evaluating', '评测中'],
    ['failed', '失败'], ['fail', '失败'], ['unscored', '未计分'], ['cancelled', '已取消'],
  ]) {
    const summary = summarizeAbSide({ runs: [{ status, runIndex: 1 }] });
    assert.equal(formatWorkbenchScore(summary.score, summary.status), expected);
  }
  assert.equal(formatWorkbenchScore(undefined), '—');
});

test('A/B 一侧仍执行而另一侧已评测时，得分列分别显示实际阶段', () => {
  const result = buildAbComparison(['case'], {
    case: {
      a: { runs: [{ status: 'running' }] },
      b: { runs: [{ status: 'evaluating' }] },
    },
  }, ['result']);
  assert.equal(formatWorkbenchScore(result.cases[0].a.score, result.cases[0].a.status), '执行中');
  assert.equal(formatWorkbenchScore(result.cases[0].b.score, result.cases[0].b.status), '评测中');
  assert.equal(formatWorkbenchScore(0, 'pass'), '0.0');
  assert.equal(formatWorkbenchScore(85, 'evaluating'), '85.0');
});

test('A/B 汇总只使用两侧均有综合分的可比 Case', () => {
  const result = buildAbComparison(['case-1', 'case-2', 'case-3', 'case-4'], {
    'case-1': { a: { score: 90 }, b: { score: 70 } },
    'case-2': { a: { score: 60 }, b: { score: 80 } },
    'case-3': { a: { score: 75 }, b: { score: 75 } },
    'case-4': { a: { score: 100 }, b: { status: 'running' } },
  }, []);

  assert.equal(result.comparable, 3);
  assert.equal(result.unpaired, 1);
  assert.equal(result.aWins, 1);
  assert.equal(result.bWins, 1);
  assert.equal(result.ties, 1);
  assert.equal(result.aScore, 75);
  assert.equal(result.bScore, 75);
});

test('评估器分解按两侧都有该评估器分数的 Case 配对计算覆盖率', () => {
  const result = buildAbComparison(['case-1', 'case-2'], {
    'case-1': {
      a: { score: 90, evaluations: [{ evaluatorId: 'task', evaluatorName: '任务完成度', score: 88 }] },
      b: { score: 80, evaluations: [{ evaluatorId: 'task', evaluatorName: '任务完成度', score: 76 }] },
    },
    'case-2': {
      a: { score: 70, evaluations: [{ evaluatorId: 'task', evaluatorName: '任务完成度', score: 70 }] },
      b: { score: 60 },
    },
  }, ['task']);

  assert.deepEqual(result.evaluators[0], {
    evaluatorId: 'task',
    evaluatorName: '任务完成度',
    aScore: 88,
    bScore: 76,
    coverage: 1,
  });
});

test('重复运行先在 Case 侧求均分并保留最新输出', () => {
  const result = buildAbComparison(['case-1'], {
    'case-1': {
      a: { runs: [{ score: 80, output: '旧输出' }, { score: 100, output: '新输出' }] },
      b: { runs: [{ score: 70, output: 'B 输出' }] },
    },
  }, []);

  assert.equal(result.cases[0].a.score, 90);
  assert.equal(result.cases[0].a.output, '新输出');
  assert.equal(result.cases[0].outcome, 'a');
});

test('A/B 重评中保留上一版稳定分与配对结论', () => {
  const result = buildAbComparison(['case-1'], {
    'case-1': {
      a: {
        runs: [{
          status: 'evaluating',
          score: 90,
          evaluations: [{ evaluatorId: 'task', status: 'running', score: 88 }],
        }],
      },
      b: {
        runs: [{
          status: 'pass',
          score: 80,
          evaluations: [{ evaluatorId: 'task', status: 'done', score: 78 }],
        }],
      },
    },
  }, ['task']);

  assert.equal(result.comparable, 1);
  assert.equal(result.cases[0].outcome, 'a');
  assert.equal(result.cases[0].a.score, 90);
  assert.equal(result.cases[0].a.evaluations[0].score, 88);
});

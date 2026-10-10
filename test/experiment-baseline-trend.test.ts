import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildExperimentBaselineKey,
  EXPERIMENT_BASELINE_TREND_MAX_POINTS,
  summarizeExperimentTrendPoint,
  type BaselineExperimentLike,
} from '@/lib/engine/experiment/baseline-trend';

test('同基线趋势最多返回 50 个数据点', () => {
  assert.equal(EXPERIMENT_BASELINE_TREND_MAX_POINTS, 50);
});

test('趋势图使用 10/20/50 上限选择，摘要跟随选中节点并可跳转实验详情', () => {
  const source = readFileSync(
    new URL('../src/components/eval/ExperimentBaselineTrend.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /data\.length <= 20 \? \[10, 20\] : \[10, 20, 50\]/);
  assert.match(source, /<select[\s\S]*趋势图最多显示实验次数/);
  assert.doesNotMatch(source, /type="number"/);
  assert.match(source, /setSelectedExperimentId\(point\.experimentId\)/);
  assert.match(source, /data\.find\(\(item\) => item\.label === String\(interaction\.activeLabel\)\)/);
  assert.doesNotMatch(source, /activePayload/);
  assert.match(source, /onMouseMove=\{selectActivePoint\}/);
  assert.match(source, /onClick=\{selectActivePoint\}/);
  assert.match(source, /查看实验详情/);
  assert.match(source, /wrapperStyle=\{\{ pointerEvents: 'auto' \}\}/);
  assert.match(source, /onOpenExperiment\(point\.experimentId\)/);
  assert.match(source, /selectedDateLabel\(selected\.createdAt\)/);
  assert.match(source, /className="experiment-baseline-trend-chart"/);
  assert.doesNotMatch(source, />本次结果</);
});

function experiment(overrides: Partial<BaselineExperimentLike> = {}): BaselineExperimentLike {
  return {
    id: 'experiment-current',
    name: '基线实验',
    type: 'single',
    user: 'trend-user',
    agentName: 'OpenCode',
    status: 'done',
    scope: '',
    preset: null,
    watchMode: false,
    evaluatorIdsJson: JSON.stringify(['result-accuracy', 'trajectory-quality']),
    configSnapshotJson: JSON.stringify({
      schemaVersion: 1,
      datasetId: 'dataset-1',
      caseIds: ['case-2', 'case-1'],
      evaluatorIds: ['result-accuracy', 'trajectory-quality'],
      traceSource: 'generate',
      executionTarget: { model: 'provider/model-a' },
    }),
    createdAt: new Date('2026-09-11T02:00:00.000Z'),
    cases: [
      {
        input: '问题 2', datasetInput: '问题 2', referenceOutput: '答案 2',
        evaluatorContextJson: null, caseValuesJson: null, faultInjectionType: null,
      },
      {
        input: '问题 1', datasetInput: '问题 1', referenceOutput: '答案 1',
        evaluatorContextJson: null, caseValuesJson: null, faultInjectionType: null,
      },
    ],
    ...overrides,
  };
}

test('普通实验基线指纹对 Case 和评估器顺序不敏感', () => {
  const first = experiment();
  const second = experiment({
    evaluatorIdsJson: JSON.stringify(['trajectory-quality', 'result-accuracy']),
    configSnapshotJson: JSON.stringify({
      schemaVersion: 1,
      datasetId: 'dataset-1',
      caseIds: ['case-1', 'case-2'],
      traceSource: 'generate',
      executionTarget: { model: 'provider/model-b' },
    }),
    cases: [...first.cases].reverse(),
    agentName: 'Claude Code',
  });

  assert.equal(buildExperimentBaselineKey(first), buildExperimentBaselineKey(second));
});

test('普通实验数据集、Case 契约或评估器变化时基线不同', () => {
  const baseline = buildExperimentBaselineKey(experiment());
  const changedDataset = experiment({
    configSnapshotJson: JSON.stringify({
      schemaVersion: 1,
      datasetId: 'dataset-2',
      caseIds: ['case-1', 'case-2'],
      traceSource: 'generate',
    }),
  });
  const changedContract = experiment({
    cases: experiment().cases.map((item, index) => index === 0 ? { ...item, referenceOutput: '新答案' } : item),
  });
  const changedEvaluator = experiment({ evaluatorIdsJson: JSON.stringify(['result-accuracy']) });

  assert.notEqual(buildExperimentBaselineKey(changedDataset), baseline);
  assert.notEqual(buildExperimentBaselineKey(changedContract), baseline);
  assert.notEqual(buildExperimentBaselineKey(changedEvaluator), baseline);
});

test('Benchmark 基线使用数据集内容哈希、Case 集、Adapter 和 Evaluator 契约', () => {
  const first = experiment({
    scope: 'benchmark',
    evaluatorIdsJson: JSON.stringify(['benchmark:swe-bench', 'trajectory-quality']),
    configSnapshotJson: JSON.stringify({
      adapterKey: 'swe-bench', evaluatorKey: 'swe-bench', datasetContentHash: 'sha256:dataset', caseIds: ['b', 'a'],
    }),
  });
  const second = experiment({
    scope: 'benchmark',
    evaluatorIdsJson: JSON.stringify(['benchmark:swe-bench']),
    configSnapshotJson: JSON.stringify({
      adapterKey: 'swe-bench', evaluatorKey: 'swe-bench', datasetContentHash: 'sha256:dataset', caseIds: ['a', 'b'],
      runConfig: { model: 'another-model' },
    }),
  });
  const changedCases = experiment({
    scope: 'benchmark',
    configSnapshotJson: JSON.stringify({
      adapterKey: 'swe-bench', evaluatorKey: 'swe-bench', datasetContentHash: 'sha256:dataset', caseIds: ['a'],
    }),
  });

  assert.equal(buildExperimentBaselineKey(first), buildExperimentBaselineKey(second));
  assert.notEqual(buildExperimentBaselineKey(first), buildExperimentBaselineKey(changedCases));
});

test('普通实验趋势使用生效综合分并统计计入 Case', () => {
  const point = summarizeExperimentTrendPoint({
    experiment: experiment({ cases: [...experiment().cases, {
      input: '问题 3', datasetInput: '问题 3', referenceOutput: '答案 3',
      evaluatorContextJson: null, caseValuesJson: null, faultInjectionType: null,
    }] }),
    benchmarkMetric: null,
    currentExperimentId: 'experiment-current',
    results: [
      { caseId: 'case-1', evaluatorId: 'result-accuracy', status: 'done', score: 80, humanScore: 90 },
      { caseId: 'case-2', evaluatorId: 'result-accuracy', status: 'done', score: 60, humanScore: null },
      { caseId: 'case-3', evaluatorId: 'result-accuracy', status: 'failed', score: null, humanScore: null },
    ],
  });

  assert.equal(point?.value, 75);
  assert.equal(point?.summary, '2/3 Case 计入');
  assert.equal(point?.model, 'provider/model-a');
  assert.equal(point?.isCurrent, true);
});

test('SWE-bench Resolve Rate 使用全部 Case 作为固定分母', () => {
  const benchmark = experiment({
    scope: 'benchmark',
    configSnapshotJson: JSON.stringify({
      adapterKey: 'swe-bench', evaluatorKey: 'swe-bench', datasetContentHash: 'sha256:dataset', caseIds: ['a', 'b', 'c'],
      runConfig: { model: 'provider/model-b' },
    }),
    cases: Array.from({ length: 3 }, (_, index) => ({
      input: `问题 ${index + 1}`, datasetInput: null, referenceOutput: null,
      evaluatorContextJson: null, caseValuesJson: null, faultInjectionType: null,
    })),
  });
  const point = summarizeExperimentTrendPoint({
    experiment: benchmark,
    benchmarkMetric: {
      evaluatorId: 'benchmark:swe-bench',
      key: 'resolved',
      label: 'Resolved',
      aggregation: 'boolean-rate',
    },
    currentExperimentId: benchmark.id,
    results: [
      { caseId: 'a', evaluatorId: 'benchmark:swe-bench', status: 'done', score: 100 },
      { caseId: 'b', evaluatorId: 'benchmark:swe-bench', status: 'done', score: 0 },
      { caseId: 'c', evaluatorId: 'benchmark:swe-bench', status: 'pending', score: null },
      { caseId: 'a', evaluatorId: 'trajectory-quality', status: 'done', score: 100 },
    ],
  });

  assert.equal(point?.value, 33.3);
  assert.equal(point?.summary, '1/3 Resolved');
});

test('mean 类 Benchmark 主指标复用官方评估分数均值', () => {
  const benchmark = experiment({
    scope: 'benchmark',
    cases: experiment().cases,
  });
  const point = summarizeExperimentTrendPoint({
    experiment: benchmark,
    benchmarkMetric: {
      evaluatorId: 'benchmark:custom',
      key: 'quality',
      label: 'Quality',
      aggregation: 'mean',
    },
    currentExperimentId: benchmark.id,
    results: [
      { caseId: 'a', evaluatorId: 'benchmark:custom', status: 'done', score: 80 },
      { caseId: 'b', evaluatorId: 'benchmark:custom', status: 'done', score: 60 },
      { caseId: 'a', evaluatorId: 'trajectory-quality', status: 'done', score: 100 },
    ],
  });

  assert.equal(point?.value, 70);
  assert.equal(point?.summary, '2/2 Case 计入');
});

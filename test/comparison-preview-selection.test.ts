import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparisonPreviewContextKey, mergeComparisonPreviewSelection } from '../src/lib/engine/experiment/comparison-preview-selection';

const context = {
  user: 'reviewer', agentName: 'loan-agent', type: 'llm', groupA: 'model-a', groupB: 'model-b',
  datasetId: 'dataset-1', datasetCases: [{ input: '申请贷款', expectedOutput: '数据集默认答案' }],
};
const candidate = {
  executionId: 'trace-1', input: '申请贷款', actualOutput: '实际回答',
  referenceOutput: '数据集默认答案' as string | null, datasetInput: '申请贷款',
  evaluatorContext: { availableTools: [] as string[] }, values: { source: 'dataset' },
};
const annotated = {
  ...candidate, referenceOutput: '用户标注答案', datasetInput: '人工匹配输入',
  evaluatorContext: { availableTools: ['credit-check'] }, values: { source: 'manual' },
};

test('同一配置返回 Trace 步骤时保留共享标注，同时刷新实际输出', () => {
  const key = comparisonPreviewContextKey(context);
  const result = mergeComparisonPreviewSelection(key, key, new Map([[annotated.executionId, annotated]]), [{ ...candidate, actualOutput: '最新实际回答' }]);
  assert.deepEqual(result.get('trace-1'), { ...annotated, actualOutput: '最新实际回答' });
});

test('保留用户明确清除的预期输出，不重新填入默认答案', () => {
  const key = comparisonPreviewContextKey(context);
  const previous = new Map([[candidate.executionId, { ...annotated, referenceOutput: null }]]);
  assert.equal(mergeComparisonPreviewSelection(key, key, previous, [candidate]).get('trace-1')?.referenceOutput, null);
});

test('账号、Agent、类型、组取值或数据集内容变化时不能复用旧标注', () => {
  const key = comparisonPreviewContextKey(context);
  const changes = [
    { user: 'another-user' }, { agentName: 'other-agent' }, { type: 'agent' },
    { groupA: 'other-a' }, { groupB: 'other-b' }, { datasetId: 'dataset-2' },
    { datasetCases: [{ input: '申请贷款', expectedOutput: '修订后的预期' }] },
  ];
  for (const change of changes) {
    const nextKey = comparisonPreviewContextKey({ ...context, ...change });
    assert.notEqual(nextKey, key);
    const result = mergeComparisonPreviewSelection(key, nextKey, new Map([[annotated.executionId, annotated]]), [candidate]);
    assert.deepEqual(result.get('trace-1'), candidate);
  }
});

test('仅保留当前配对候选，不把旧 Trace 标注套到新 Trace 或改变后的输入', () => {
  const key = comparisonPreviewContextKey(context);
  const previous = new Map([[annotated.executionId, annotated]]);
  const newTrace = { ...candidate, executionId: 'trace-2' };
  const changedInput = { ...candidate, input: '新的输入' };
  const result = mergeComparisonPreviewSelection(key, key, previous, [newTrace, changedInput]);
  assert.deepEqual([...result.values()], [newTrace, changedInput]);
  assert.equal(mergeComparisonPreviewSelection(key, key, previous, []).size, 0);
});

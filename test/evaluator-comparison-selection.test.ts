import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presetEvaluators } from '../src/lib/evaluators/preset-evaluators';
import { resolveEvaluatorComparison } from '../src/lib/engine/experiment/evaluator-comparison-selection';

const referenceId = 'preset-agent-task-completion';
const noReferenceId = 'preset-task-completion-no-ref';
const completeCase = { hasReference: true, hasDatasetInput: true, hasToolCatalog: true };
const input = {
  groupA: referenceId,
  groupB: noReferenceId,
  evaluators: presetEvaluators,
  cases: [completeCase],
  isReliabilityDataset: false,
};

test('评估器 A/B 保持组归属，有参考与无参考评估器可在不同组独立比较', () => {
  const result = resolveEvaluatorComparison({ ...input, evaluators: [...presetEvaluators].reverse() });
  assert.equal(result.error, null);
  assert.deepEqual(result.groups.map(group => [group.key, group.card?.id, group.gate.usable]), [
    ['A', referenceId, true],
    ['B', noReferenceId, true],
  ]);
});

test('共享 Case 缺少预期输出时阻止需要答案的组，另一组仍可用', () => {
  const result = resolveEvaluatorComparison({ ...input, cases: [{ ...completeCase, hasReference: false }] });
  assert.match(result.error || '', /A 组.*依赖预期输出/);
  assert.equal(result.groups[0].gate.usable, false);
  assert.equal(result.groups[1].gate.usable, true);
});

test('空选项、相同评估器、目录缺失及未就绪评估器均不能开始对比', () => {
  assert.match(resolveEvaluatorComparison({ ...input, groupA: '' }).error || '', /A 组.*选择/);
  assert.match(resolveEvaluatorComparison({ ...input, groupB: referenceId }).error || '', /不同/);
  assert.match(resolveEvaluatorComparison({ ...input, evaluators: presetEvaluators.filter(card => card.id !== noReferenceId) }).error || '', /B 组.*不存在/);
  assert.match(resolveEvaluatorComparison({
    ...input,
    evaluators: presetEvaluators.map(card => card.id === noReferenceId ? { ...card, status: 'draft' as const } : card),
  }).error || '', /B 组.*尚未就绪/);
});

test('可靠性评估器保留数据集门控，不能因第一步已选中而绕过', () => {
  const reliabilityInput = { ...input, groupA: 'preset-ras-reliability-detection-recovery' };
  assert.match(resolveEvaluatorComparison(reliabilityInput).error || '', /A 组.*可靠性数据集/);
  assert.equal(resolveEvaluatorComparison({ ...reliabilityInput, isReliabilityDataset: true }).error, null);
});

test('没有共享 Trace Case 时不能仅凭两组已选评估器开始实验', () => {
  assert.match(resolveEvaluatorComparison({ ...input, cases: [] }).error || '', /Trace/);
});

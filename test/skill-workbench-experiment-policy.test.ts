import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSkillExperimentConcurrencyPolicy,
  isSkillExperimentDatasetEligible,
  isSkillExperimentEvaluatorEligible,
  isSkillTriggerDataset,
} from '@/lib/skill-workbench/experiment-policy';

test('三类实验使用独立且有上限的执行与评估并发策略', () => {
  assert.deepEqual(getSkillExperimentConcurrencyPolicy('use-case'), {
    executionConcurrency: 4,
    abPairConcurrency: 1,
    evaluationConcurrency: 4,
    triggerConcurrency: 5,
  });
  assert.deepEqual(getSkillExperimentConcurrencyPolicy('skill-ab'), {
    executionConcurrency: 4,
    abPairConcurrency: 2,
    evaluationConcurrency: 4,
    triggerConcurrency: 5,
  });
  assert.equal(getSkillExperimentConcurrencyPolicy('trigger').triggerConcurrency, 5);
});

const triggerDataset = {
  targetSkill: 'skill-a',
  tags: ['skill-workbench', 'trigger'],
  fields: [{ key: 'input' }, { key: 'should_trigger' }],
};

const useCaseDataset = {
  targetSkill: 'skill-a',
  tags: ['regression'],
  fields: [{ key: 'input' }, { key: 'expected_output' }],
};

test('触发分析数据集按标记识别并只绑定目标 Skill', () => {
  assert.equal(isSkillTriggerDataset(triggerDataset), true);
  assert.equal(isSkillExperimentDatasetEligible('trigger', triggerDataset, 'skill-a'), true);
  assert.equal(isSkillExperimentDatasetEligible('trigger', triggerDataset, 'skill-b'), false);
  assert.equal(isSkillExperimentDatasetEligible('trigger', useCaseDataset, 'skill-a'), false);
});

test('用例分析和 A/B 可跨 Skill 复用所有非触发数据集', () => {
  assert.equal(isSkillExperimentDatasetEligible('use-case', useCaseDataset, 'skill-b'), true);
  assert.equal(isSkillExperimentDatasetEligible('skill-ab', useCaseDataset, 'skill-b'), true);
  assert.equal(isSkillExperimentDatasetEligible('use-case', triggerDataset, 'skill-a'), false);
  assert.equal(isSkillExperimentDatasetEligible('skill-ab', triggerDataset, 'skill-a'), false);
});

test('触发分析锁定专用评估器，其他实验排除专用评估器', () => {
  assert.equal(isSkillExperimentEvaluatorEligible('trigger', 'skill-trigger-analyzer'), true);
  assert.equal(isSkillExperimentEvaluatorEligible('trigger', 'preset-result-answer'), false);
  assert.equal(isSkillExperimentEvaluatorEligible('use-case', 'skill-trigger-analyzer'), false);
  assert.equal(isSkillExperimentEvaluatorEligible('use-case', 'preset-result-answer'), true);
  assert.equal(isSkillExperimentEvaluatorEligible('skill-ab', 'custom-evaluator'), true);
});

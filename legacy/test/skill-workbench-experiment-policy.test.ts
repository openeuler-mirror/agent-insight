/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  getSkillExperimentConcurrencyPolicy,
  isSkillExperimentDatasetEligible,
  isSkillExperimentEvaluatorEligible,
  filterSkillExperimentEvaluators,
  isSkillTriggerDataset,
} from '@/lib/skill-workbench/experiment-policy';
import { visibleWorkbenchCaseIds } from '@/lib/skill-workbench/experiment-service';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { presetEvaluators, legacyPresetEvaluators } from '@/lib/evaluators/preset-evaluators';
import { gateEvaluator, getEvaluatorMeta } from '@/lib/evaluators/registry';

test('三类实验复用普通执行并发校验，默认 1，评估并发不随执行并发变化', () => {
  for (const preset of ['use-case', 'skill-ab', 'trigger'] as const) {
    assert.equal(getSkillExperimentConcurrencyPolicy(preset).executionConcurrency, 1);
    for (const concurrency of [1, 2, 3, 8]) {
      const policy = getSkillExperimentConcurrencyPolicy(preset, concurrency);
      assert.equal(policy.executionConcurrency, concurrency);
      assert.equal(policy.triggerConcurrency, concurrency);
      assert.equal(policy.evaluationConcurrency, 4);
    }
    for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => getSkillExperimentConcurrencyPolicy(preset, invalid), /执行并发必须为正整数/);
    }
  }
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

test('用例与 A/B 实验均显示自定义评估器，不按历史状态过滤或改写存量数据', () => {
  const cards: EvaluatorCard[] = (['draft', 'ready', 'template'] as const).map(status => ({
    ...presetEvaluators[0], id: `custom-${status}`, name: `Custom ${status}`, source: 'custom', status,
  }));
  const before = structuredClone(cards);
  for (const preset of ['use-case', 'skill-ab'] as const) {
    assert.deepEqual(filterSkillExperimentEvaluators(preset, cards), cards);
  }
  assert.deepEqual(cards, before);
  assert.deepEqual(filterSkillExperimentEvaluators('trigger', cards), []);
});

test('自定义状态调整不影响内置候选、历史停用项和触发分析专用规则', () => {
  const cards = [...presetEvaluators, ...legacyPresetEvaluators];
  for (const preset of ['use-case', 'skill-ab', 'trigger'] as const) {
    const expected = cards.filter(card => card.status === 'ready' && isSkillExperimentEvaluatorEligible(preset, card.id));
    assert.deepEqual(filterSkillExperimentEvaluators(preset, cards), expected);
  }
});

test('自定义 draft 评估器可见后，依赖参考答案的使用条件仍然生效', () => {
  const card: EvaluatorCard = {
    ...presetEvaluators[0], id: 'custom-reference', source: 'custom', status: 'draft',
    llmConfig: { model: '', systemPrompt: '对比 {{output}} 与 {{reference_output}} 并评分。' },
  };
  assert.deepEqual(filterSkillExperimentEvaluators('use-case', [card]), [card]);
  const meta = getEvaluatorMeta(card);
  const missing = gateEvaluator(card.id, meta, [{ hasReference: false, hasToolCatalog: false }]);
  assert.equal(missing.usable, false);
  assert.match(missing.reason || '', /依赖预期输出/);
  assert.equal(gateEvaluator(card.id, meta, [{ hasReference: true, hasToolCatalog: false }]).usable, true);
});

test('用例分析默认不勾选评估器', () => {
  const wizard = fs.readFileSync(
    path.join(process.cwd(), 'src/components/eval/ExperimentWizard.tsx'),
    'utf8',
  );
  const useCaseDefaults = wizard.match(/'use-case': \[(.*?)\],\n  'skill-ab':/s)?.[1];
  assert.ok(useCaseDefaults, '应保留用例分析评估器配置');
  assert.doesNotMatch(useCaseDefaults, /selected:\s*true/);
});

test('A/B 测试默认不勾选评估器', () => {
  const wizard = fs.readFileSync(
    path.join(process.cwd(), 'src/components/eval/ExperimentWizard.tsx'),
    'utf8',
  );
  const abDefaults = wizard.match(/'skill-ab': \[(.*?)\],\n};/s)?.[1];
  assert.ok(abDefaults, '应保留 A/B 测试评估器配置');
  assert.doesNotMatch(abDefaults, /selected:\s*true/);
});

test('Skill 实验列表的 Case 数排除结果页已删除的 Case', () => {
  const deleted = new Set(['case-2']);
  assert.deepEqual(visibleWorkbenchCaseIds(['case-1', 'case-2', 'case-3'], deleted), ['case-1', 'case-3']);
  assert.deepEqual(visibleWorkbenchCaseIds([1, 2], new Set(['2'])), ['1']);
  assert.equal(visibleWorkbenchCaseIds(undefined, deleted), null);
});

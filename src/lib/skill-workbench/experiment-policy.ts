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

import { SKILL_TRIGGER_ANALYZER_EVALUATOR_ID } from './trigger-evaluator';

export type SkillExperimentPresetPolicy = 'trigger' | 'use-case' | 'skill-ab';

export interface SkillExperimentConcurrencyPolicy {
  executionConcurrency: number;
  abPairConcurrency: number;
  evaluationConcurrency: number;
  triggerConcurrency: number;
}

export function getSkillExperimentConcurrencyPolicy(
  preset: SkillExperimentPresetPolicy,
): SkillExperimentConcurrencyPolicy {
  return {
    executionConcurrency: preset === 'trigger' ? 5 : 4,
    abPairConcurrency: preset === 'skill-ab' ? 2 : 1,
    evaluationConcurrency: 4,
    triggerConcurrency: 5,
  };
}

export interface SkillExperimentDatasetPolicyInput {
  targetSkill?: string | null;
  tags?: string[] | null;
  fields?: unknown[] | null;
}

export function isSkillTriggerDataset(dataset: SkillExperimentDatasetPolicyInput) {
  return Boolean(
    dataset.tags?.some((tag) => tag.trim().toLowerCase() === 'trigger')
    || dataset.fields?.some((field) => (
      typeof field === 'object' && field !== null && 'key' in field
      && String(field.key || '').trim().toLowerCase() === 'should_trigger'
    )),
  );
}

export function isSkillExperimentDatasetEligible(
  preset: SkillExperimentPresetPolicy,
  dataset: SkillExperimentDatasetPolicyInput,
  skillName: string,
) {
  const triggerDataset = isSkillTriggerDataset(dataset);
  return preset === 'trigger'
    ? triggerDataset && dataset.targetSkill === skillName
    : !triggerDataset;
}

export function isSkillExperimentEvaluatorEligible(preset: SkillExperimentPresetPolicy, evaluatorId: string) {
  return preset === 'trigger'
    ? evaluatorId === SKILL_TRIGGER_ANALYZER_EVALUATOR_ID
    : evaluatorId !== SKILL_TRIGGER_ANALYZER_EVALUATOR_ID;
}

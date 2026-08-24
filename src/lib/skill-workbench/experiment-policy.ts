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

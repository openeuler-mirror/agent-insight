import { presetEvaluators } from './preset-evaluators';
import type { EvaluatorCard } from './custom-evaluator-model';
import { readUserCustomEvaluators } from '@/server/user_evaluators_storage';
import { EvaluatorRunConfigValidationError } from './evaluator-run-config';
import {
  resolveEvaluatorExecutionConfig,
  serializeExperimentEvaluatorConfigs,
  type EvaluatorExecutionCapabilities,
} from './evaluator-execution-config';

const JUDGE_PRESETS = new Set([
  'preset-content-insensitivity', 'preset-content-controversy', 'preset-content-gender-discrimination',
  'preset-creativity-expression', 'preset-text-ai-flavor', 'preset-text-format',
  'preset-text-language-consistency', 'preset-text-conciseness', 'preset-fluency-text',
  'preset-safety-maliciousness', 'preset-safety-harmfulness', 'preset-safety-criminality', 'preset-safety-refusal',
  'preset-depth-result', 'preset-rigor-content', 'preset-agent-tool-utilization',
  'preset-agent-tool-selection', 'preset-agent-tool-success-rate', 'preset-task-completion-no-ref',
]);
const RESULT_PRESETS = new Set([
  'preset-result-accuracy', 'preset-result-answer', 'preset-result-faithfulness', 'preset-result-instruction',
]);

function timeoutSeconds(value: string | undefined, fallback: number): number {
  const seconds = Math.ceil(Number(value) / 1000);
  return Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600 ? seconds : fallback;
}

export function getEvaluatorExecutionCapabilities(custom: EvaluatorCard[]): EvaluatorExecutionCapabilities {
  const capabilities: EvaluatorExecutionCapabilities = {};
  const judgeTimeout = timeoutSeconds(process.env.EXPERIMENT_JUDGE_TIMEOUT_MS, 180);
  const resultTimeout = timeoutSeconds(process.env.RESULT_QUALITY_TIMEOUT_MS || process.env.JUDGMENT_TIMEOUT_MS, 300);
  for (const card of presetEvaluators) {
    if (JUDGE_PRESETS.has(card.id) || RESULT_PRESETS.has(card.id)) {
      capabilities[card.id] = { attemptTimeoutSeconds: RESULT_PRESETS.has(card.id) ? resultTimeout : judgeTimeout, maxRetries: 2 };
    }
  }
  for (const card of custom) {
    if (card.id?.startsWith('custom-') && card.evaluatorType === 'LLM' && card.llmConfig?.systemPrompt && !card.llmConfig.skills?.length) {
      capabilities[card.id] = { attemptTimeoutSeconds: judgeTimeout, maxRetries: 2 };
    }
  }
  return capabilities;
}

export async function prepareExperimentEvaluatorConfigs(
  user: string, selectedIds: string[], textConfigs: unknown, executionConfig: unknown,
): Promise<string> {
  if (executionConfig === undefined) return serializeExperimentEvaluatorConfigs(textConfigs, selectedIds);
  const custom = await readUserCustomEvaluators(user) as EvaluatorCard[];
  const known = new Set([...presetEvaluators, ...custom].map((card) => card.id));
  for (const id of selectedIds) {
    if (!known.has(id) && !id.startsWith('benchmark:')) {
      throw new EvaluatorRunConfigValidationError(`未找到当前用户可用的评估器 ${id}`);
    }
  }
  return serializeExperimentEvaluatorConfigs(textConfigs, selectedIds,
    resolveEvaluatorExecutionConfig(executionConfig, selectedIds, getEvaluatorExecutionCapabilities(custom)));
}

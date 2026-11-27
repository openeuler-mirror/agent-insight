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
  'preset-agent-process-quality', 'preset-agent-step-efficiency', 'preset-hallucination-text',
  'preset-ras-reliability-detection-recovery', 'preset-similarity-text', 'preset-similarity-answer-match',
]);
const SCORING_PRESETS = new Set(['preset-agent-task-completion', 'preset-agent-trace-quality']);
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
    if (JUDGE_PRESETS.has(card.id) || RESULT_PRESETS.has(card.id) || SCORING_PRESETS.has(card.id)) {
      const timeout = card.id === 'preset-agent-trace-quality' ? 300
        : card.id === 'preset-agent-task-completion' ? 180 : RESULT_PRESETS.has(card.id) ? resultTimeout : judgeTimeout;
      capabilities[card.id] = { attemptTimeoutSeconds: timeout, maxRetries: 2,
        ...(SCORING_PRESETS.has(card.id) ? { scopeNote: '仅配置评分阶段，Skill 分析和附加建议沿用系统策略。' }
          : card.id === 'preset-ras-reliability-detection-recovery' ? { scopeNote: '仅配置评分阶段，不重新执行 Agent 或注入故障。' } : {}) };
    }
  }
  for (const card of custom) {
    if (card.id?.startsWith('custom-') && card.evaluatorType === 'LLM' && card.llmConfig?.systemPrompt) {
      capabilities[card.id] = { attemptTimeoutSeconds: card.llmConfig.skills?.length ? 180 : judgeTimeout, maxRetries: 2,
        ...(card.llmConfig.skills?.length ? { scopeNote: '超时和重试作用于 OpenCode 评估执行。' } : {}) };
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

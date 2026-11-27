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

/** Agent Tool/Skill 专项评估器的族级归属判断与单行分发入口。 */
import type { EvaluatorOutput } from '@/lib/evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import {
  TOOL_SELECTION_PRESET_ID,
  runToolSelectionPreset,
} from './agent-tool-selection-evaluator';
import {
  TOOL_UTILIZATION_PRESET_ID,
  runToolUtilizationPreset,
} from './agent-tool-utilization-evaluator';
import {
  TOOL_SUCCESS_RATE_PRESET_ID,
  runToolSuccessRatePreset,
} from './agent-tool-success-rate-evaluator';

export const AGENT_TOOL_PRESET_IDS = [
  TOOL_UTILIZATION_PRESET_ID,
  TOOL_SELECTION_PRESET_ID,
  TOOL_SUCCESS_RATE_PRESET_ID,
] as const;

export type AgentToolPresetId = (typeof AGENT_TOOL_PRESET_IDS)[number];

export function isAgentToolPresetId(id: string): id is AgentToolPresetId {
  return (AGENT_TOOL_PRESET_IDS as readonly string[]).includes(id);
}

export async function runAgentToolPreset(
  id: AgentToolPresetId,
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  switch (id) {
    case TOOL_UTILIZATION_PRESET_ID:
      return runToolUtilizationPreset(user, ctx);
    case TOOL_SELECTION_PRESET_ID:
      return runToolSelectionPreset(user, ctx);
    case TOOL_SUCCESS_RATE_PRESET_ID:
      return runToolSuccessRatePreset(user, ctx);
  }
}

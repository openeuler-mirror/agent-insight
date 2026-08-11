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

import {
  evaluateTrajectoryViaOpencode,
  type TrajectoryEvalInput,
} from '@/lib/engine/evaluation/opencode-trajectory-evaluator';
import {
  buildSkillKeyActionComparison,
  getPrimaryExecutionSkillTargets,
  loadTaskCompletionSkillContext,
  skillKeyActionComparisonMessage,
  type KeyActionExecutionLike,
} from '@/lib/engine/evaluation/key-action-trace-analysis';
import type { AgentDebugSkillsAnalysis, AgentDebugSkillsKeyActionResult } from './types';

export async function runAgentDebugSkillsAnalysis(args: {
  execution: KeyActionExecutionLike;
  interactions: unknown[];
  user: string;
  interactionHash: string;
}): Promise<AgentDebugSkillsAnalysis> {
  const executionId = String(args.execution.id || args.execution.taskId || '').trim();
  const taskId = String(args.execution.taskId || args.execution.id || '').trim();
  const interactions = Array.isArray(args.interactions) ? args.interactions : [];
  const comparison = await buildSkillKeyActionComparison(args.execution, taskId, args.user, interactions);
  if (comparison.status !== 'ok') {
    throw new Error(skillKeyActionComparisonMessage(comparison));
  }

  const skillTargets = getPrimaryExecutionSkillTargets(args.execution, interactions);
  const primarySkill = skillTargets[0] || null;
  const input: TrajectoryEvalInput = {
    caseId: `agent-debug:${executionId || taskId}`,
    caseInput: String(args.execution.query || taskId || executionId || '').trim(),
    referenceOutput: '',
    referenceTrajectory: '',
    referenceKeyActionsText: comparison.referenceKeyActionsText,
    actualExtractedStepsText: comparison.actualExtractedStepsText,
    referenceKeyActions: comparison.referenceKeyActions,
    actualExtractedSteps: comparison.actualExtractedSteps,
    skillContext: await loadTaskCompletionSkillContext(args.execution, interactions, args.user),
    comparisonMode: 'skill_key_actions',
    evaluationFocus: 'AgentDebug Skills 分析：逐条判断当前 trace 是否覆盖 Skill 关键动作，并给出可解释证据。',
    actualInteractions: interactions,
    taskId: taskId || undefined,
    executionId: executionId || undefined,
  };

  const out = await evaluateTrajectoryViaOpencode(
    input,
    args.user,
    primarySkill?.skill || null,
    primarySkill?.version ?? null,
  );

  const now = new Date().toISOString();
  return {
    status: 'done',
    source: 'agent-debug',
    generatedAt: now,
    updatedAt: now,
    interactionHash: args.interactionHash,
    errorMessage: null,
    reasonText: out.reasonText,
    skillKeyActionComparison: {
      status: comparison.status,
      referenceKeyActionCount: comparison.referenceKeyActions.length,
      actualExtractedStepCount: comparison.actualExtractedSteps.length,
    },
    keyActionResults: (out.keyActionResults || []).map(normalizeKeyActionResult),
  };
}

export function failedAgentDebugSkillsAnalysis(args: {
  interactionHash: string;
  errorMessage: string;
}): AgentDebugSkillsAnalysis {
  const now = new Date().toISOString();
  return {
    status: 'failed',
    source: 'agent-debug',
    generatedAt: now,
    updatedAt: now,
    interactionHash: args.interactionHash,
    errorMessage: args.errorMessage,
    keyActionResults: [],
  };
}

export function runningAgentDebugSkillsAnalysis(args: {
  interactionHash: string;
}): AgentDebugSkillsAnalysis {
  const now = new Date().toISOString();
  return {
    status: 'running',
    source: 'agent-debug',
    generatedAt: now,
    updatedAt: now,
    interactionHash: args.interactionHash,
    errorMessage: null,
    keyActionResults: [],
  };
}

function normalizeKeyActionResult(item: AgentDebugSkillsKeyActionResult): AgentDebugSkillsKeyActionResult {
  return {
    actionId: String(item.actionId || '').trim(),
    actionContent: String(item.actionContent || '').trim(),
    coverage: item.coverage,
    severity: item.severity,
    traceComparisonAnalysis: String(item.traceComparisonAnalysis || '').trim(),
    skillImprovementSuggestion: String(item.skillImprovementSuggestion || '').trim(),
  };
}

import type { EvaluatorOutput, EvalPoint } from '@/lib/evaluators/eval-output';
import {
  type AgentTrajectoryAssessment,
  trajectoryIssueAffectsDimension,
} from '../evaluation/agent-trajectory-assessment';
import { runAgentTrajectoryJudge } from '../evaluation/agent-trajectory-judge';
import { buildAgentStepEfficiencyPrompt } from '@/prompts/agent-step-efficiency-prompt';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';

export const AGENT_TRAJECTORY_PRESET_IDS = [
  'preset-agent-step-efficiency',
] as const;

export type AgentTrajectoryPresetId = (typeof AGENT_TRAJECTORY_PRESET_IDS)[number];

export function isAgentTrajectoryPresetId(id: string): id is AgentTrajectoryPresetId {
  return (AGENT_TRAJECTORY_PRESET_IDS as readonly string[]).includes(id);
}

const DIMENSION_LABELS: Record<string, string> = {
  step_necessity: '步骤必要性',
  path_detour: '路径绕行',
  cost_efficiency: '成本效率',
  step_density: '步骤密度',
  retry_efficiency: '重试效率',
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim()))];
}

function assessmentToEvaluatorOutput(assessment: AgentTrajectoryAssessment): EvaluatorOutput {
  const points: EvalPoint[] = assessment.dimensions.map(dimension => {
    const issues = assessment.issues.filter(issue => (
      trajectoryIssueAffectsDimension(issue, dimension.dimension)
    ));
    return {
      label: DIMENSION_LABELS[dimension.dimension] ?? dimension.dimension,
      score: dimension.score,
      status: dimension.status,
      evidence: {
        json: {
          dimension: dimension.dimension,
          verdict: dimension.verdict,
          reason: dimension.reason,
          issues,
        },
      },
      suggestion: dimension.suggestion,
      anchors: unique(dimension.anchors),
    };
  });
  const suggestions = unique([
    ...assessment.dimensions.map(dimension => dimension.suggestion),
    ...assessment.issues.map(issue => issue.suggestion),
  ]);
  const evidenceJson = {
    schemaVersion: 1,
    rubricVersion: assessment.rubricVersion,
    dimensions: assessment.dimensions,
    issues: assessment.issues,
    discardedIssues: assessment.discardedIssues,
    suggestions,
    factsSummary: assessment.factsSummary,
    baseScore: assessment.baseScore,
    appliedCaps: assessment.appliedCaps,
    finalScore: assessment.score,
  };
  return {
    verdict: assessment.score >= 80 ? 'pass' : assessment.score >= 60 ? 'warn' : 'fail',
    summary: assessment.summary,
    score: assessment.score,
    points,
    evidence: { json: evidenceJson },
  };
}

export async function runAgentTrajectoryPreset(
  id: AgentTrajectoryPresetId,
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  const { callJudgeLlm } = await import('./judge-llm');
  const assessment = await runAgentTrajectoryJudge({
    kind: 'step-efficiency',
    task: ctx.caseInput,
    interactions: ctx.interactions,
  }, (_ignored, request) => callJudgeLlm(user, request), buildAgentStepEfficiencyPrompt);
  return assessmentToEvaluatorOutput(assessment);
}

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

import type { EvaluatorOutput, EvalPoint } from '@/lib/evaluators/eval-output';
import {
  type AgentTrajectoryAssessment,
  trajectoryIssueAffectsDimension,
} from '../evaluation/agent-trajectory-assessment';
import { runAgentTrajectoryJudge } from '../evaluation/agent-trajectory-judge';
import { buildAgentProcessQualityPrompt } from '@/prompts/agent-process-quality-prompt';
import { buildAgentStepEfficiencyPrompt } from '@/prompts/agent-step-efficiency-prompt';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';

export const AGENT_TRAJECTORY_PRESET_IDS = [
  'preset-agent-step-efficiency',
  'preset-agent-process-quality',
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
  goal_alignment: '目标对齐',
  planning_completeness: '规划完整性',
  reasoning_coherence: '推理连贯性',
  exception_handling: '异常处理',
  path_robustness: '路径稳健性',
  information_utilization: '信息利用',
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
  const kind = id === 'preset-agent-step-efficiency' ? 'step-efficiency' : 'process-quality';
  const buildPrompt = id === 'preset-agent-step-efficiency'
    ? buildAgentStepEfficiencyPrompt
    : buildAgentProcessQualityPrompt;
  const { callJudgeLlm } = await import('./judge-llm');
  const assessment = await runAgentTrajectoryJudge({
    kind,
    task: ctx.caseInput,
    interactions: ctx.interactions,
  }, (_ignored, request) => callJudgeLlm(user, request), buildPrompt);
  return assessmentToEvaluatorOutput(assessment);
}

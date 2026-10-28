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

import { resolveAgentOptions, type AgentOptions, type RuntimeDefinition } from '../../../packages/agent-runtime/index.cjs';
import { listClientTraceGenerationTargets, type ClientTraceGenerationTarget } from '@/lib/engine/experiment/execution-targets';
import { skillExecutionCapabilityIssue } from './experiment-policy';
import { TraceGenerationError } from '@/lib/engine/experiment/trace-generation';

export interface SkillExecutionTarget {
  workerId: string;
  host: string;
  platform: string;
  agent: string;
  model: string | null;
  agentOptions?: AgentOptions;
  agentParameterDefinition?: RuntimeDefinition;
}

export interface SkillExecutionSnapshot {
  name: string;
  version: number;
  files: Record<string, string>;
}

export async function validateSkillExecutionTarget(user: string, value: unknown, requireTriggerRouting = false): Promise<SkillExecutionTarget> {
  return selectSkillExecutionTarget(value, await listClientTraceGenerationTargets(user), requireTriggerRouting);
}

export function selectSkillExecutionTarget(value: unknown, targets: ClientTraceGenerationTarget[], requireTriggerRouting = false): SkillExecutionTarget {
  const input = value as Partial<SkillExecutionTarget> | null;
  if (!input?.workerId || !input.platform || !input.agent) {
    throw new TraceGenerationError('execution_target_required', '请选择 Skill 实验的运行主机、平台和 Agent；旧实验请重新创建', 400);
  }
  const target = targets.find((item) => (
    item.workerId === input.workerId && item.platform === input.platform && item.agent === input.agent
  ));
  if (!target) throw new TraceGenerationError('execution_target_unavailable', '所选执行目标已离线或不可用');
  const issue = skillExecutionCapabilityIssue(target, requireTriggerRouting);
  if (issue) throw new TraceGenerationError(issue.code, issue.message, 409);
  const model = typeof input.model === 'string' ? input.model.trim() || null : null;
  if (model && !target.models.some((item) => item.id === model)) {
    throw new TraceGenerationError('MODEL_UNAVAILABLE', `所选客户端未提供模型 ${model}，不会回退默认模型`, 400);
  }
  const resolved = resolveAgentOptions(target.parameterDefinitions || [], target.platform, target.agent, input.agentOptions);
  return { workerId: target.workerId, host: target.host, platform: target.platform, agent: target.agent, model,
    ...(resolved.agentOptions ? { agentOptions: resolved.agentOptions, agentParameterDefinition: resolved.definition } : {}) };
}

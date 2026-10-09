import { listClientTraceGenerationTargets, type ClientTraceGenerationTarget } from '@/lib/engine/experiment/execution-targets';
import { TraceGenerationError } from '@/lib/engine/experiment/trace-generation';

export interface SkillExecutionTarget {
  workerId: string;
  host: string;
  platform: string;
  agent: string;
  model: string | null;
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
  if (target.platform !== 'opencode' || !target.supportsSkillSnapshot) {
    throw new TraceGenerationError('skill_execution_unsupported', 'Skill 实验需要支持版本隔离的 OpenCode 客户端，请升级客户端后重试', 409);
  }
  if (requireTriggerRouting && !target.supportsTriggerRouting) {
    throw new TraceGenerationError('trigger_execution_unsupported', '触发分析需要支持只读路由评测的新版 OpenCode 客户端，请升级客户端后重试', 409);
  }
  const model = typeof input.model === 'string' ? input.model.trim() || null : null;
  if (model && !target.models.some((item) => item.id === model)) {
    throw new TraceGenerationError('MODEL_UNAVAILABLE', `所选客户端未提供模型 ${model}，不会回退默认模型`, 400);
  }
  return { workerId: target.workerId, host: target.host, platform: target.platform, agent: target.agent, model };
}

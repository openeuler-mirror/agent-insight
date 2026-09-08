import { readJsonResponse } from './transport';
import { z } from 'zod';
import { targetSchema, loadedSkillSchema, type SkillOverride, type Target, type TurnEvidence } from './domain';
import { credentialConfig } from './store';
const responseSchema = z.object({
  loadedSkills: z.array(loadedSkillSchema).max(100).optional(),
  targetVersion: z.string().optional(),
  model: z.string().optional(),
  output: z.string().max(100000),
  systemPrompt: z.string().max(20000).optional(),
  skill: z.string().optional(),
  state: z.string().optional(),
  sessionId: z.string().optional(),
  tools: z.array(z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    result: z.unknown().optional()
  })).max(100).optional()
});
export class InfrastructureError extends Error {}
export class SkillConfirmationError extends Error {}
export async function executeTurn(user: string, target: Target, input: string, history: TurnEvidence[], signal: AbortSignal, context?: {
  runId: string;
  caseId: string;
  attemptId: string;
  turn: number;
  skillOverrides?: SkillOverride[];
}): Promise<TurnEvidence> {
  let endpoint = target.adapter === 'demo' ? process.env.EVALUATION_DEMO_URL : target.endpoint;
  if (!endpoint) throw new Error('目标执行地址未配置，Demo 需设置 EVALUATION_DEMO_URL');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('无效目标地址');
  let authorization: string | undefined;
  if (target.credentialId) authorization = 'Bearer ' + (await credentialConfig(user, target.credentialId)).apiKey;
  const start = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? {
          authorization
        } : {})
      },
      body: JSON.stringify({
        targetId: target.externalId,
        ...(context?.skillOverrides?.length ? {agentId:target.externalId} : {}),
        targetVersion: target.externalVersion,
        ...(target.model ? {model:target.model} : {}),
        behavior: target.behavior,
        input,
        history,
        ...context,
        sessionId: history.at(-1)?.sessionId
      }),
      signal,
      redirect: 'error'
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new InfrastructureError('目标连接失败');
  }
  if (response.status === 429 || response.status >= 500) throw new InfrastructureError('目标暂时不可用：HTTP ' + response.status);
  if (!response.ok) throw new Error('目标拒绝执行：HTTP ' + response.status);
  const parsed = responseSchema.parse(await readJsonResponse(response, 600000));
  if (parsed.targetVersion && target.externalVersion && parsed.targetVersion !== target.externalVersion) throw new Error('目标返回版本与本次要求不一致');
  if (context?.skillOverrides?.length) {
    if (target.type !== 'agent' || (target.externalVersion && parsed.targetVersion !== target.externalVersion)) throw new SkillConfirmationError('执行端未确认共享 Agent 版本，不能作为 Skill 对比结果');
    for (const requested of context.skillOverrides) {
      const loaded = parsed.loadedSkills?.filter(skill=>skill.skillId === requested.skillId) || [];
      if (loaded.length !== 1 || loaded[0].skillVersion !== requested.skillVersion || loaded[0].definitionHash !== requested.definitionHash) throw new SkillConfirmationError('执行端未确认本组 Skill 版本及内容，需支持 Skill 加载协议；本次未评完整');
    }
  }
  if (target.model && parsed.model !== target.model) throw new Error('执行端未确认本组模型，不能作为模型对比结果');
  return {
    input,
    ...parsed,
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - start
  };
}
export async function readDemoTargets() {
  const endpoint = process.env.EVALUATION_DEMO_URL;
  if (!endpoint) throw new Error('先启动 Demo 服务并设置 EVALUATION_DEMO_URL');
  const response = await fetch(new URL('/targets', endpoint), {
    signal: AbortSignal.timeout(10000),
    redirect: 'error'
  });
  if (!response.ok) throw new Error('无法读取 Demo 目标目录');
  return z.array(z.object({
    assetKey: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    version: z.number().int().positive(),
    content: targetSchema
  })).max(50).parse(await readJsonResponse(response));
}

import { createHash } from 'node:crypto';
import { z } from 'zod';
const text = z.string().max(20000);
const toolRule = z.object({
  name: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional()
});
export const expectationSchema = z.object({
  contains: text.optional(),
  pattern: z.string().max(200).optional(),
  expectedSkill: z.string().max(200).optional(),
  state: z.string().max(200).optional(),
  requiredTools: z.array(toolRule).max(30).default([]),
  forbiddenTools: z.array(z.string().min(1).max(200)).max(30).default([]),
  toolOrder: z.array(z.string()).max(30).default([]),
  fields: z.array(z.object({
    path: z.string().min(1).max(200),
    type: z.enum(['string', 'number', 'boolean', 'array', 'object']).optional(),
    required: z.boolean().default(true),
    equals: z.unknown().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    enum: z.array(z.unknown()).optional()
  })).max(50).default([]),
  blocking: z.boolean().default(true)
}).superRefine((e, ctx) => {
  if (e.requiredTools.some(t => e.forbiddenTools.includes(t.name))) ctx.addIssue({
    code: 'custom',
    message: '同一工具不能同时必须调用和禁止调用'
  });
  if (e.pattern) {
    try {
      new RegExp(e.pattern);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: '正则表达式无效'
      });
    }
  }
});
export const caseSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  category: z.enum(['positive', 'negative', 'boundary']).default('positive'),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  tags: z.array(z.string().max(100)).max(20).default([]),
  note: text.default(''),
  turns: z.array(z.object({
    input: text.min(1),
    expectedOutput: text.default(''),
    expectation: expectationSchema.default({})
  })).min(1).max(20)
});
export const datasetSchema = z.object({
  cases: z.array(caseSchema).min(1).max(500)
}).superRefine((d, c) => {
  if (new Set(d.cases.map(x => x.id)).size !== d.cases.length) c.addIssue({
    code: 'custom',
    message: 'Case ID 不能重复'
  });
});
export const targetSchema = z.object({
  type: z.enum(['agent', 'skill']),
  adapter: z.enum(['http', 'demo']),
  endpoint: z.string().url().optional(),
  externalId: z.string().min(1).max(200),
  externalVersion: z.string().max(200).optional(),
  prompt: text.default(''),
  skills: z.array(z.object({
    name: z.string().min(1).max(200),
    description: text,
    prompt: text.default('')
  })).max(100).default([]),
  tools: z.array(z.object({
    name: z.string().min(1).max(200),
    description: text.default(''),
    parameters: z.record(z.string(), z.unknown()).default({})
  })).max(100).default([]),
  credentialId: z.string().optional(),
  model: z.string().min(1).max(200).optional(),
  behavior: z.enum(['baseline', 'fixed']).optional()
}).superRefine((t, c) => {
  if (t.adapter === 'http' && !t.endpoint) c.addIssue({
    code: 'custom',
    message: 'HTTP 目标需要 endpoint'
  });
});
export const evaluatorSchema = z.object({
  checkNames: z.array(z.enum(['路由','结束状态','文本包含','正则匹配','必须工具','禁止工具','工具参数','工具顺序','JSON 结构','字段校验'])).min(1).optional(),
  type: z.enum(['rules', 'llm']),
  prompt: text.default(''),
  criticalStop: z.boolean().default(false),
  credentialId: z.string().optional()
});
export type EvalCase = z.infer<typeof caseSchema>;
export type Target = z.infer<typeof targetSchema>;
export const loadedSkillSchema = z.object({
  skillId: z.string().min(1).max(200),
  skillVersion: z.string().min(1).max(200),
  definitionHash: z.string().min(1).max(128),
});
export type LoadedSkill = z.infer<typeof loadedSkillSchema>;
export type SkillOverride = LoadedSkill & {definition: Pick<Target,'prompt'|'skills'|'tools'>};
export function skillOverrideFor(asset: {version:number;content:Target}): SkillOverride {
  const content = targetSchema.parse(asset.content);
  if (content.type !== 'skill') throw new Error('覆盖配置必须来自 Skill 版本');
  const definition = {prompt:content.prompt,skills:content.skills,tools:content.tools};
  return {skillId:content.externalId,skillVersion:content.externalVersion || `v${asset.version}`,definitionHash:hash(definition),definition};
}
export type Evaluator = z.infer<typeof evaluatorSchema>;
export type Verdict = 'pass' | 'fail' | 'unknown';
export interface TurnEvidence {
  loadedSkills?: LoadedSkill[];
  targetVersion?: string;
  input: string;
  output: string;
  systemPrompt?: string;
  sessionId?: string;
  skill?: string;
  state?: string;
  tools?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
  }>;
  model?: string;
  durationMs?: number;
  startedAt?: string;
  finishedAt?: string;
}
export interface Check {
  skipped?: boolean;
  evaluatorId?: string;
  turn: number;
  name: string;
  verdict: Verdict;
  reason: string;
  blocking: boolean;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function hash(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /api.?key|authorization|password|secret|token/i.test(k) ? '[REDACTED]' : redact(v)]));
  if (typeof value === 'string') return value.replace(/Bearer\s+\S+|\bsk-[a-zA-Z0-9_-]{12,}/g, '[REDACTED]');
  return value;
}
export function verdict(checks: Check[]): Verdict {
  return checks.some(x => x.verdict === 'fail') ? 'fail' : !checks.length || checks.some(x => x.verdict === 'unknown') ? 'unknown' : 'pass';
}

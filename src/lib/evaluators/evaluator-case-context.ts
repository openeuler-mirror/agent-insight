/**
 * Case 级评估上下文契约与转换函数。
 *
 * EvaluatorCaseContext 是业务代码使用的当前上下文类型，底层 V1 契约保存评估发生时显式
 * 可用的 Tool/Skill 目录；它可以来自实验 API、
 * 数据集的 available_tools / available_skills，也可以从 ExperimentCase.evaluatorContextJson
 * 读回。这里统一负责校验、规范化、序列化、存量 JSON 解析和能力名称匹配，不执行评分。
 *
 * 缺少上下文表示无法评估工具类指标；显式 availableTools=[] 则表示调用方确认没有可用
 * Tool，仍是有效上下文。availableSkills 可选，Agent 和子 Agent 不属于该能力目录。
 */
export const EVALUATOR_CASE_CONTEXT_SCHEMA_VERSION = 1 as const;

export type EvaluatorCapabilityKind = 'tool' | 'skill';

/** OpenCode/Jiuwen 的 Skill 加载入口；实际能力名称来自调用参数或 availableSkills。 */
export const SKILL_LOADER_TOOL_NAMES = new Set([
  'skill', 'load_skill', 'skill_view', 'skill_tool',
]);

export interface EvaluatorToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type EvaluatorSkillDescriptor = EvaluatorToolDescriptor;

export interface EvaluatorCapabilityDescriptor extends EvaluatorToolDescriptor {
  kind: EvaluatorCapabilityKind;
}

export interface EvaluatorCaseContextV1 {
  schemaVersion: typeof EVALUATOR_CASE_CONTEXT_SCHEMA_VERSION;
  availableTools: EvaluatorToolDescriptor[];
  availableSkills?: EvaluatorSkillDescriptor[];
}

/** 业务代码使用当前别名；版本后缀只保留在持久化 schema 定义中。 */
export type EvaluatorCaseContext = EvaluatorCaseContextV1;

export class EvaluatorContextValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluatorContextValidationError';
  }
}

export interface StoredEvaluatorContextResult {
  context: EvaluatorCaseContext | null;
  error: string | null;
}

export function canonicalToolName(name: string): string {
  return name.trim().toLowerCase();
}

export function isSkillLoaderToolName(name: string): boolean {
  return SKILL_LOADER_TOOL_NAMES.has(canonicalToolName(name));
}

export function canonicalCapabilityKey(kind: EvaluatorCapabilityKind, name: string): string {
  return `${kind}:${canonicalToolName(name)}`;
}

export function listEvaluatorCapabilities(context: EvaluatorCaseContext): EvaluatorCapabilityDescriptor[] {
  return [
    ...context.availableTools.map((tool) => ({ ...tool, kind: 'tool' as const })),
    ...(context.availableSkills ?? []).map((skill) => ({ ...skill, kind: 'skill' as const })),
  ];
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new EvaluatorContextValidationError('evaluatorContext 不是有效 JSON');
  }
}

function cloneJsonValue(value: unknown, capabilityName: string): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new Error('not JSON serializable');
    }
    return JSON.parse(json);
  } catch {
    throw new EvaluatorContextValidationError(`能力 ${capabilityName} 的 inputSchema 不是有效 JSON`);
  }
}

function normalizeAvailableDescriptors(value: unknown, fieldName: string): EvaluatorToolDescriptor[] {
  if (!Array.isArray(value)) {
    throw new EvaluatorContextValidationError(`${fieldName} 必须是数组`);
  }
  const seen = new Set<string>();
  const tools: EvaluatorToolDescriptor[] = [];
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new EvaluatorContextValidationError(`${fieldName}[${index}] 必须是对象`);
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new EvaluatorContextValidationError(`${fieldName}[${index}].name 不能为空`);
    }
    const name = raw.name.trim();
    const canonical = canonicalToolName(name);
    // OpenCode 的 skill/load_skill 是加载入口，不是独立 Tool；实际 Skill 由 availableSkills 描述。
    if (fieldName === 'availableTools' && isSkillLoaderToolName(name)) return;
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const tool: EvaluatorToolDescriptor = { name };
    if (typeof raw.description === 'string' && raw.description.trim()) {
      tool.description = raw.description.trim();
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'inputSchema')) {
      tool.inputSchema = cloneJsonValue(raw.inputSchema, name);
    }
    tools.push(tool);
  });
  return tools;
}

export function normalizeEvaluatorCaseContext(value: unknown): EvaluatorCaseContext | null {
  const parsed = parseJsonValue(value);
  if (parsed === null || parsed === undefined) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EvaluatorContextValidationError('evaluatorContext 必须是对象');
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion !== EVALUATOR_CASE_CONTEXT_SCHEMA_VERSION) {
    throw new EvaluatorContextValidationError('evaluatorContext.schemaVersion 必须为 1');
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'availableTools')) {
    throw new EvaluatorContextValidationError('evaluatorContext.availableTools 缺失');
  }
  const hasAvailableSkills = Object.prototype.hasOwnProperty.call(raw, 'availableSkills') && raw.availableSkills !== null;
  return {
    schemaVersion: EVALUATOR_CASE_CONTEXT_SCHEMA_VERSION,
    availableTools: normalizeAvailableDescriptors(raw.availableTools, 'availableTools'),
    ...(hasAvailableSkills
      ? { availableSkills: normalizeAvailableDescriptors(raw.availableSkills, 'availableSkills') }
      : {}),
  };
}

export function contextFromAvailableCatalogFields(
  availableTools: unknown,
  availableSkills?: unknown,
): EvaluatorCaseContext | null {
  const parsedTools = parseJsonValue(availableTools);
  if (parsedTools === null || parsedTools === undefined) return null;
  const parsedSkills = availableSkills === undefined ? undefined : parseJsonValue(availableSkills);
  const skillCatalog = parsedSkills === null ? undefined : parsedSkills;
  if (Array.isArray(parsedTools)) {
    return normalizeEvaluatorCaseContext({
      schemaVersion: EVALUATOR_CASE_CONTEXT_SCHEMA_VERSION,
      availableTools: parsedTools,
      ...(skillCatalog === undefined ? {} : { availableSkills: skillCatalog }),
    });
  }
  if (!parsedTools || typeof parsedTools !== 'object') {
    return normalizeEvaluatorCaseContext(parsedTools);
  }
  const raw = parsedTools as Record<string, unknown>;
  return normalizeEvaluatorCaseContext(
    skillCatalog === undefined || Object.prototype.hasOwnProperty.call(raw, 'availableSkills')
      ? raw
      : { ...raw, availableSkills: skillCatalog },
  );
}

export function serializeEvaluatorCaseContext(value: unknown): string | null {
  const context = normalizeEvaluatorCaseContext(value);
  return context ? JSON.stringify(context) : null;
}

export function parseStoredEvaluatorCaseContext(value: string | null | undefined): StoredEvaluatorContextResult {
  try {
    return { context: normalizeEvaluatorCaseContext(value), error: null };
  } catch (error) {
    return {
      context: null,
      error: error instanceof Error ? error.message : 'evaluatorContext 无法解析',
    };
  }
}

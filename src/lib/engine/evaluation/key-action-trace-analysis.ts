import { db } from '@/lib/storage/prisma';
import {
  analyzeDynamicOnly,
  extractKeyActionsFromFlow,
  mergeKeyActionsFromMultipleSkills,
  parseSkillFlow,
  type ExtractedKeyAction,
  type ParsedFlowResult,
} from '@/lib/engine/observability/flow-parser';
import { getRootSkillFromInteractions } from '@/lib/engine/observability/skill-scope';
import type { TaskCompletionEvalInput } from './opencode-task-completion-evaluator';

export interface SkillTarget {
  skill: string;
  version: number | null;
}

export interface ExtractedTraceStep {
  uiStepIndex?: number;
  name?: string;
  description?: string;
  dialogStartIndex?: number;
  dialogEndIndex?: number;
  type?: 'action' | 'decision' | 'output';
}

export interface KeyActionExecutionLike {
  id?: string | null;
  taskId?: string | null;
  query?: string | null;
  finalResult?: string | null;
  skill?: string | null;
  skillVersion?: number | null;
  invokedSkills?: string | null;
  skills?: string | null;
}

export type SkillKeyActionComparisonResult =
  | {
      status: 'ok';
      referenceKeyActionsText: string;
      actualExtractedStepsText: string;
      referenceKeyActions: ExtractedKeyAction[];
      actualExtractedSteps: ExtractedTraceStep[];
    }
  | { status: 'no-skill-targets' }
  | { status: 'missing-skill'; missingSkills: string[] }
  | { status: 'missing-parsed-flow'; missingSkills: string[] }
  | { status: 'dynamic-analysis-failed' }
  | { status: 'no-extracted-steps' }
  | { status: 'no-key-actions' };

export function normalizeOptionalVersion(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function getPrimaryExecutionSkillTargets(
  execution: KeyActionExecutionLike | null | undefined,
  interactions?: unknown,
): SkillTarget[] {
  const rootSkill = getRootSkillFromInteractions(interactions);
  const skill = rootSkill?.name || execution?.skill;
  const normalized = String(skill || '').trim();
  if (!normalized) return [];
  return [{
    skill: normalized,
    version: rootSkill?.version ?? normalizeOptionalVersion(execution?.skillVersion),
  }];
}

export async function loadTaskCompletionSkillContext(
  execution: KeyActionExecutionLike | null | undefined,
  interactions: unknown,
  user?: string | null,
): Promise<TaskCompletionEvalInput['skillContext'] | undefined> {
  const targets = getPrimaryExecutionSkillTargets(execution, interactions);
  if (targets.length === 0) return undefined;

  const invokedSkills: NonNullable<NonNullable<TaskCompletionEvalInput['skillContext']>['invokedSkills']> = [];
  for (const target of targets) {
    const skillRecord = await db.findSkill(target.skill, user || null);
    if (!skillRecord?.id) {
      invokedSkills.push({ name: target.skill, version: target.version });
      continue;
    }

    const fullSkill = await db.findSkillById(skillRecord.id);
    const resolvedVersion = target.version
      ?? fullSkill?.activeVersion
      ?? fullSkill?.versions?.[0]?.version
      ?? null;
    const versionRow = resolvedVersion != null
      ? await db.findSkillVersion(skillRecord.id, resolvedVersion).catch(() => null)
      : null;
    const content = String(versionRow?.content || '').trim();
    invokedSkills.push({
      name: target.skill,
      version: resolvedVersion,
      content: content ? content.slice(0, 12_000) : undefined,
    });
  }

  return invokedSkills.length > 0 ? { invokedSkills } : undefined;
}

export async function extractSkillKeyActionsFromTargets(targets: SkillTarget[], user?: string | null): Promise<ExtractedKeyAction[]> {
  const allActions: { name: string; actions: ExtractedKeyAction[] }[] = [];

  for (const target of targets) {
    const skillRecord = await db.findSkill(target.skill, user || null);
    if (!skillRecord?.id) continue;

    const fullSkill = await db.findSkillById(skillRecord.id);
    const resolvedVersion = target.version
      ?? fullSkill?.activeVersion
      ?? fullSkill?.versions?.[0]?.version
      ?? null;
    if (resolvedVersion == null) continue;

    const parsedFlow = await db.findParsedFlow(skillRecord.id, resolvedVersion, user || null);
    if (!parsedFlow?.flowJson) continue;

    const flow: ParsedFlowResult = JSON.parse(parsedFlow.flowJson);
    const actions = extractKeyActionsFromFlow(flow).map(action => ({
      ...action,
      skillSource: action.skillSource || target.skill,
    }));
    if (actions.length > 0) {
      allActions.push({ name: target.skill, actions });
    }
  }

  if (allActions.length === 0) return [];
  return allActions.length === 1
    ? allActions[0].actions
    : mergeKeyActionsFromMultipleSkills(allActions);
}

export function formatReferenceKeyActions(actions: ExtractedKeyAction[]): string {
  if (actions.length === 0) return '';
  return actions.map((action, index) => {
    const tags = [
      action.skillSource ? `skill=${action.skillSource}` : '',
      action.controlFlowType !== 'required' ? `type=${action.controlFlowType}` : '',
      action.branchLabel ? `branch=${action.branchLabel}` : '',
      action.loopCondition ? `loop=${action.loopCondition}` : '',
    ].filter(Boolean).join(', ');
    return `${index + 1}. ${action.content}${tags ? ` [${tags}]` : ''}`;
  }).join('\n');
}

export function formatActualExtractedSteps(steps: ExtractedTraceStep[]): string {
  if (steps.length === 0) return '';
  return steps.map((step, index) => {
    const desc = normalizeMatchText(step.description || '');
    const uiStep = typeof step.uiStepIndex === 'number' ? ` [step=${step.uiStepIndex}]` : '';
    const range = step.dialogStartIndex != null && step.dialogEndIndex != null
      ? ` [dialog=${step.dialogStartIndex}-${step.dialogEndIndex}]`
      : '';
    return `${index + 1}. ${step.name || desc || '未命名步骤'}${step.type ? ` [${step.type}]` : ''}${uiStep}${range}${desc && desc !== step.name ? ` - ${desc}` : ''}`;
  }).join('\n');
}

export async function loadActualExtractedTraceSteps(
  resolvedTaskId: string | null | undefined,
  user?: string | null,
): Promise<{ status: 'ok'; steps: ExtractedTraceStep[]; text: string } | { status: 'dynamic-analysis-failed' | 'no-extracted-steps' }> {
  if (!resolvedTaskId) return { status: 'no-extracted-steps' };
  const executionMatch = await db.findExecutionMatch(resolvedTaskId);
  const extractedSteps = executionMatch?.extractedSteps
    ? JSON.parse(executionMatch.extractedSteps)
    : [];
  let normalizedSteps = Array.isArray(extractedSteps) ? extractedSteps as ExtractedTraceStep[] : [];
  if (normalizedSteps.length === 0) {
    const dynamicResult = await analyzeDynamicOnly(resolvedTaskId, user);
    if (!dynamicResult.success) return { status: 'dynamic-analysis-failed' };
    const refreshedExecutionMatch = await db.findExecutionMatch(resolvedTaskId);
    const refreshedExtractedSteps = refreshedExecutionMatch?.extractedSteps
      ? JSON.parse(refreshedExecutionMatch.extractedSteps)
      : [];
    normalizedSteps = Array.isArray(refreshedExtractedSteps) ? refreshedExtractedSteps as ExtractedTraceStep[] : [];
  }
  if (normalizedSteps.length === 0) return { status: 'no-extracted-steps' };
  return {
    status: 'ok',
    steps: normalizedSteps,
    text: formatActualExtractedSteps(normalizedSteps),
  };
}

export async function buildSkillKeyActionComparison(
  execution: KeyActionExecutionLike | null | undefined,
  resolvedTaskId: string | null | undefined,
  user?: string | null,
  interactions?: unknown,
): Promise<SkillKeyActionComparisonResult> {
  const skillTargets = getPrimaryExecutionSkillTargets(execution, interactions);
  if (skillTargets.length === 0 || !resolvedTaskId) return { status: 'no-skill-targets' };

  const missingSkills: string[] = [];
  const missingParsedFlowSkills: string[] = [];
  for (const target of skillTargets) {
    const skillRecord = await db.findSkill(target.skill, user || null);
    if (!skillRecord?.id) {
      missingSkills.push(target.skill);
      continue;
    }

    const fullSkill = await db.findSkillById(skillRecord.id);
    const resolvedVersion = target.version
      ?? fullSkill?.activeVersion
      ?? fullSkill?.versions?.[0]?.version
      ?? null;
    if (resolvedVersion == null) {
      missingParsedFlowSkills.push(target.skill);
      continue;
    }

    let parsedFlow = await db.findParsedFlow(skillRecord.id, resolvedVersion, user || null);
    if (!parsedFlow?.flowJson) {
      const versionRow = await db.findSkillVersion(skillRecord.id, resolvedVersion);
      const skillContent = versionRow?.content;
      if (!skillContent || !skillContent.trim()) {
        console.warn(`[key-action-trace-analysis] auto-parse skipped: SkillVersion ${skillRecord.id}/v${resolvedVersion} is empty`);
        missingParsedFlowSkills.push(target.skill);
        continue;
      }
      console.log(`[key-action-trace-analysis] auto-parsing skill flow for ${target.skill} v${resolvedVersion}...`);
      const t0 = Date.now();
      const parseResult = await parseSkillFlow(skillContent, skillRecord.id, resolvedVersion, user || null);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (!parseResult.success) {
        console.warn(`[key-action-trace-analysis] auto-parse failed for ${target.skill} v${resolvedVersion} (${elapsed}s): ${parseResult.error || 'unknown'}`);
        missingParsedFlowSkills.push(target.skill);
        continue;
      }
      console.log(`[key-action-trace-analysis] auto-parsed skill flow for ${target.skill} v${resolvedVersion} in ${elapsed}s`);
      parsedFlow = await db.findParsedFlow(skillRecord.id, resolvedVersion, user || null);
      if (!parsedFlow?.flowJson) {
        console.warn(`[key-action-trace-analysis] auto-parse reported success but DB has no flowJson for ${target.skill} v${resolvedVersion}`);
        missingParsedFlowSkills.push(target.skill);
      }
    }
  }

  if (missingSkills.length > 0) {
    return { status: 'missing-skill', missingSkills };
  }
  if (missingParsedFlowSkills.length > 0) {
    return { status: 'missing-parsed-flow', missingSkills: missingParsedFlowSkills };
  }

  const actualTrace = await loadActualExtractedTraceSteps(resolvedTaskId, user);
  if (actualTrace.status !== 'ok') return { status: actualTrace.status };

  const keyActions = await extractSkillKeyActionsFromTargets(skillTargets, user);
  if (keyActions.length === 0) return { status: 'no-key-actions' };

  return {
    status: 'ok',
    referenceKeyActionsText: formatReferenceKeyActions(keyActions),
    actualExtractedStepsText: actualTrace.text,
    referenceKeyActions: keyActions,
    actualExtractedSteps: actualTrace.steps,
  };
}

export function skillKeyActionComparisonMessage(comparison: SkillKeyActionComparisonResult): string {
  if (comparison.status === 'ok') return '';
  if (comparison.status === 'missing-skill') return `Skills Hub 中未管理该 Skill：${comparison.missingSkills?.join(', ') || 'unknown'}，无法读取关键动作定义。`;
  if (comparison.status === 'missing-parsed-flow') return `Skill 流程尚未解析或解析失败：${comparison.missingSkills?.join(', ') || 'unknown'}`;
  if (comparison.status === 'dynamic-analysis-failed') return '无法提取 trace 实际执行步骤';
  if (comparison.status === 'no-extracted-steps') return 'trace 中没有可用于关键动作分析的实际步骤';
  if (comparison.status === 'no-key-actions') return 'Skill 中没有可用于分析的关键动作';
  return '当前 trace 未关联可分析的 Skill';
}

function normalizeMatchText(value: string | null | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

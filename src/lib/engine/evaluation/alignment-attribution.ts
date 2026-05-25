import { OpenAI } from 'openai';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { getActiveConfig } from '@/lib/storage/server-config';
import { prismaRaw as prisma } from '@/lib/storage/prisma';
import { deriveAndPersistOptPoints } from '@/lib/engine/evaluation/derive-skill-opt-points';
import type {
  ExecutionMatchResult,
  TraceSkillAlignment,
  AlignmentViolation,
  SkippedExpectedStep,
} from '@/lib/engine/observability/flow-parser';

interface ExecutionForAttribution {
  id?: string | null;
  taskId?: string | null;
  skill?: string | null;
  skillVersion?: number | null;
}

interface PersistAlignmentAttributionInput {
  user: string | null;
  executionId: string;
  execution?: ExecutionForAttribution | null;
  match: ExecutionMatchResult;
  skillName: string;
  skillVersion?: number | null;
}

interface AttributionCandidate {
  candidateId: string;
  kind: string;
  severity: 'high' | 'medium' | 'low';
  actualStepIndex?: number;
  expectedStepId?: string;
  expectedStepName?: string;
  actualAction?: string;
  problem: string;
  reason?: string;
  suggestion?: string;
}

interface LlmAttribution {
  candidateId: string;
  is_skill_attributable: boolean;
  attribution_reason?: string;
  improvement_suggestion?: string;
  severity?: 'high' | 'medium' | 'low';
  category?: string;
}

export async function persistAlignmentAttribution(
  input: PersistAlignmentAttributionInput,
): Promise<{ rowId?: string; candidateCount: number; writtenIssues: number } | null> {
  const user = String(input.user || '').trim();
  if (!user) return null;

  const alignment = input.match.alignment;
  if (!alignment) return null;

  const taskId = input.execution?.taskId || input.executionId;
  const executionRecordId = input.execution?.id || input.executionId;
  const candidates = collectAlignmentCandidates(alignment);
  const llmAttributions = candidates.length > 0
    ? await classifyCandidatesWithLlm(user, input.skillName, candidates)
    : [];
  const byId = new Map(llmAttributions.map(item => [item.candidateId, item]));
  const deviationSteps = candidates.map(candidate => {
    const attr = byId.get(candidate.candidateId);
    return {
      stepIndex: candidate.actualStepIndex ?? -1,
      kind: candidate.kind,
      name: candidate.actualAction || candidate.expectedStepName || candidate.kind,
      deviation: candidate.problem,
      severity: normalizeSeverity(attr?.severity || candidate.severity),
      expectedStepId: candidate.expectedStepId,
      expectedStepName: candidate.expectedStepName,
      is_skill_attributable: attr?.is_skill_attributable ?? true,
      attribution_reason: attr?.attribution_reason || candidate.reason || '',
      improvement_suggestion: attr?.improvement_suggestion || candidate.suggestion || fallbackSuggestion(candidate),
      alignment_candidate_id: candidate.candidateId,
      attribution_category: attr?.category || categoryForKind(candidate.kind),
    };
  });

  const score = typeof alignment.summary?.overallScore === 'number'
    ? alignment.summary.overallScore
    : typeof input.match.summary?.overallScore === 'number'
      ? input.match.summary.overallScore
      : null;

  const existing = await prisma.trajectoryEvalResult.findFirst({
    where: { user, taskId },
    orderBy: { createdAt: 'desc' },
  });
  const existingRaw = parseJsonObject(existing?.rawAnalysisJson);
  const selectedEvaluators = mergeStrings(
    arrayOrEmpty<string>(existingRaw?.selectedEvaluators),
    ['alignment-skill-attribution'],
  );
  const selectedEvaluatorNames = mergeStrings(
    arrayOrEmpty<string>(existingRaw?.selectedEvaluatorNames),
    ['Alignment Skill 归因'],
  );
  const rawAnalysis = {
    ...existingRaw,
    selectedEvaluators,
    selectedEvaluatorNames,
    comparisonMode: 'alignment',
    skillAttribution: {
      state: 'ok',
      message: candidates.length > 0
        ? `基于轨迹对齐 alignment 派生 ${candidates.length} 条归因候选`
        : '轨迹对齐未发现需要归因的偏离',
    },
    alignmentAttribution: {
      source: 'alignment',
      skillName: input.skillName,
      skillVersion: input.skillVersion ?? null,
      candidates,
      findings: deviationSteps,
    },
    deviation_steps: deviationSteps,
  };

  const data = {
    status: 'done',
    errorMessage: null,
    trajectoryScore: score,
    dimensionScoresJson: JSON.stringify({
      alignment: score,
      attribution: candidates.length === 0 ? 1 : null,
    }),
    deviationStepsJson: JSON.stringify(deviationSteps),
    rootCauseStep: rootCauseFromCandidates(deviationSteps),
    reasonText: candidates.length > 0
      ? `基于 flow-parser 生成的 alignment 发现 ${candidates.length} 条偏离/缺失候选，Skill 归因仅对这些候选补充是否归因与修复建议。`
      : 'alignment 未发现偏离或缺失步骤。',
    rawAnalysisJson: JSON.stringify(rawAnalysis),
  };

  const row = existing
    ? await prisma.trajectoryEvalResult.update({ where: { id: existing.id }, data })
    : await prisma.trajectoryEvalResult.create({
        data: {
          user,
          evaluatorRunId: `alignment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          datasetId: 'alignment',
          caseId: taskId || executionRecordId,
          executionId: executionRecordId,
          taskId,
          ...data,
        },
      });

  const writtenIssues = await deriveAndPersistOptPoints({
    user,
    taskId,
    runId: row.evaluatorRunId,
    trajectoryRow: {
      id: row.id,
      deviationStepsJson: row.deviationStepsJson,
      rootCauseStep: row.rootCauseStep,
      reasonText: row.reasonText,
      rawAnalysisJson: JSON.stringify({ alignmentAttribution: rawAnalysis.alignmentAttribution }),
    },
    skills: [{ name: input.skillName, version: input.skillVersion ?? null }],
  });

  return { rowId: row.id, candidateCount: candidates.length, writtenIssues };
}

function collectAlignmentCandidates(alignment: TraceSkillAlignment): AttributionCandidate[] {
  const out: AttributionCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: AttributionCandidate) => {
    const key = [
      candidate.kind,
      candidate.actualStepIndex ?? '',
      candidate.expectedStepId ?? '',
      candidate.problem,
    ].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...candidate, candidateId: `c${out.length + 1}` });
  };

  for (const violation of arrayOrEmpty<AlignmentViolation>(alignment.violations)) {
    if (violation.kind === 'order_violation' || violation.kind === 'tool_choice') continue;
    if (violation.kind === 'skipped') continue;
    add(candidateFromViolation(violation));
  }

  for (const skipped of arrayOrEmpty<SkippedExpectedStep>(alignment.skippedExpectedSteps)) {
    add({
      candidateId: '',
      kind: 'skipped',
      severity: 'medium',
      expectedStepId: skipped.expectedStepId,
      expectedStepName: skipped.expectedStepName,
      problem: `Skill 中规定了「${skipped.expectedStepName}」，但实际执行流程没有覆盖。`,
    });
  }

  const raw = alignment as unknown as { out_of_scope?: unknown; outOfScope?: unknown };
  for (const item of arrayOrEmpty<Record<string, unknown>>(raw.out_of_scope || raw.outOfScope)) {
    const stepIndex = numberValue(item.actualStepIndex ?? item.stepIndex);
    add({
      candidateId: '',
      kind: 'out_of_scope',
      severity: normalizeSeverity(String(item.severity || 'medium')),
      actualStepIndex: stepIndex,
      actualAction: stringValue(item.actualAction || item.action || item.name),
      problem: stringValue(item.problem || item.reason || item.description)
        || '实际执行出现了 Skill 范围外的操作。',
      reason: stringValue(item.reason),
    });
  }

  return out;
}

function candidateFromViolation(violation: AlignmentViolation): AttributionCandidate {
  return {
    candidateId: '',
    kind: violation.kind,
    severity: normalizeSeverity(violation.severity || (violation.kind === 'unexpected' ? 'medium' : 'low')),
    actualStepIndex: violation.actualStepIndex,
    expectedStepId: violation.expectedStepId,
    expectedStepName: violation.expectedStepName,
    problem: violation.problem || '实际执行与 Skill 预期不一致。',
    suggestion: violation.suggestion,
  };
}

async function classifyCandidatesWithLlm(
  user: string,
  skillName: string,
  candidates: AttributionCandidate[],
): Promise<LlmAttribution[]> {
  const clientInfo = await getLlmClient(user);
  if (!clientInfo) {
    return candidates.map(fallbackAttribution);
  }

  const prompt = `你是 Skill 优化归因助手。轨迹对齐系统已经完成事实判断，请不要重新抽步骤、不要重新对齐流程。

你的任务只是在给定候选上补充:
1. is_skill_attributable: 该问题是否应该通过修改 Skill「${skillName}」解决
2. attribution_reason: 简短原因
3. improvement_suggestion: 可直接写进 Skill 的修复建议
4. severity: high | medium | low
5. category: 简短分类

只输出严格 JSON:
{"items":[{"candidateId":"c1","is_skill_attributable":true,"attribution_reason":"...","improvement_suggestion":"...","severity":"medium","category":"轨迹偏差"}]}

候选:
${JSON.stringify(candidates.slice(0, 20), null, 2)}`;

  try {
    const response = await clientInfo.client.chat.completions.create({
      model: clientInfo.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    });
    const text = response.choices[0]?.message?.content || '';
    const parsed = parseJsonLoose(text);
    const items = arrayOrEmpty<LlmAttribution>(parsed?.items);
    if (items.length === 0) return candidates.map(fallbackAttribution);
    const allowed = new Set(candidates.map(candidate => candidate.candidateId));
    return items
      .filter(item => allowed.has(item.candidateId))
      .map(item => ({
        candidateId: item.candidateId,
        is_skill_attributable: item.is_skill_attributable !== false,
        attribution_reason: stringValue(item.attribution_reason),
        improvement_suggestion: stringValue(item.improvement_suggestion),
        severity: normalizeSeverity(item.severity || 'medium'),
        category: stringValue(item.category),
      }));
  } catch (error) {
    console.warn('[alignment-attribution] LLM attribution failed, using fallback:', error);
    return candidates.map(fallbackAttribution);
  }
}

async function getLlmClient(user: string): Promise<{ client: OpenAI; model: string } | null> {
  const config = await getActiveConfig(user);
  if (!config?.apiKey) return null;
  const { customFetch } = getProxyConfig();
  return {
    client: new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || 'https://api.deepseek.com',
      fetch: customFetch,
    }),
    model: config.model || 'deepseek-chat',
  };
}

function fallbackAttribution(candidate: AttributionCandidate): LlmAttribution {
  return {
    candidateId: candidate.candidateId,
    is_skill_attributable: true,
    attribution_reason: '该候选来自唯一事实源 alignment，默认作为 Skill 可优化项处理。',
    improvement_suggestion: fallbackSuggestion(candidate),
    severity: candidate.severity,
    category: categoryForKind(candidate.kind),
  };
}

function fallbackSuggestion(candidate: AttributionCandidate): string {
  if (candidate.kind === 'skipped') {
    return `在 Skill 中补充「${candidate.expectedStepName || candidate.expectedStepId || '该步骤'}」的执行条件、操作要求和验收标准。`;
  }
  if (candidate.kind === 'unexpected' || candidate.kind === 'out_of_scope') {
    return '在 Skill 中明确允许/禁止的操作边界，并补充偏离时应回到主流程的处理规则。';
  }
  return '在 Skill 中补充该步骤的判断标准、必要上下文和正确执行方式，减少部分匹配或执行偏差。';
}

function categoryForKind(kind: string): string {
  if (kind === 'skipped') return '缺失步骤';
  if (kind === 'unexpected' || kind === 'out_of_scope') return '非预期操作';
  if (kind === 'partial') return '部分偏离';
  return '轨迹偏差';
}

function rootCauseFromCandidates(deviationSteps: Array<{ stepIndex?: number; name?: string; severity?: string }>): string | null {
  const root = deviationSteps.find(item => item.severity === 'high') || deviationSteps[0];
  if (!root) return null;
  return root.stepIndex != null && root.stepIndex >= 0
    ? `step#${root.stepIndex}: ${root.name || 'alignment'}`
    : root.name || 'alignment';
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function mergeStrings(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a.filter(Boolean), ...b.filter(Boolean)]));
}

function normalizeSeverity(value: unknown): 'high' | 'medium' | 'low' {
  const text = String(value || '').toLowerCase();
  if (text === 'high' || text === 'medium' || text === 'low') return text;
  return 'medium';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

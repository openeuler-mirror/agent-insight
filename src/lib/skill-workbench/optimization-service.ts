import { prismaRaw } from '@/lib/storage/prisma';
import {
  assertOptimizationTransition,
  computeSkillSnapshotHash,
  isBlockingStaticQualityIssue,
  isOptimizationStatus,
  type SkillOptimizationStatus,
} from './domain';

export const OPTIMIZATION_SOURCE_KINDS = ['user', 'evaluation', 'experiment'] as const;
export type OptimizationSourceKind = (typeof OPTIMIZATION_SOURCE_KINDS)[number];

export class OptimizationConflictError extends Error {}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface OptimizationBlockingIssue {
  id: string;
  severity: 'high';
  dimension: string;
  summary: string;
  evidence: string | null;
  reasoning: string | null;
  suggestedFix: string | null;
}

export function parseOptimizationBlockingIssues(
  evaluationId: string,
  issuesJson: string,
): OptimizationBlockingIssue[] {
  const issues = parseJson<Array<Record<string, unknown>>>(issuesJson, []);
  return issues.filter(isBlockingStaticQualityIssue).map((issue, index) => ({
    id: typeof issue.ruleId === 'string' && issue.ruleId ? issue.ruleId : `${evaluationId}:${index}`,
    severity: 'high',
    dimension: typeof issue.dimension === 'string' ? issue.dimension : '',
    summary: typeof issue.summary === 'string' ? issue.summary : '未命名质量问题',
    evidence: typeof issue.evidence === 'string' ? issue.evidence : null,
    reasoning: typeof issue.reasoning === 'string' ? issue.reasoning : null,
    suggestedFix: typeof issue.suggestedFix === 'string' ? issue.suggestedFix : null,
  }));
}

function serializeRecord<T extends {
  candidateFilesJson: string;
  diffJson: string;
  sourceRefsJson: string;
  session?: { id: string; title: string };
}>(record: T) {
  const { session, ...rest } = record;
  return {
    ...rest,
    sourceSession: session || null,
    candidateFiles: parseJson<Record<string, string>>(record.candidateFilesJson, {}),
    diff: parseJson<unknown[]>(record.diffJson, []),
    sourceRefs: parseJson<unknown[]>(record.sourceRefsJson, []),
  };
}

export async function beginSkillOptimizationRecord(input: {
  user: string;
  sessionId: string;
  skillName: string;
  baseVersion: number;
  sourceKind: OptimizationSourceKind;
  sourceRefs?: unknown[];
}) {
  const session = await prismaRaw.skillWorkbenchSession.findFirst({
    where: {
      id: input.sessionId,
      user: input.user,
      skillName: input.skillName,
      workVersion: input.baseVersion,
    },
    select: { id: true, title: true },
  });
  if (!session) return null;
  const record = await prismaRaw.skillOptimizationRecord.create({
    data: {
      sessionId: session.id,
      user: input.user,
      skillName: input.skillName,
      baseVersion: input.baseVersion,
      candidateVersionLabel: `v${input.baseVersion + 1} 候选`,
      sourceKind: input.sourceKind,
      sourceRefsJson: JSON.stringify(input.sourceRefs || []),
      status: 'optimizing',
    },
  });
  return serializeRecord({ ...record, session });
}

export async function completeSkillOptimizationRecord(input: {
  user: string;
  recordId: string;
  candidateFiles: Record<string, string>;
  summary: string;
  diff?: unknown[];
  sourceKind: OptimizationSourceKind;
  sourceRefs?: unknown[];
  staticEvaluationId?: string;
  sourceExperimentId?: string;
  status: 'pending_retest' | 'optimization_failed';
  errorMessage?: string;
}) {
  const candidateContentHash = computeSkillSnapshotHash(input.candidateFiles);
  const record = await prismaRaw.skillOptimizationRecord.findFirst({
    where: { id: input.recordId, user: input.user, status: 'optimizing' },
    include: { session: { select: { id: true, title: true } } },
  });
  if (!record) return null;
  const updated = await prismaRaw.skillOptimizationRecord.update({
    where: { id: record.id },
    data: {
      candidateFilesJson: JSON.stringify(input.candidateFiles),
      candidateContentHash,
      summary: input.summary,
      diffJson: JSON.stringify(input.diff || []),
      sourceKind: input.sourceKind,
      sourceRefsJson: JSON.stringify(input.sourceRefs || []),
      staticEvaluationId: input.staticEvaluationId || null,
      sourceExperimentId: input.sourceExperimentId || null,
      status: input.status,
      errorMessage: input.errorMessage || null,
      completedAt: new Date(),
    },
  });
  return serializeRecord({ ...updated, session: record.session });
}

export async function listSkillOptimizationRecords(input: {
  user: string;
  skillName: string;
  baseVersion?: number;
  sessionId?: string;
}) {
  const records = await prismaRaw.skillOptimizationRecord.findMany({
    where: {
      user: input.user,
      skillName: input.skillName,
      ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    include: { session: { select: { id: true, title: true } } },
  });
  const evaluationIds = records
    .map((record) => record.staticEvaluationId)
    .filter((id): id is string => Boolean(id));
  const evaluations = evaluationIds.length
    ? await prismaRaw.skillSnapshotEvaluation.findMany({
      where: { id: { in: evaluationIds }, user: input.user },
      select: { id: true, issuesJson: true },
    })
    : [];
  const blockingIssuesByEvaluation = new Map(evaluations.map((evaluation) => [
    evaluation.id,
    parseOptimizationBlockingIssues(evaluation.id, evaluation.issuesJson),
  ]));
  return records.map((record) => serializeRecord({
    ...record,
    blockingIssues: record.staticEvaluationId
      ? blockingIssuesByEvaluation.get(record.staticEvaluationId) || []
      : [],
  }));
}

export async function createSkillOptimizationCandidate(input: {
  user: string;
  sessionId: string;
  skillName: string;
  baseVersion: number;
  candidateFiles: Record<string, string>;
  summary: string;
  diff?: unknown[];
  sourceKind: OptimizationSourceKind;
  sourceRefs?: unknown[];
  staticEvaluationId?: string;
  sourceExperimentId?: string;
  initialStatus?: 'pending_retest' | 'optimization_failed';
  errorMessage?: string;
}) {
  const candidateContentHash = computeSkillSnapshotHash(input.candidateFiles);
  const created = await prismaRaw.$transaction(async (tx) => {
    const session = await tx.skillWorkbenchSession.findFirst({
      where: {
        id: input.sessionId,
        user: input.user,
        skillName: input.skillName,
        workVersion: input.baseVersion,
      },
      select: { id: true },
    });
    if (!session) return null;

    const existing = await tx.skillOptimizationRecord.findFirst({
      where: {
        sessionId: session.id,
        user: input.user,
        skillName: input.skillName,
        baseVersion: input.baseVersion,
        candidateContentHash,
        status: input.initialStatus || 'pending_retest',
        errorMessage: input.errorMessage || null,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      if (input.sourceExperimentId && input.sourceExperimentId !== existing.sourceExperimentId) {
        return tx.skillOptimizationRecord.update({
          where: { id: existing.id },
          data: {
            sourceKind: input.sourceKind,
            sourceRefsJson: JSON.stringify(input.sourceRefs || []),
            sourceExperimentId: input.sourceExperimentId,
            staticEvaluationId: input.staticEvaluationId || existing.staticEvaluationId,
          },
        });
      }
      return existing;
    }

    return tx.skillOptimizationRecord.create({
      data: {
        sessionId: session.id,
        user: input.user,
        skillName: input.skillName,
        baseVersion: input.baseVersion,
        candidateVersionLabel: `v${input.baseVersion + 1} 候选`,
        candidateFilesJson: JSON.stringify(input.candidateFiles),
        candidateContentHash,
        summary: input.summary,
        diffJson: JSON.stringify(input.diff || []),
        sourceKind: input.sourceKind,
        sourceRefsJson: JSON.stringify(input.sourceRefs || []),
        staticEvaluationId: input.staticEvaluationId || null,
        sourceExperimentId: input.sourceExperimentId || null,
        status: input.initialStatus || 'pending_retest',
        errorMessage: input.errorMessage || null,
        completedAt: new Date(),
      },
    });
  });
  return created ? serializeRecord(created) : null;
}

export async function transitionSkillOptimizationRecord(input: {
  user: string;
  skillName: string;
  recordId: string;
  to: SkillOptimizationStatus;
  errorMessage?: string;
}) {
  if (!isOptimizationStatus(input.to)) throw new OptimizationConflictError('未知的优化状态');

  return prismaRaw.$transaction(async (tx) => {
    const record = await tx.skillOptimizationRecord.findFirst({
      where: { id: input.recordId, user: input.user, skillName: input.skillName },
    });
    if (!record || !isOptimizationStatus(record.status)) return null;

    try {
      assertOptimizationTransition(record.status, input.to);
    } catch {
      throw new OptimizationConflictError(`不能从 ${record.status} 切换到 ${input.to}`);
    }

    const updated = await tx.skillOptimizationRecord.updateMany({
      where: { id: record.id, status: record.status },
      data: {
        status: input.to,
        errorMessage: input.errorMessage || null,
        completedAt: input.to === 'published' || input.to === 'abandoned' ? new Date() : record.completedAt,
      },
    });
    if (updated.count === 0) throw new OptimizationConflictError('优化记录已被其他操作更新');

    const next = await tx.skillOptimizationRecord.findUnique({ where: { id: record.id } });
    return next ? serializeRecord(next) : null;
  });
}

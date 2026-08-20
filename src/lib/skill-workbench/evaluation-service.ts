import { runStaticEvaluation } from '@/lib/engine/skill-issues/static-evaluator';
import { prismaRaw } from '@/lib/storage/prisma';
import {
  computeSkillSnapshotHash,
  displayStaticQualitySeverity,
  isBlockingStaticQualityIssue,
} from './domain';
import { createOrReuseSkillWorkbenchTask } from './task-service';
import { getLatestSnapshotEvaluation, runSnapshotStaticEvaluation } from './snapshot-evaluator';

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export type StaticQualityGateState = 'not_started' | 'running' | 'failed' | 'stale' | 'blocked' | 'passed';

export function resolveStaticQualityGate(input: {
  status?: string | null;
  highIssueCount?: number;
  hasStaleEvaluation?: boolean;
  errorMessage?: string | null;
}) {
  const highIssueCount = input.highIssueCount || 0;
  if (!input.status) {
    return input.hasStaleEvaluation
      ? { state: 'stale' as const, highIssueCount: 0, message: '当前文件已变化，请重新运行静态质量评估。' }
      : { state: 'not_started' as const, highIssueCount: 0, message: '当前工作快照尚未运行静态质量评估。' };
  }
  if (input.status === 'pending') {
    return { state: 'running' as const, highIssueCount: 0, message: '正在评估当前工作快照，完成前暂不能发布。' };
  }
  if (input.status === 'failed') {
    return { state: 'failed' as const, highIssueCount: 0, message: input.errorMessage || '静态质量评估执行失败，请重新评估。' };
  }
  if (highIssueCount > 0) {
    return { state: 'blocked' as const, highIssueCount, message: `发现 ${highIssueCount} 个高风险问题，请修复并重新评估。` };
  }
  return { state: 'passed' as const, highIssueCount: 0, message: '当前工作快照已通过静态质量门禁。' };
}

async function resolveVersionTarget(user: string, skillName: string, version: number) {
  return prismaRaw.skill.findFirst({
    where: {
      name: skillName,
      AND: [
        { OR: [{ user }, { user: null }, { visibility: 'public' }] },
        { versions: { some: { version } } },
      ],
    },
    select: { id: true, name: true },
  });
}

export async function getWorkbenchStaticEvaluation(input: {
  user: string;
  skillName: string;
  version: number;
}) {
  const skill = await resolveVersionTarget(input.user, input.skillName, input.version);
  if (!skill) return null;
  const evaluation = await prismaRaw.evaluation.findFirst({
    where: { skillId: skill.id, version: input.version, type: 'static' },
    orderBy: { ranAt: 'desc' },
    include: { issues: { orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }] } },
  });
  if (!evaluation) {
    return {
      skillName: skill.name,
      version: input.version,
      gate: resolveStaticQualityGate({}),
      evaluation: null,
    };
  }
  const highIssueCount = evaluation.issues.filter(isBlockingStaticQualityIssue).length;
  return {
    skillName: skill.name,
    version: input.version,
    gate: resolveStaticQualityGate({
      status: evaluation.status,
      highIssueCount,
      errorMessage: evaluation.errorMessage,
    }),
    evaluation: {
      ...evaluation,
      issues: evaluation.issues.map((issue) => ({
        ...issue,
        severity: displayStaticQualitySeverity(issue),
      })),
      scores: parseJson<Record<string, unknown>>(evaluation.l2ScoresJson, {}),
    },
  };
}

export async function getWorkbenchEvaluationOverview(input: {
  user: string;
  sessionId: string;
  skillName: string;
  version: number;
}) {
  const session = await prismaRaw.skillWorkbenchSession.findFirst({
    where: {
      id: input.sessionId,
      user: input.user,
      skillName: input.skillName,
      workVersion: input.version,
    },
    select: { source: true, filesJson: true },
  });
  if (!session) return null;
  if (session.source === 'management') return getWorkbenchStaticEvaluation(input);

  const files = parseJson<Record<string, string>>(session.filesJson, {});
  const contentHash = computeSkillSnapshotHash(files);
  const [snapshot, latestSnapshot] = await Promise.all([
    getLatestSnapshotEvaluation({
      user: input.user,
      sessionId: input.sessionId,
      skillName: input.skillName,
      proposedVersion: input.version,
      contentHash,
    }),
    getLatestSnapshotEvaluation({
      user: input.user,
      sessionId: input.sessionId,
      skillName: input.skillName,
      proposedVersion: input.version,
    }),
  ]);
  if (!snapshot) {
    return {
      skillName: input.skillName,
      version: input.version,
      contentHash,
      gate: resolveStaticQualityGate({ hasStaleEvaluation: Boolean(latestSnapshot) }),
      evaluation: null,
    };
  }
  const snapshotIssues = snapshot.issues as Array<Record<string, unknown>>;
  const highIssueCount = snapshotIssues.filter(isBlockingStaticQualityIssue).length;
  return {
    skillName: input.skillName,
    version: input.version,
    contentHash,
    gate: resolveStaticQualityGate({
      status: snapshot.status,
      highIssueCount,
      errorMessage: snapshot.errorMessage,
    }),
    evaluation: {
      id: snapshot.id,
      status: snapshot.status,
      ranAt: snapshot.createdAt,
      durationMs: snapshot.durationMs,
      errorMessage: snapshot.errorMessage,
      scores: snapshot.scores,
      issues: snapshotIssues.map((issue, index) => ({
        id: `${snapshot.id}:${index}`,
        severity: displayStaticQualitySeverity(issue),
        summary: String(issue.summary || ''),
        dimension: String(issue.dimension || ''),
        suggestedFix: issue.suggestedFix == null ? null : String(issue.suggestedFix),
      })),
    },
  };
}

export async function runWorkbenchStaticEvaluation(input: {
  user: string;
  sessionId: string;
  skillName: string;
  version: number;
  force?: boolean;
}) {
  const session = await prismaRaw.skillWorkbenchSession.findFirst({
    where: {
      id: input.sessionId,
      user: input.user,
      skillName: input.skillName,
      workVersion: input.version,
    },
    select: { id: true, source: true, filesJson: true },
  });
  if (!session) return { kind: 'invalid_context' as const };
  const skill = session.source === 'management'
    ? await resolveVersionTarget(input.user, input.skillName, input.version)
    : null;
  if (session.source === 'management' && !skill) return { kind: 'not_found' as const };

  const snapshotHash = session.source === 'management'
    ? null
    : computeSkillSnapshotHash(parseJson<Record<string, string>>(session.filesJson, {}));
  const taskResult = await createOrReuseSkillWorkbenchTask({
    user: input.user,
    sessionId: input.sessionId,
    type: 'evaluation',
    skillName: input.skillName,
    version: input.version,
    targetRef: snapshotHash ? `static-evaluation:${snapshotHash}` : 'static-evaluation',
  });
  if (!taskResult) return { kind: 'invalid_context' as const };
  if (taskResult.task.status === 'done' && !input.force) {
    return {
      kind: 'done' as const,
      task: taskResult.task,
      overview: await getWorkbenchEvaluationOverview(input),
      reused: true,
    };
  }
  if (taskResult.task.status === 'done' && input.force) {
    await prismaRaw.skillWorkbenchTask.updateMany({
      where: { id: taskResult.task.id, status: 'done' },
      data: {
        status: 'pending',
        progressJson: '{}',
        resultType: null,
        resultId: null,
        errorMessage: null,
      },
    });
  }
  if (taskResult.task.status === 'running') {
    return { kind: 'running' as const, task: taskResult.task, reused: true };
  }

  const claimed = await prismaRaw.skillWorkbenchTask.updateMany({
    where: { id: taskResult.task.id, status: { in: ['pending', 'failed'] } },
    data: { status: 'running', progressJson: JSON.stringify({ stage: '读取校验', percent: 10 }), errorMessage: null },
  });
  if (claimed.count === 0) {
    const task = await prismaRaw.skillWorkbenchTask.findUnique({ where: { id: taskResult.task.id } });
    return { kind: 'running' as const, task, reused: true };
  }

  const result = skill
    ? await runStaticEvaluation({
        skillId: skill.id,
        version: input.version,
        user: input.user,
        trigger: 'manual',
      })
    : await runSnapshotStaticEvaluation({
        user: input.user,
        sessionId: input.sessionId,
        skillName: input.skillName,
        proposedVersion: input.version,
        files: parseJson<Record<string, string>>(session.filesJson, {}),
        trigger: session.source === 'generated' ? 'generation' : 'manual',
      });
  const succeeded = result.status === 'ok' || result.status === 'partial';
  const resultRecord = result as { evaluationId?: string; id?: string; errorMessage?: string | null; skipReason?: string };
  const resultId = resultRecord.evaluationId || resultRecord.id;
  const resultError = resultRecord.errorMessage || resultRecord.skipReason;
  const task = await prismaRaw.skillWorkbenchTask.update({
    where: { id: taskResult.task.id },
    data: {
      status: succeeded ? 'done' : 'failed',
      progressJson: JSON.stringify({ stage: succeeded ? '汇总结果' : '评估失败', percent: 100 }),
      resultType: skill ? 'Evaluation' : 'SkillSnapshotEvaluation',
      resultId: resultId || null,
      errorMessage: succeeded ? null : resultError || '静态评估失败',
    },
  });
  return {
    kind: succeeded ? 'done' as const : 'failed' as const,
    task,
    result,
    overview: await getWorkbenchEvaluationOverview(input),
    reused: taskResult.reused,
  };
}

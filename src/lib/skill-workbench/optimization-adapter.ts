import { findSkillMd, fileContentToString, type PlaygroundFiles } from '@/lib/skill-generator/skill-files';
import { prismaRaw } from '@/lib/storage/prisma';
import { resolveRetestableExperimentBaseline } from './experiment-baseline';
import { createSkillOptimizationCandidate } from './optimization-service';
import { runSnapshotStaticEvaluation } from './snapshot-evaluator';
import { isBlockingStaticQualityIssue } from './domain';
import { getSkillWorkbenchSession } from './session-service';
import { createOrReuseSkillWorkbenchTask, updateSkillWorkbenchTask } from './task-service';

function parseObject(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

function normalizeCandidate(files: PlaygroundFiles, skillMdPath: string) {
  const root = skillMdPath.slice(0, -'SKILL.md'.length);
  return Object.fromEntries(Object.entries(files)
    .filter(([filePath]) => filePath.startsWith(root))
    .map(([filePath, file]) => [filePath.slice(root.length), fileContentToString(file)]));
}

export async function startWorkbenchOptimization(input: {
  user: string;
  sessionId: string;
}) {
  const result = await prismaRaw.$transaction(async (tx) => {
    const session = await tx.skillWorkbenchSession.findFirst({
      where: { id: input.sessionId, user: input.user, skillName: { not: null }, workVersion: { not: null } },
    });
    if (!session?.skillName || session.workVersion == null) return null;
    if (session.optSessionId) return { optSessionId: session.optSessionId, reused: true };
    if (session.source === 'management') {
      const ownedSkill = await tx.skill.findFirst({
        where: {
          name: session.skillName,
          user: input.user,
          versions: { some: { version: session.workVersion } },
        },
        select: { id: true },
      });
      if (!ownedSkill) return { readonly: true };
    } else if (!parseObject(session.filesJson)['SKILL.md']) {
      return null;
    }
    const opt = await tx.skillOptSession.create({
      data: {
        user: input.user,
        skillName: session.skillName,
        baseVersion: session.workVersion,
        title: '新对话',
        files: session.filesJson,
      },
      select: { id: true },
    });
    await tx.skillWorkbenchSession.update({
      where: { id: session.id },
      data: { optSessionId: opt.id, activeView: 'optimization' },
    });
    return { optSessionId: opt.id, reused: false };
  });
  if (!result) return null;
  if ('readonly' in result) return { kind: 'readonly' as const };
  return { ...result, session: await getSkillWorkbenchSession(input.user, input.sessionId) };
}

export async function getWorkbenchOptimization(user: string, sessionId: string) {
  const session = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { id: sessionId, user, optSessionId: { not: null } },
    select: { optSessionId: true, filesJson: true, skillName: true, workVersion: true },
  });
  if (!session?.optSessionId) return null;
  const opt = await prismaRaw.skillOptSession.findFirst({
    where: { id: session.optSessionId, user },
    include: { messages: { orderBy: { createdAt: 'asc' } }, iterations: { orderBy: { draftNumber: 'asc' } } },
  });
  return opt ? { ...opt, files: parseObject(opt.files), baselineFiles: parseObject(session.filesJson) } : null;
}

export async function syncWorkbenchOptimization(input: {
  user: string;
  sessionId: string;
  sourceKind: 'user' | 'evaluation' | 'experiment';
  sourceRefs?: unknown[];
  sourceExperimentId?: string;
}) {
  const session = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { id: input.sessionId, user: input.user, optSessionId: { not: null } },
    select: { id: true, optSessionId: true, skillName: true, workVersion: true, source: true },
  });
  if (!session?.optSessionId || !session.skillName || session.workVersion == null) return { kind: 'not_found' as const };
  const opt = await prismaRaw.skillOptSession.findFirst({
    where: { id: session.optSessionId, user: input.user },
    include: { messages: { where: { role: 'agent' }, orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!opt) return { kind: 'not_found' as const };
  const updatesWorkingSnapshot = session.source !== 'management';
  const baseline = updatesWorkingSnapshot ? null : await resolveRetestableExperimentBaseline({
    user: input.user,
    skillName: session.skillName,
    skillVersion: session.workVersion,
    sourceExperimentId: input.sourceExperimentId,
  });
  const sourceExperimentId = baseline?.experiment.id;
  const sourceRefs = [
    ...(input.sourceRefs || []),
    ...(baseline ? [{
      type: 'experiment',
      id: baseline.experiment.id,
      name: baseline.experiment.name,
      preset: baseline.experiment.preset,
    }] : []),
  ];
  const rawFiles = parseObject(opt.files) as PlaygroundFiles;
  const skillMd = findSkillMd(rawFiles);
  if (!skillMd) return { kind: 'incomplete' as const, reason: '优化结果没有 SKILL.md' };
  const candidateFiles = normalizeCandidate(rawFiles, skillMd.path);
  const quality = await runSnapshotStaticEvaluation({
    user: input.user,
    sessionId: session.id,
    skillName: session.skillName,
    proposedVersion: updatesWorkingSnapshot ? session.workVersion : session.workVersion + 1,
    files: candidateFiles,
    trigger: 'optimization',
  });
  const issues = JSON.parse(quality.issuesJson || '[]') as Array<{
    severity?: string;
    evidence?: string;
    reasoning?: string;
  }>;
  const qualityPassed = (quality.status === 'ok' || quality.status === 'partial')
    && !issues.some(isBlockingStaticQualityIssue);
  if (updatesWorkingSnapshot) {
    await prismaRaw.skillWorkbenchSession.updateMany({
      where: { id: session.id, user: input.user },
      data: {
        filesJson: JSON.stringify(candidateFiles),
        stage: 'ready',
        activeView: 'evaluation',
      },
    });
    return {
      kind: qualityPassed ? 'snapshot_updated' as const : 'snapshot_blocked' as const,
      quality,
      session: await getSkillWorkbenchSession(input.user, input.sessionId),
    };
  }
  const record = await createSkillOptimizationCandidate({
    user: input.user,
    sessionId: session.id,
    skillName: session.skillName,
    baseVersion: session.workVersion,
    candidateFiles,
    summary: opt.messages[0]?.content || '优化 Agent 已生成候选快照',
    sourceKind: input.sourceKind,
    sourceRefs,
    sourceExperimentId,
    staticEvaluationId: quality.id,
    initialStatus: qualityPassed ? 'pending_retest' : 'optimization_failed',
    errorMessage: qualityPassed ? undefined : quality.errorMessage || '候选静态质量门禁未通过',
  });
  if (!record) return { kind: 'not_found' as const };
  await prismaRaw.skillWorkbenchSession.updateMany({
    where: { id: session.id, user: input.user }, data: { stage: 'ready', activeView: 'optimization' },
  });
  return {
    kind: qualityPassed ? 'pending_retest' as const : 'optimization_failed' as const,
    record,
    quality,
    session: await getSkillWorkbenchSession(input.user, input.sessionId),
  };
}

export async function beginWorkbenchOptimizationRun(input: {
  user: string;
  optSessionId: string;
  runId: string;
}) {
  const workbench = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { user: input.user, optSessionId: input.optSessionId },
    select: { id: true, skillName: true, workVersion: true },
  });
  if (!workbench) return null;
  const created = await createOrReuseSkillWorkbenchTask({
    user: input.user,
    sessionId: workbench.id,
    type: 'optimization',
    skillName: workbench.skillName,
    version: workbench.workVersion,
    targetRef: input.runId,
  });
  if (!created) return null;
  await Promise.all([
    updateSkillWorkbenchTask({
      taskId: created.task.id,
      status: 'running',
      progress: { stage: '优化 Skill', percent: 10 },
      errorMessage: null,
    }),
    prismaRaw.skillWorkbenchSession.update({
      where: { id: workbench.id },
      data: { stage: 'busy' },
    }),
  ]);
  return { taskId: created.task.id, workbenchSessionId: workbench.id };
}

export async function finishWorkbenchOptimizationRun(input: {
  user: string;
  workbenchSessionId: string;
  taskId: string;
  sourceKind: 'user' | 'evaluation';
  sourceRefs: unknown[];
  error?: string | null;
}) {
  if (input.error) {
    await Promise.all([
      updateSkillWorkbenchTask({
        taskId: input.taskId,
        status: 'failed',
        progress: { stage: '优化失败', percent: 100 },
        errorMessage: input.error,
      }),
      prismaRaw.skillWorkbenchSession.update({
        where: { id: input.workbenchSessionId },
        data: { stage: 'ready' },
      }),
    ]);
    return { kind: 'failed' as const };
  }
  try {
    await updateSkillWorkbenchTask({
      taskId: input.taskId,
      status: 'running',
      progress: { stage: '保存并评估候选', percent: 85 },
    });
    const result = await syncWorkbenchOptimization({
      user: input.user,
      sessionId: input.workbenchSessionId,
      sourceKind: input.sourceKind,
      sourceRefs: input.sourceRefs,
    });
    if (result.kind === 'not_found' || result.kind === 'incomplete') {
      const reason = result.kind === 'incomplete' ? result.reason : '优化会话不存在';
      await updateSkillWorkbenchTask({
        taskId: input.taskId,
        status: 'failed',
        progress: { stage: '优化结果不完整', percent: 100 },
        errorMessage: reason,
      });
      return result;
    }
    const optimizationRecord = 'record' in result && result.record ? result.record : null;
    await updateSkillWorkbenchTask({
      taskId: input.taskId,
      status: 'done',
      progress: { stage: '完成', percent: 100 },
      resultType: optimizationRecord ? 'optimization-record' : 'snapshot-evaluation',
      resultId: optimizationRecord?.id || result.quality.id,
      errorMessage: null,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Promise.all([
      updateSkillWorkbenchTask({
        taskId: input.taskId,
        status: 'failed',
        progress: { stage: '保存失败', percent: 100 },
        errorMessage: message,
      }),
      prismaRaw.skillWorkbenchSession.update({
        where: { id: input.workbenchSessionId },
        data: { stage: 'ready' },
      }),
    ]);
    return { kind: 'failed' as const, reason: message };
  }
}

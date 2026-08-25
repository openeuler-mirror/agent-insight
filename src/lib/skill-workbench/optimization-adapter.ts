import { findSkillMd, type PlaygroundFiles } from '@/lib/skill-generator/skill-files';
import { prismaRaw } from '@/lib/storage/prisma';
import { resolveRetestableExperimentBaseline } from './experiment-baseline';
import {
  beginSkillOptimizationRecord,
  completeSkillOptimizationRecord,
  createSkillOptimizationCandidate,
  transitionSkillOptimizationRecord,
} from './optimization-service';
import { runSnapshotStaticEvaluation } from './snapshot-evaluator';
import { isBlockingStaticQualityIssue } from './domain';
import { getSkillWorkbenchSession } from './session-service';
import { createOrReuseSkillWorkbenchTask, updateSkillWorkbenchTask } from './task-service';
import { normalizeOptimizationCandidate } from './optimization-candidate';
import { applyCompletedOptimizationPlan } from './optimization-plan-state';

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export interface WorkbenchOptimizationIssue {
  id: string;
  severity: 'high' | 'medium' | 'low';
  dimension: string;
  summary: string;
  evidence?: string;
  reasoning?: string;
  suggestedFix?: string;
}

function normalizeOptimizationIssues(evaluationId: string, value: string): WorkbenchOptimizationIssue[] {
  let parsed: unknown = [];
  try { parsed = JSON.parse(value || '[]'); } catch { parsed = []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((raw, index) => {
    const issue = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const severity = issue.severity === 'high' || issue.severity === 'medium' ? issue.severity : 'low';
    return {
      id: typeof issue.ruleId === 'string' && issue.ruleId ? issue.ruleId : `${evaluationId}:${index}`,
      severity,
      dimension: typeof issue.dimension === 'string' ? issue.dimension : '',
      summary: typeof issue.summary === 'string' ? issue.summary : '未命名质量问题',
      ...(typeof issue.evidence === 'string' && issue.evidence.trim() ? { evidence: issue.evidence } : {}),
      ...(typeof issue.reasoning === 'string' && issue.reasoning.trim() ? { reasoning: issue.reasoning } : {}),
      ...(typeof issue.suggestedFix === 'string' && issue.suggestedFix.trim() ? { suggestedFix: issue.suggestedFix } : {}),
    };
  });
}

function buildCandidateDiff(baselineFiles: Record<string, string>, candidateFiles: Record<string, string>) {
  return [...new Set([...Object.keys(baselineFiles), ...Object.keys(candidateFiles)])]
    .sort()
    .filter((filePath) => baselineFiles[filePath] !== candidateFiles[filePath])
    .map((filePath) => ({
      path: filePath,
      before: baselineFiles[filePath] ?? null,
      after: candidateFiles[filePath] ?? null,
      changeType: !(filePath in baselineFiles) ? 'added' : !(filePath in candidateFiles) ? 'deleted' : 'modified',
    }));
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
      data: { optSessionId: opt.id },
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
  recordId?: string;
}) {
  const session = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { id: input.sessionId, user: input.user, optSessionId: { not: null } },
    select: { id: true, optSessionId: true, skillName: true, workVersion: true, source: true, filesJson: true },
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
      score: baseline.score,
    }] : []),
  ];
  const rawFiles = parseObject(opt.files) as PlaygroundFiles;
  const skillMd = findSkillMd(rawFiles);
  if (!skillMd) return { kind: 'incomplete' as const, reason: '优化结果没有 SKILL.md' };
  const candidateFiles = normalizeOptimizationCandidate(rawFiles, skillMd.path);
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
      },
    });
    return {
      kind: qualityPassed ? 'snapshot_updated' as const : 'snapshot_blocked' as const,
      quality,
      session: await getSkillWorkbenchSession(input.user, input.sessionId),
    };
  }
  const recordInput = {
    user: input.user,
    candidateFiles,
    summary: opt.messages[0]?.content || '优化 Agent 已生成候选快照',
    diff: buildCandidateDiff(parseObject(session.filesJson) as Record<string, string>, candidateFiles),
    sourceKind: input.sourceKind,
    sourceRefs,
    sourceExperimentId,
    staticEvaluationId: quality.id,
    status: qualityPassed ? 'pending_retest' as const : 'optimization_failed' as const,
    errorMessage: qualityPassed ? undefined : quality.errorMessage || '候选静态质量门禁未通过',
  };
  const record = input.recordId
    ? await completeSkillOptimizationRecord({ ...recordInput, recordId: input.recordId })
    : await createSkillOptimizationCandidate({
      ...recordInput,
      sessionId: session.id,
      skillName: session.skillName,
      baseVersion: session.workVersion,
      initialStatus: recordInput.status,
    });
  if (!record) return { kind: 'not_found' as const };
  await prismaRaw.skillWorkbenchSession.updateMany({
    where: { id: session.id, user: input.user }, data: { stage: 'ready' },
  });
  return {
    kind: qualityPassed ? 'pending_retest' as const : 'optimization_failed' as const,
    record,
    quality,
    session: await getSkillWorkbenchSession(input.user, input.sessionId),
  };
}

export async function inspectWorkbenchOptimizationForRepair(input: {
  user: string;
  sessionId: string;
}) {
  const session = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { id: input.sessionId, user: input.user, optSessionId: { not: null }, skillName: { not: null }, workVersion: { not: null } },
    select: { id: true, optSessionId: true, skillName: true, workVersion: true, source: true },
  });
  if (!session?.optSessionId || !session.skillName || session.workVersion == null) return null;
  const opt = await prismaRaw.skillOptSession.findFirst({
    where: { id: session.optSessionId, user: input.user },
    select: { files: true },
  });
  if (!opt) return null;
  const rawFiles = parseObject(opt.files) as PlaygroundFiles;
  const skillMd = findSkillMd(rawFiles);
  if (!skillMd) return null;
  const candidateFiles = normalizeOptimizationCandidate(rawFiles, skillMd.path);
  const quality = await runSnapshotStaticEvaluation({
    user: input.user,
    sessionId: session.id,
    skillName: session.skillName,
    proposedVersion: session.source === 'management' ? session.workVersion + 1 : session.workVersion,
    files: candidateFiles,
    trigger: 'optimization',
  });
  const issues = normalizeOptimizationIssues(quality.id, quality.issuesJson);
  return {
    quality,
    candidateFiles,
    blockingIssues: issues.filter(isBlockingStaticQualityIssue),
  };
}

export async function beginWorkbenchOptimizationRun(input: {
  user: string;
  optSessionId: string;
  runId: string;
  sourceKind: 'user' | 'evaluation';
  sourceRefs: unknown[];
}) {
  const workbench = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { user: input.user, optSessionId: input.optSessionId },
    select: { id: true, skillName: true, workVersion: true, source: true },
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
  const record = created.reused || workbench.source !== 'management' || !workbench.skillName || workbench.workVersion == null
    ? null
    : await beginSkillOptimizationRecord({
      user: input.user,
      sessionId: workbench.id,
      skillName: workbench.skillName,
      baseVersion: workbench.workVersion,
      sourceKind: input.sourceKind,
      sourceRefs: input.sourceRefs,
    });
  await Promise.all([
    updateSkillWorkbenchTask({
      taskId: created.task.id,
      status: 'running',
      progress: { stage: '分析优化依据', activeStep: 1, percent: 10 },
      resultType: record ? 'optimization-record' : created.task.resultType,
      resultId: record?.id || created.task.resultId,
      errorMessage: null,
    }),
    prismaRaw.skillWorkbenchSession.update({
      where: { id: workbench.id },
      data: { stage: 'busy' },
    }),
  ]);
  return {
    taskId: created.task.id,
    workbenchSessionId: workbench.id,
    recordId: record?.id || created.task.resultId || undefined,
  };
}

export async function updateWorkbenchOptimizationProgress(input: {
  taskId: string;
  stage: string;
  activeStep: number;
  percent: number;
}) {
  return updateSkillWorkbenchTask({
    taskId: input.taskId,
    status: 'running',
    progress: { stage: input.stage, activeStep: input.activeStep, percent: input.percent },
  });
}

export async function finishWorkbenchOptimizationRun(input: {
  user: string;
  workbenchSessionId: string;
  taskId: string;
  sourceKind: 'user' | 'evaluation';
  sourceRefs: unknown[];
  recordId?: string;
  error?: string | null;
  repair?: (issues: WorkbenchOptimizationIssue[]) => Promise<void>;
}) {
  if (input.error) {
    const currentTask = await prismaRaw.skillWorkbenchTask.findUnique({
      where: { id: input.taskId },
      select: { progressJson: true },
    });
    const currentProgress = parseObject(currentTask?.progressJson || '{}');
    const activeStep = Number(currentProgress.activeStep) || 1;
    const failedRecord = input.recordId
      ? await prismaRaw.skillOptimizationRecord.findUnique({
        where: { id: input.recordId },
        select: { skillName: true },
      })
      : null;
    await Promise.all([
      updateSkillWorkbenchTask({
        taskId: input.taskId,
        status: 'failed',
        progress: { stage: '优化失败', activeStep, percent: 100 },
        errorMessage: input.error,
      }),
      prismaRaw.skillWorkbenchSession.update({
        where: { id: input.workbenchSessionId },
        data: { stage: 'ready' },
      }),
      input.recordId && failedRecord ? transitionSkillOptimizationRecord({
        user: input.user,
        skillName: failedRecord.skillName,
        recordId: input.recordId,
        to: 'optimization_failed',
        errorMessage: input.error,
      }).catch(() => undefined) : Promise.resolve(),
    ]);
    return { kind: 'failed' as const };
  }
  try {
    await updateWorkbenchOptimizationProgress({
      taskId: input.taskId,
      stage: '执行质量校验',
      activeStep: 3,
      percent: 70,
    });
    let sourceRefs = input.sourceRefs;
    if (input.repair) {
      const inspection = await inspectWorkbenchOptimizationForRepair({
        user: input.user,
        sessionId: input.workbenchSessionId,
      });
      if (inspection?.blockingIssues.length) {
        await updateWorkbenchOptimizationProgress({
          taskId: input.taskId,
          stage: `自动修复 ${inspection.blockingIssues.length} 个阻断问题（1/1）`,
          activeStep: 3,
          percent: 76,
        });
        let repairError: string | null = null;
        try {
          await input.repair(inspection.blockingIssues);
        } catch (error) {
          repairError = error instanceof Error ? error.message : String(error);
        }
        sourceRefs = [
          ...sourceRefs,
          {
            type: 'static-quality-repair',
            evaluationId: inspection.quality.id,
            issueIds: inspection.blockingIssues.map((issue) => issue.id),
            ...(repairError ? { error: repairError } : {}),
          },
        ];
        await updateWorkbenchOptimizationProgress({
          taskId: input.taskId,
          stage: '自动修复后重新质量校验',
          activeStep: 3,
          percent: 82,
        });
      }
    }
    const result = await syncWorkbenchOptimization({
      user: input.user,
      sessionId: input.workbenchSessionId,
      sourceKind: input.sourceKind,
      sourceRefs,
      recordId: input.recordId,
    });
    if (result.kind === 'not_found' || result.kind === 'incomplete') {
      const reason = result.kind === 'incomplete' ? result.reason : '优化会话不存在';
      await updateSkillWorkbenchTask({
        taskId: input.taskId,
        status: 'failed',
        progress: { stage: '优化结果不完整', percent: 100 },
        errorMessage: reason,
      });
      if (input.recordId) {
        const failedRecord = await prismaRaw.skillOptimizationRecord.findUnique({
          where: { id: input.recordId },
          select: { skillName: true },
        });
        if (failedRecord) await transitionSkillOptimizationRecord({
          user: input.user,
          skillName: failedRecord.skillName,
          recordId: input.recordId,
          to: 'optimization_failed',
          errorMessage: reason,
        }).catch(() => undefined);
      }
      return result;
    }
    const optimizationRecord = 'record' in result && result.record ? result.record : null;
    if (optimizationRecord && result.kind === 'pending_retest' && optimizationRecord.diff.length > 0) {
      await applyCompletedOptimizationPlan({
        user: input.user,
        workbenchSessionId: input.workbenchSessionId,
        sourceRefs,
        resolvedRunId: optimizationRecord.id || input.taskId,
      });
    }
    await updateWorkbenchOptimizationProgress({
      taskId: input.taskId,
      stage: '整理优化报告',
      activeStep: 4,
      percent: 90,
    });
    await updateSkillWorkbenchTask({
      taskId: input.taskId,
      status: 'done',
      progress: { stage: '优化完成', activeStep: 5, percent: 100 },
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

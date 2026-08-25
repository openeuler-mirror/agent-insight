import { findSkillMd, fileContentToString, type PlaygroundFiles } from '@/lib/skill-generator/skill-files';
import { prismaRaw } from '@/lib/storage/prisma';
import { getSkillWorkbenchSession } from './session-service';
import { createOrReuseSkillWorkbenchTask, updateSkillWorkbenchTask } from './task-service';

function parseFiles(value: string): PlaygroundFiles {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function workbenchFiles(files: PlaygroundFiles, skillMdPath: string) {
  const root = skillMdPath.slice(0, -'SKILL.md'.length);
  return Object.fromEntries(Object.entries(files)
    .filter(([filePath]) => filePath.startsWith(root))
    .map(([filePath, file]) => [filePath.slice(root.length), fileContentToString(file)]));
}

export async function startWorkbenchGeneration(user: string, sessionId: string) {
  const result = await prismaRaw.$transaction(async (tx) => {
    const workbench = await tx.skillWorkbenchSession.findFirst({ where: { id: sessionId, user } });
    if (!workbench) return null;
    if (workbench.generatorSessionId) return { generatorSessionId: workbench.generatorSessionId, reused: true };

    const generator = await tx.skillGeneratorSession.create({
      data: { user, title: 'New Chat', files: '{}' },
      select: { id: true },
    });
    await tx.skillWorkbenchSession.update({
      where: { id: sessionId },
      data: {
        source: 'generated',
        stage: 'preparing',
        generatorSessionId: generator.id,
        activeView: 'detail',
      },
    });
    return { generatorSessionId: generator.id, reused: false };
  });
  if (!result) return null;
  return { ...result, session: await getSkillWorkbenchSession(user, sessionId) };
}

export async function getWorkbenchGeneration(user: string, sessionId: string) {
  const workbench = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { id: sessionId, user, generatorSessionId: { not: null } },
    select: { generatorSessionId: true },
  });
  if (!workbench?.generatorSessionId) return null;
  const generator = await prismaRaw.skillGeneratorSession.findFirst({
    where: { id: workbench.generatorSessionId, user },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!generator) return null;
  return { ...generator, files: parseFiles(generator.files) };
}

export async function syncWorkbenchGeneration(user: string, sessionId: string) {
  const workbench = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { id: sessionId, user, generatorSessionId: { not: null } },
    select: { generatorSessionId: true },
  });
  if (!workbench?.generatorSessionId) return { kind: 'not_found' as const };
  const generator = await prismaRaw.skillGeneratorSession.findFirst({
    where: { id: workbench.generatorSessionId, user },
    select: { files: true, title: true },
  });
  if (!generator) return { kind: 'not_found' as const };

  const files = parseFiles(generator.files);
  const skillMd = findSkillMd(files);
  if (!skillMd) return { kind: 'incomplete' as const, reason: '生成结果还没有包含 SKILL.md' };
  const skillName = skillMd.name || 'untitled-skill';
  const existing = await prismaRaw.skill.findFirst({
    where: { name: skillName, user },
    select: { versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true } } },
  });
  const candidateVersion = (existing?.versions[0]?.version ?? -1) + 1;
  const snapshot = workbenchFiles(files, skillMd.path);
  await prismaRaw.skillWorkbenchSession.updateMany({
    where: { id: sessionId, user },
    data: {
      title: generator.title || skillName,
      skillName,
      workVersion: candidateVersion,
      source: 'generated',
      stage: 'ready',
      filesJson: JSON.stringify(snapshot),
      activeView: 'detail',
    },
  });
  return {
    kind: 'ready' as const,
    session: await getSkillWorkbenchSession(user, sessionId),
    candidateVersion,
    targetExists: Boolean(existing),
  };
}

export async function beginWorkbenchGenerationRun(input: {
  user: string;
  generatorSessionId: string;
  runId: string;
}) {
  const workbench = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { user: input.user, generatorSessionId: input.generatorSessionId },
    select: { id: true, skillName: true, workVersion: true },
  });
  if (!workbench) return null;
  const created = await createOrReuseSkillWorkbenchTask({
    user: input.user,
    sessionId: workbench.id,
    type: 'generation',
    skillName: workbench.skillName,
    version: workbench.workVersion,
    targetRef: input.runId,
  });
  if (!created) return null;
  await Promise.all([
    updateSkillWorkbenchTask({
      taskId: created.task.id,
      status: 'running',
      progress: { stage: '生成 Skill', percent: 10 },
      errorMessage: null,
    }),
    prismaRaw.skillWorkbenchSession.update({
      where: { id: workbench.id },
      data: { stage: 'preparing' },
    }),
  ]);
  return { taskId: created.task.id, workbenchSessionId: workbench.id };
}

export async function finishWorkbenchGenerationRun(input: {
  user: string;
  workbenchSessionId: string;
  taskId: string;
  error?: string | null;
}) {
  if (input.error) {
    await updateSkillWorkbenchTask({
      taskId: input.taskId,
      status: 'failed',
      progress: { stage: '生成失败', percent: 100 },
      errorMessage: input.error,
    });
    return { kind: 'failed' as const };
  }
  try {
    await updateSkillWorkbenchTask({
      taskId: input.taskId,
      status: 'running',
      progress: { stage: '保存工作快照', percent: 85 },
    });
    const result = await syncWorkbenchGeneration(input.user, input.workbenchSessionId);
    if (result.kind !== 'ready') {
      const reason = result.kind === 'incomplete' ? result.reason : '生成会话不存在';
      await updateSkillWorkbenchTask({
        taskId: input.taskId,
        status: 'failed',
        progress: { stage: '生成结果不完整', percent: 100 },
        errorMessage: reason,
      });
      return result;
    }
    await updateSkillWorkbenchTask({
      taskId: input.taskId,
      status: 'done',
      progress: { stage: '完成', percent: 100 },
      resultType: 'workbench-snapshot',
      resultId: input.workbenchSessionId,
      errorMessage: null,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateSkillWorkbenchTask({
      taskId: input.taskId,
      status: 'failed',
      progress: { stage: '保存失败', percent: 100 },
      errorMessage: message,
    });
    return { kind: 'failed' as const, reason: message };
  }
}

import { prismaRaw } from '@/lib/storage/prisma';
import {
  makeWorkbenchTaskIdempotencyKey,
  type SkillWorkbenchTaskType,
} from './domain';

export async function listSkillWorkbenchTasks(user: string, sessionId: string) {
  const session = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { id: sessionId, user },
    select: { id: true },
  });
  if (!session) return null;
  return prismaRaw.skillWorkbenchTask.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createOrReuseSkillWorkbenchTask(input: {
  user: string;
  sessionId: string;
  type: SkillWorkbenchTaskType;
  skillName?: string | null;
  version?: number | null;
  targetRef?: string | null;
}) {
  const idempotencyKey = makeWorkbenchTaskIdempotencyKey(input);
  return prismaRaw.$transaction(async (tx) => {
    const session = await tx.skillWorkbenchSession.findFirst({
      where: { id: input.sessionId, user: input.user },
      select: { id: true, stage: true },
    });
    if (!session) return null;

    const existing = await tx.skillWorkbenchTask.findUnique({
      where: {
        sessionId_idempotencyKey: {
          sessionId: input.sessionId,
          idempotencyKey,
        },
      },
    });
    if (existing) return { task: existing, reused: true, blocked: false };

    const claimed = await tx.skillWorkbenchSession.updateMany({
      where: {
        id: input.sessionId,
        user: input.user,
        tasks: {
          none: {
            type: input.type,
            status: { in: ['pending', 'running'] },
          },
        },
      },
      data: { stage: session.stage },
    });
    if (claimed.count === 0) {
      const active = await tx.skillWorkbenchTask.findFirst({
        where: {
          sessionId: input.sessionId,
          type: input.type,
          status: { in: ['pending', 'running'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (active) return { task: active, reused: true, blocked: true };
      return null;
    }

    const task = await tx.skillWorkbenchTask.create({
      data: {
        sessionId: input.sessionId,
        type: input.type,
        idempotencyKey,
      },
    });
    return { task, reused: false, blocked: false };
  });
}

export async function updateSkillWorkbenchTask(input: {
  taskId: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  progress?: Record<string, unknown>;
  resultType?: string | null;
  resultId?: string | null;
  errorMessage?: string | null;
}) {
  return prismaRaw.skillWorkbenchTask.update({
    where: { id: input.taskId },
    data: {
      status: input.status,
      ...(input.progress ? { progressJson: JSON.stringify(input.progress) } : {}),
      ...(input.resultType !== undefined ? { resultType: input.resultType } : {}),
      ...(input.resultId !== undefined ? { resultId: input.resultId } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    },
  });
}

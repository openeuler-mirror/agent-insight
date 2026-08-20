import fs from 'fs';
import path from 'path';

import { getSkillVersionStorageDir } from '@/lib/env';
import { prismaRaw } from '@/lib/storage/prisma';
import type { SkillWorkbenchActiveView } from './domain';
import { resolveRetestableExperimentBaseline } from './experiment-baseline';

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function listSkillWorkbenchSessions(user: string) {
  const sessions = await prismaRaw.skillWorkbenchSession.findMany({
    where: { user },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      skillName: true,
      workVersion: true,
      source: true,
      activeView: true,
      stage: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true, tasks: true, optimizations: true } },
    },
  });

  return sessions.map((session) => ({
    ...session,
    messageCount: session._count.messages,
    taskCount: session._count.tasks,
    optimizationCount: session._count.optimizations,
    _count: undefined,
  }));
}

export async function createSkillWorkbenchSession(input: { user: string; title?: string }) {
  const title = input.title?.trim().slice(0, 120) || '新对话';
  return prismaRaw.skillWorkbenchSession.create({
    data: { user: input.user, title },
    select: {
      id: true,
      title: true,
      skillName: true,
      workVersion: true,
      source: true,
      activeView: true,
      stage: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function getSkillWorkbenchSession(user: string, id: string) {
  const session = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { id, user },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      tasks: { orderBy: { createdAt: 'asc' } },
      optimizations: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!session) return null;

  const optimizations = await Promise.all(session.optimizations.map(async (record) => ({
    ...record,
    candidateFiles: parseJson<Record<string, string>>(record.candidateFilesJson, {}),
    diff: parseJson<unknown[]>(record.diffJson, []),
    sourceRefs: parseJson<unknown[]>(record.sourceRefsJson, []),
    hasRetestableSource: Boolean(await resolveRetestableExperimentBaseline({
      user,
      skillName: record.skillName,
      skillVersion: record.baseVersion,
      sourceExperimentId: record.sourceExperimentId,
    })),
  })));

  return {
    ...session,
    files: parseJson<Record<string, string>>(session.filesJson, {}),
    messages: session.messages.map((message) => ({
      ...message,
      blocks: parseJson<unknown[]>(message.blocksJson, []),
    })),
    tasks: session.tasks.map((task) => ({
      ...task,
      progress: parseJson<Record<string, unknown>>(task.progressJson, {}),
    })),
    optimizations,
  };
}

export async function updateSkillWorkbenchSessionView(input: {
  user: string;
  id: string;
  activeView: SkillWorkbenchActiveView;
}) {
  const updated = await prismaRaw.skillWorkbenchSession.updateMany({
    where: { id: input.id, user: input.user },
    data: { activeView: input.activeView },
  });
  if (updated.count === 0) return null;
  return getSkillWorkbenchSession(input.user, input.id);
}

function snapshotFiles(skillId: string, version: number, files: string | null, content: string): Record<string, string> {
  if (files) {
    try {
      const parsed = JSON.parse(files) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed).filter((entry): entry is [string, string] => (
          typeof entry[0] === 'string' && typeof entry[1] === 'string'
        ));
        if (entries.length > 0) return Object.fromEntries(entries);
      }
      if (Array.isArray(parsed)) {
        const storageRoot = getSkillVersionStorageDir(skillId, version);
        const entries = parsed
          .filter((filePath): filePath is string => typeof filePath === 'string')
          .map((filePath) => filePath.replaceAll('\\', '/'))
          .filter((filePath) => filePath && !filePath.startsWith('/')
            && filePath.split('/').every((part) => part && part !== '.' && part !== '..'))
          .map((filePath) => {
            const fullPath = path.join(storageRoot, filePath);
            return fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()
              ? [filePath, fs.readFileSync(fullPath, 'utf8')] as const
              : null;
          })
          .filter((entry): entry is readonly [string, string] => Boolean(entry));
        if (entries.length > 0) return Object.fromEntries(entries);
      }
    } catch {
      // Legacy versions may only have content; fall through to a canonical SKILL.md snapshot.
    }
  }
  return { 'SKILL.md': content };
}

export async function bindSkillWorkbenchContext(input: {
  user: string;
  id: string;
  skillName: string;
  version: number;
}) {
  const skill = await prismaRaw.skill.findFirst({
    where: {
      name: input.skillName,
      AND: [
        { OR: [{ user: input.user }, { user: null }, { visibility: 'public' }] },
        { versions: { some: { version: input.version } } },
      ],
    },
    select: {
      id: true,
      name: true,
      versions: {
        where: { version: input.version },
        take: 1,
        select: { version: true, content: true, files: true },
      },
    },
  });
  const selectedVersion = skill?.versions[0];
  if (!skill || !selectedVersion) return null;

  const updated = await prismaRaw.skillWorkbenchSession.updateMany({
    where: { id: input.id, user: input.user },
    data: {
      skillName: skill.name,
      workVersion: selectedVersion.version,
      source: 'management',
      stage: 'ready',
      activeView: 'detail',
      filesJson: JSON.stringify(snapshotFiles(skill.id, selectedVersion.version, selectedVersion.files, selectedVersion.content)),
    },
  });
  if (updated.count === 0) return null;
  return getSkillWorkbenchSession(input.user, input.id);
}

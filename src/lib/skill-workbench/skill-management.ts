import { prismaRaw } from '@/lib/storage/prisma';
import { resolveSkillVersionFiles } from './session-service';

export const SKILL_MANAGEMENT_PAGE_SIZE = 9;
export const SKILL_MANAGEMENT_MAX_PAGE_SIZE = 36;

export type SkillManagementSource = 'all' | 'uploaded' | 'generated';

export interface SkillManagementQuery {
  search: string;
  category: string;
  source: SkillManagementSource;
  page: number;
  pageSize: number;
}

function positiveInteger(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseSkillManagementQuery(searchParams: URLSearchParams): SkillManagementQuery {
  const requestedSource = searchParams.get('source');
  const source: SkillManagementSource = requestedSource === 'uploaded' || requestedSource === 'generated'
    ? requestedSource
    : 'all';

  return {
    search: (searchParams.get('search') || '').trim().slice(0, 100),
    category: (searchParams.get('category') || '').trim().slice(0, 80),
    source,
    page: positiveInteger(searchParams.get('page'), 1),
    pageSize: Math.min(
      positiveInteger(searchParams.get('pageSize'), SKILL_MANAGEMENT_PAGE_SIZE),
      SKILL_MANAGEMENT_MAX_PAGE_SIZE,
    ),
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function listManagedSkills(user: string, query: SkillManagementQuery) {
  const filters: Record<string, unknown>[] = [
    { OR: [{ user }, { user: null }, { visibility: 'public' }] },
  ];

  if (query.search) {
    filters.push({
      OR: [
        { name: { contains: query.search } },
        { description: { contains: query.search } },
      ],
    });
  }
  if (query.category && query.category !== '全部') filters.push({ category: query.category });
  if (query.source === 'uploaded') filters.push({ isUploaded: true });
  if (query.source === 'generated') filters.push({ isUploaded: false });

  const where = { AND: filters };
  const [total, skills] = await prismaRaw.$transaction([
    prismaRaw.skill.count({ where }),
    prismaRaw.skill.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        name: true,
        category: true,
        description: true,
        tags: true,
        visibility: true,
        author: true,
        user: true,
        activeVersion: true,
        isUploaded: true,
        updatedAt: true,
        versions: {
          orderBy: { version: 'desc' },
          select: { version: true, semanticVersion: true, createdAt: true },
        },
      },
    }),
  ]);

  return {
    items: skills.map((skill) => ({ ...skill, tags: parseStringArray(skill.tags) })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    pages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

export async function getManagedSkillVersionAsset(user: string, skillName: string, version: number) {
  const skill = await prismaRaw.skill.findFirst({
    where: {
      name: skillName,
      AND: [
        { OR: [{ user }, { user: null }, { visibility: 'public' }] },
        { versions: { some: { version } } },
      ],
    },
    select: {
      id: true,
      name: true,
      activeVersion: true,
      versions: {
        where: { version },
        take: 1,
        select: { version: true, content: true, files: true },
      },
    },
  });
  const selectedVersion = skill?.versions[0];
  if (!skill || !selectedVersion) return null;
  return {
    id: skill.id,
    name: skill.name,
    version: selectedVersion.version,
    activeVersion: skill.activeVersion,
    files: resolveSkillVersionFiles(skill.id, selectedVersion.version, selectedVersion.files, selectedVersion.content),
  };
}

import { prismaRaw } from '@/lib/storage/prisma';
import { executionIdsMatchingAllTags } from '@/lib/trace-tag-filters';

export type TraceTagKind = 'version' | 'business';

export type TraceTagDto = {
  id: string;
  name: string;
  description: string | null;
  kind: TraceTagKind;
  color: string;
  createdBy: string | null;
  createdAt: string;
  usageCount: number;
};

export class TraceTagError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TAG_KINDS = new Set<TraceTagKind>(['version', 'business']);
const DEFAULT_TAG_COLOR = '#6366f1';
let ensureTablesPromise: Promise<void> | null = null;

function tagsSupported(): boolean {
  return !process.env.DB_HOST;
}

function assertTagsSupported() {
  if (!tagsSupported()) {
    throw new TraceTagError(501, 'trace tags are not available for this database adapter');
  }
}

function cleanUser(user?: string | null): string {
  const value = String(user || '').trim();
  if (!value) throw new TraceTagError(400, 'user is required');
  return value;
}

function cleanName(name: unknown): string {
  const value = String(name || '').trim();
  if (!value) throw new TraceTagError(400, 'tag name is required');
  if (value.length > 80) throw new TraceTagError(400, 'tag name is too long');
  return value;
}

function cleanKind(kind: unknown): TraceTagKind {
  const value = String(kind || '').trim() as TraceTagKind;
  if (!TAG_KINDS.has(value)) throw new TraceTagError(400, 'tag kind must be version or business');
  return value;
}

function cleanDescription(description: unknown): string | null {
  const value = String(description || '').trim();
  return value ? value.slice(0, 300) : null;
}

function cleanColor(color: unknown): string {
  const value = String(color || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : DEFAULT_TAG_COLOR;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(v => String(v || '').trim()).filter(Boolean)));
}

function toTagDto(row: any): TraceTagDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    kind: row.kind === 'business' ? 'business' : 'version',
    color: row.color || DEFAULT_TAG_COLOR,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt || ''),
    usageCount: row._count?.executionTags ?? row.usageCount ?? 0,
  };
}

export async function ensureTraceTagTables(): Promise<void> {
  if (!tagsSupported()) return;
  if (!ensureTablesPromise) {
    ensureTablesPromise = (async () => {
      await prismaRaw.$executeRawUnsafe('PRAGMA foreign_keys = ON');
      await prismaRaw.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Tag" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "kind" TEXT NOT NULL,
        "color" TEXT NOT NULL,
        "createdBy" TEXT,
        "user" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await prismaRaw.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ExecutionTag" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "executionId" TEXT NOT NULL,
        "tagId" TEXT NOT NULL,
        "user" TEXT,
        "createdBy" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ExecutionTag_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "ExecutionTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`);
      await prismaRaw.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "Tag_user_kind_name_key" ON "Tag"("user", "kind", "name")');
      await prismaRaw.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "Tag_user_kind_createdAt_idx" ON "Tag"("user", "kind", "createdAt")');
      await prismaRaw.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "ExecutionTag_executionId_tagId_key" ON "ExecutionTag"("executionId", "tagId")');
      await prismaRaw.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ExecutionTag_tagId_createdAt_idx" ON "ExecutionTag"("tagId", "createdAt")');
      await prismaRaw.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ExecutionTag_executionId_idx" ON "ExecutionTag"("executionId")');
      await prismaRaw.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ExecutionTag_user_tagId_idx" ON "ExecutionTag"("user", "tagId")');
    })().catch(error => {
      ensureTablesPromise = null;
      throw error;
    });
  }
  await ensureTablesPromise;
}

export async function listTraceTags(userInput: string, kindInput?: string | null): Promise<TraceTagDto[]> {
  assertTagsSupported();
  await ensureTraceTagTables();
  const user = cleanUser(userInput);
  const kind = kindInput ? cleanKind(kindInput) : undefined;
  const rows = await (prismaRaw as any).tag.findMany({
    where: { user, ...(kind ? { kind } : {}) },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { executionTags: true } } },
  });
  return rows.map(toTagDto);
}

export async function createTraceTag(userInput: string, payload: Record<string, unknown>): Promise<TraceTagDto> {
  assertTagsSupported();
  await ensureTraceTagTables();
  const user = cleanUser(userInput);
  try {
    const row = await (prismaRaw as any).tag.create({
      data: {
        name: cleanName(payload.name),
        description: cleanDescription(payload.description),
        kind: cleanKind(payload.kind),
        color: cleanColor(payload.color),
        user,
        createdBy: user,
      },
      include: { _count: { select: { executionTags: true } } },
    });
    return toTagDto(row);
  } catch (error: any) {
    if (error?.code === 'P2002') throw new TraceTagError(409, 'tag name already exists');
    throw error;
  }
}

export async function updateTraceTag(userInput: string, id: string, payload: Record<string, unknown>): Promise<TraceTagDto> {
  assertTagsSupported();
  await ensureTraceTagTables();
  const user = cleanUser(userInput);
  const existing = await (prismaRaw as any).tag.findFirst({ where: { id, user } });
  if (!existing) throw new TraceTagError(404, 'tag not found');
  const data: Record<string, unknown> = {};
  if ('name' in payload) data.name = cleanName(payload.name);
  if ('description' in payload) data.description = cleanDescription(payload.description);
  if ('kind' in payload) data.kind = cleanKind(payload.kind);
  if ('color' in payload) data.color = cleanColor(payload.color);
  try {
    const row = await (prismaRaw as any).tag.update({
      where: { id },
      data,
      include: { _count: { select: { executionTags: true } } },
    });
    return toTagDto(row);
  } catch (error: any) {
    if (error?.code === 'P2002') throw new TraceTagError(409, 'tag name already exists');
    throw error;
  }
}

export async function getTraceTagKind(userInput: string, id: string): Promise<string | null> {
  try {
    await ensureTraceTagTables();
    const row = await (prismaRaw as any).tag.findFirst({
      where: { id, user: cleanUser(userInput) },
      select: { kind: true },
    });
    return row?.kind ?? null;
  } catch {
    return null;
  }
}

export async function deleteTraceTag(userInput: string, id: string): Promise<void> {
  assertTagsSupported();
  await ensureTraceTagTables();
  const user = cleanUser(userInput);
  const existing = await (prismaRaw as any).tag.findFirst({ where: { id, user }, select: { id: true } });
  if (!existing) throw new TraceTagError(404, 'tag not found');
  await (prismaRaw as any).tag.delete({ where: { id } });
}

async function resolveExecutionForUser(ref: string, userInput: string): Promise<{ id: string; user: string | null }> {
  const user = cleanUser(userInput);
  const value = String(ref || '').trim();
  if (!value) throw new TraceTagError(400, 'execution id is required');
  const row = await (prismaRaw as any).execution.findFirst({
    where: { user, OR: [{ id: value }, { taskId: value }] },
    select: { id: true, user: true },
  });
  if (!row) throw new TraceTagError(404, 'execution not found');
  return row;
}

async function loadValidTags(user: string, tagIds: string[]): Promise<any[]> {
  if (tagIds.length === 0) return [];
  const tags = await (prismaRaw as any).tag.findMany({
    where: { user, id: { in: tagIds }, kind: { in: ['version', 'business'] } },
    select: { id: true },
  });
  if (tags.length !== tagIds.length) throw new TraceTagError(400, 'one or more tags are invalid');
  return tags;
}

export async function getExecutionTraceTags(ref: string, userInput: string): Promise<TraceTagDto[]> {
  assertTagsSupported();
  await ensureTraceTagTables();
  const user = cleanUser(userInput);
  const execution = await resolveExecutionForUser(ref, user);
  const rows = await (prismaRaw as any).executionTag.findMany({
    where: { executionId: execution.id, user },
    include: { tag: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row: any) => toTagDto({ ...row.tag, usageCount: 0 }));
}

export async function replaceExecutionTraceTags(ref: string, userInput: string, tagIdsInput: unknown): Promise<TraceTagDto[]> {
  assertTagsSupported();
  await ensureTraceTagTables();
  const user = cleanUser(userInput);
  const execution = await resolveExecutionForUser(ref, user);
  const tagIds = uniqueStrings(tagIdsInput);
  await loadValidTags(user, tagIds);
  await prismaRaw.$transaction(async tx => {
    await (tx as any).executionTag.deleteMany({ where: { executionId: execution.id, user } });
    if (tagIds.length > 0) {
      await (tx as any).executionTag.createMany({
        data: tagIds.map(tagId => ({ executionId: execution.id, tagId, user, createdBy: user })),
      });
    }
  });
  return getExecutionTraceTags(execution.id, user);
}

export async function addExecutionTraceTags(ref: string, userInput: string, tagIdsInput: unknown): Promise<TraceTagDto[]> {
  assertTagsSupported();
  await ensureTraceTagTables();
  const user = cleanUser(userInput);
  const execution = await resolveExecutionForUser(ref, user);
  const tagIds = uniqueStrings(tagIdsInput);
  await loadValidTags(user, tagIds);
  if (tagIds.length > 0) {
    const existing = await (prismaRaw as any).executionTag.findMany({
      where: { executionId: execution.id, tagId: { in: tagIds } },
      select: { tagId: true },
    });
    const seen = new Set(existing.map((row: any) => row.tagId));
    const data = tagIds
      .filter(tagId => !seen.has(tagId))
      .map(tagId => ({ executionId: execution.id, tagId, user, createdBy: user }));
    if (data.length > 0) await (prismaRaw as any).executionTag.createMany({ data });
  }
  return getExecutionTraceTags(execution.id, user);
}

export async function removeExecutionTraceTag(ref: string, userInput: string, tagId: string): Promise<TraceTagDto[]> {
  assertTagsSupported();
  await ensureTraceTagTables();
  const user = cleanUser(userInput);
  const execution = await resolveExecutionForUser(ref, user);
  const cleanTagId = String(tagId || '').trim();
  if (!cleanTagId) throw new TraceTagError(400, 'tagId is required');
  await (prismaRaw as any).executionTag.deleteMany({ where: { executionId: execution.id, tagId: cleanTagId, user } });
  return getExecutionTraceTags(execution.id, user);
}

export async function getTraceTagsByExecutionIds(executionIds: string[], userInput?: string): Promise<Map<string, TraceTagDto[]>> {
  if (!tagsSupported() || executionIds.length === 0 || !userInput) return new Map();
  await ensureTraceTagTables();
  const user = cleanUser(userInput);
  const rows = await (prismaRaw as any).executionTag.findMany({
    where: { executionId: { in: executionIds }, user },
    include: { tag: true },
    orderBy: { createdAt: 'asc' },
  });
  const byExecution = new Map<string, TraceTagDto[]>();
  for (const row of rows) {
    const arr = byExecution.get(row.executionId) ?? [];
    arr.push(toTagDto({ ...row.tag, usageCount: 0 }));
    byExecution.set(row.executionId, arr);
  }
  return byExecution;
}

export async function listBusinessTraceTagFacets(userInput: string): Promise<TraceTagDto[]> {
  return listTraceTags(userInput, 'business');
}

export async function findExecutionIdsByBusinessTags(userInput: string | undefined, tagIdsInput: string[]): Promise<string[] | null> {
  if (!tagsSupported()) return null;
  await ensureTraceTagTables();
  const user = cleanUser(userInput);
  const tagIds = uniqueStrings(tagIdsInput);
  if (tagIds.length === 0) return null;
  const rows = await (prismaRaw as any).executionTag.findMany({
    where: {
      user,
      tagId: { in: tagIds },
      tag: { user, kind: 'business' },
    },
    select: { executionId: true },
  });
  return Array.from(new Set(rows.map((row: any) => row.executionId)));
}

export async function findExecutionIdsByUserTags(userInput: string | undefined, tagIdsInput: string[]): Promise<string[] | null> {
  if (!tagsSupported()) return null;
  await ensureTraceTagTables();
  const user = cleanUser(userInput);
  const tagIds = uniqueStrings(tagIdsInput);
  if (tagIds.length === 0) return null;
  const rows = await (prismaRaw as any).executionTag.findMany({
    where: {
      user,
      tagId: { in: tagIds },
      tag: { user, kind: { in: ['version', 'business'] } },
    },
    select: { executionId: true, tagId: true },
  });
  return executionIdsMatchingAllTags(rows, tagIds);
}

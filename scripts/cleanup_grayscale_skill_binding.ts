import { config } from 'dotenv';
config();

import { PrismaClient } from '@prisma/client';

type GrayscaleTaskRow = {
  id: string;
  user: string;
  taskName: string;
  configJson: string;
  createdAt: string | number | Date;
};

type SkillRow = {
  id: string;
  name: string;
};

type SkillVersionRow = {
  id: string;
  skillId: string;
  version: number;
};

const prisma = new PrismaClient();

function safeParseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function createdAtMs(value: string | number | Date): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function ensureColumn(table: string, column: string, definition: string) {
  const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${table}")`);
  if (columns.some(c => c.name === column)) return false;
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  return true;
}

async function main() {
  const addedSkillId = await ensureColumn('GrayscaleTask', 'skillId', 'TEXT');
  const addedSkillName = await ensureColumn('GrayscaleTask', 'skillName', 'TEXT');
  const addedSkillVersion = await ensureColumn('GrayscaleTask', 'skillVersion', 'INTEGER');
  const addedSkillVersionId = await ensureColumn('GrayscaleTask', 'skillVersionId', 'TEXT');

  const tasks = await prisma.$queryRawUnsafe<GrayscaleTaskRow[]>(
    'SELECT id, user, taskName, configJson, createdAt FROM "GrayscaleTask" ORDER BY createdAt DESC',
  );
  const skills = await prisma.$queryRawUnsafe<SkillRow[]>('SELECT id, name FROM "Skill"');
  const skillsById = new Map(skills.map(skill => [skill.id, skill]));
  const versions = await prisma.$queryRawUnsafe<SkillVersionRow[]>('SELECT id, skillId, version FROM "SkillVersion"');
  const versionsById = new Map(versions.map(version => [version.id, version]));

  const validTasks: Array<GrayscaleTaskRow & { skillId: string; skillName: string; skillVersion: number; skillVersionId: string }> = [];
  const invalidTaskIds: string[] = [];

  for (const task of tasks) {
    const configJson = safeParseJson(task.configJson);
    const skillId = typeof configJson.skillId === 'string' ? configJson.skillId.trim() : '';
    const versionBId = typeof configJson.versionBId === 'string' ? configJson.versionBId.trim() : '';
    const skill = skillId ? skillsById.get(skillId) : null;
    const version = versionBId ? versionsById.get(versionBId) : null;
    if (!skill?.name || !version || version.skillId !== skillId) {
      invalidTaskIds.push(task.id);
      continue;
    }
    validTasks.push({ ...task, skillId, skillName: skill.name, skillVersion: version.version, skillVersionId: version.id });
  }

  const keepIds = new Set<string>();
  const duplicateTaskIds: string[] = [];
  const grouped = new Map<string, Array<GrayscaleTaskRow & { skillId: string; skillName: string; skillVersion: number; skillVersionId: string }>>();

  for (const task of validTasks) {
    const key = `${task.user}\u0000${task.skillName}\u0000${task.skillVersion}`;
    const list = grouped.get(key) || [];
    list.push(task);
    grouped.set(key, list);
  }

  for (const list of grouped.values()) {
    list.sort((a, b) => createdAtMs(b.createdAt) - createdAtMs(a.createdAt));
    keepIds.add(list[0].id);
    duplicateTaskIds.push(...list.slice(1).map(task => task.id));
  }

  const deleteIds = [...invalidTaskIds, ...duplicateTaskIds];
  for (const id of deleteIds) {
    await prisma.$executeRawUnsafe('DELETE FROM "GrayscaleTask" WHERE id = ?', id);
  }

  for (const task of validTasks) {
    if (!keepIds.has(task.id)) continue;
    const configJson = safeParseJson(task.configJson);
    configJson.skillId = task.skillId;
    configJson.versionBId = task.skillVersionId;
    await prisma.$executeRawUnsafe(
      'UPDATE "GrayscaleTask" SET "skillId" = ?, "skillName" = ?, "skillVersion" = ?, "skillVersionId" = ?, "configJson" = ? WHERE id = ?',
      task.skillId,
      task.skillName,
      task.skillVersion,
      task.skillVersionId,
      JSON.stringify(configJson),
      task.id,
    );
  }

  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "GrayscaleTask_user_skillId_idx" ON "GrayscaleTask"("user", "skillId")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "GrayscaleTask_user_skillId_skillVersion_idx" ON "GrayscaleTask"("user", "skillId", "skillVersion")');
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "GrayscaleTask_user_skillName_skillVersion_key" ON "GrayscaleTask"("user", "skillName", "skillVersion")');

  console.log(JSON.stringify({
    addedColumns: { skillId: addedSkillId, skillName: addedSkillName, skillVersion: addedSkillVersion, skillVersionId: addedSkillVersionId },
    scanned: tasks.length,
    kept: keepIds.size,
    deletedInvalid: invalidTaskIds.length,
    deletedDuplicates: duplicateTaskIds.length,
  }, null, 2));
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

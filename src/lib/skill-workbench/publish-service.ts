import fs from 'fs';
import path from 'path';

import { parseSkillFlow } from '@/lib/engine/observability/flow-parser';
import { getSkillVersionAssetPath, getSkillVersionStorageDir } from '@/lib/env';
import { prismaRaw } from '@/lib/storage/prisma';
import { computeSkillSnapshotHash, isBlockingStaticQualityIssue } from './domain';
import { resolveSkillVersionFiles } from './session-service';

export class WorkbenchPublishError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function parseFiles(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function frontmatterValue(content: string, key: string) {
  const body = content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || '';
  return body.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') || '';
}

function safeRelativePath(filePath: string) {
  const normalized = filePath.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new WorkbenchPublishError(`候选包含不安全路径：${filePath}`, 400);
  }
  return normalized;
}

export async function publishWorkbenchSnapshot(input: {
  user: string;
  sessionId: string;
  confirmed?: boolean;
}) {
  const session = await prismaRaw.skillWorkbenchSession.findFirst({
    where: { id: input.sessionId, user: input.user },
  });
  if (!session?.skillName || session.workVersion == null || session.source === 'management') {
    throw new WorkbenchPublishError('当前会话没有可发布的工作快照', 409);
  }
  const usesLegacyGenerationGate = session.source === 'generated';
  if (!usesLegacyGenerationGate && !input.confirmed) {
    throw new WorkbenchPublishError('发布前必须二次确认', 400);
  }
  const files = parseFiles(session.filesJson);
  const skillContent = files['SKILL.md'];
  if (!skillContent) throw new WorkbenchPublishError('工作快照缺少 SKILL.md', 422);
  const contentHash = computeSkillSnapshotHash(files);
  const declaredName = frontmatterValue(skillContent, 'name');
  if (!usesLegacyGenerationGate && declaredName && declaredName !== session.skillName) {
    throw new WorkbenchPublishError(`SKILL.md name 已变为 ${declaredName}，请重新同步工作上下文`, 409);
  }

  if (!usesLegacyGenerationGate) {
    const quality = await prismaRaw.skillSnapshotEvaluation.findFirst({
      where: {
        sessionId: session.id,
        user: input.user,
        skillName: session.skillName,
        proposedVersion: session.workVersion,
        contentHash,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!quality) {
      const previous = await prismaRaw.skillSnapshotEvaluation.findFirst({
        where: {
          sessionId: session.id,
          user: input.user,
          skillName: session.skillName,
          proposedVersion: session.workVersion,
        },
        select: { id: true },
      });
      throw new WorkbenchPublishError(
        previous
          ? '当前工作快照内容已变化，请重新运行静态质量评估'
          : '当前工作快照尚未运行静态质量评估',
        409,
      );
    }
    if (quality.status === 'pending') {
      throw new WorkbenchPublishError('当前工作快照正在进行静态质量评估，请等待完成后再发布', 409);
    }
    if (quality.status === 'failed') {
      throw new WorkbenchPublishError(`静态质量评估执行失败：${quality.errorMessage || '请重新评估'}`, 422);
    }
    if (!['ok', 'partial'].includes(quality.status)) {
      throw new WorkbenchPublishError('当前工作快照没有有效的静态质量评估结果', 409);
    }
    const issues = JSON.parse(quality.issuesJson || '[]') as Array<{
      severity?: string;
      evidence?: string;
      reasoning?: string;
    }>;
    const highIssueCount = issues.filter(isBlockingStaticQualityIssue).length;
    if (highIssueCount > 0) {
      throw new WorkbenchPublishError(`静态质量评估发现 ${highIssueCount} 个高风险问题，请修复并重新评估后发布`, 422);
    }
  }

  let skill = await prismaRaw.skill.findFirst({ where: { name: session.skillName, user: input.user } });
  const latest = skill ? await prismaRaw.skillVersion.findFirst({
    where: { skillId: skill.id }, orderBy: { version: 'desc' }, select: { version: true, content: true, files: true },
  }) : null;
  const expectedVersion = (latest?.version ?? -1) + 1;
  if (!usesLegacyGenerationGate && expectedVersion !== session.workVersion) {
    throw new WorkbenchPublishError(`版本已变化：候选为 v${session.workVersion}，当前应发布 v${expectedVersion}`, 409);
  }
  if (skill && latest && computeSkillSnapshotHash(
    resolveSkillVersionFiles(skill.id, latest.version, latest.files, latest.content),
  ) === contentHash) {
    throw new WorkbenchPublishError('候选与最新正式版本内容相同', 409);
  }

  if (!skill) {
    skill = await prismaRaw.skill.create({
      data: {
        name: session.skillName,
        description: frontmatterValue(skillContent, 'description')
          || (usesLegacyGenerationGate ? 'Published from Playground' : 'Published from Skill Workbench'),
        visibility: 'private',
        activeVersion: 0,
        user: input.user,
      },
    });
  }

  const version = usesLegacyGenerationGate ? expectedVersion : session.workVersion;
  const storageBase = getSkillVersionStorageDir(skill.id, version);
  if (fs.existsSync(storageBase) && fs.readdirSync(storageBase).length > 0) {
    throw new WorkbenchPublishError(`版本 v${version} 的资产目录已存在，已阻止覆盖`, 409);
  }
  fs.mkdirSync(storageBase, { recursive: true });
  const savedFiles: string[] = [];
  for (const [rawPath, content] of Object.entries(files)) {
    const relativePath = safeRelativePath(rawPath);
    const fullPath = path.join(storageBase, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    savedFiles.push(relativePath);
  }

  const skillVersion = await prismaRaw.$transaction(async (tx) => {
    const conflict = await tx.skillVersion.findUnique({
      where: { skillId_version: { skillId: skill!.id, version } }, select: { id: true },
    });
    if (conflict) throw new WorkbenchPublishError(`正式版本 v${version} 已存在`, 409);
    const created = await tx.skillVersion.create({
      data: {
        skillId: skill!.id,
        version,
        content: skillContent,
        assetPath: getSkillVersionAssetPath(skill!.id, version),
        files: JSON.stringify(savedFiles),
        changeLog: `Published from Skill Workbench (${session.source})`,
      },
    });
    await tx.skill.update({ where: { id: skill!.id }, data: { activeVersion: version } });
    await tx.skillWorkbenchSession.update({
      where: { id: session.id },
      data: { source: 'management', stage: 'ready', workVersion: version },
    });
    return created;
  });

  void parseSkillFlow(skillContent, skill.id, version, input.user).catch((error) => {
    console.warn('[skill-workbench publish] flow parse failed:', error);
  });
  return { skill, version: skillVersion };
}

export async function publishOptimizationCandidate(input: {
  user: string;
  skillName: string;
  recordId: string;
  confirmed: boolean;
}) {
  const publishableStatuses = ['pending_retest', 'retesting', 'retest_passed', 'retest_failed', 'retest_cancelled'];
  if (!input.confirmed) throw new WorkbenchPublishError('发布前必须二次确认', 400);
  const record = await prismaRaw.skillOptimizationRecord.findFirst({
    where: { id: input.recordId, user: input.user, skillName: input.skillName },
  });
  if (!record) throw new WorkbenchPublishError('优化候选不存在', 404);
  if (!publishableStatuses.includes(record.status)) {
    throw new WorkbenchPublishError('只有质量规则通过的候选才能发布', 409);
  }
  const skill = await prismaRaw.skill.findFirst({
    where: { name: input.skillName, user: input.user },
  });
  if (!skill) throw new WorkbenchPublishError('只读 Skill 不能发布优化版本', 403);
  const latest = await prismaRaw.skillVersion.findFirst({
    where: { skillId: skill.id }, orderBy: { version: 'desc' }, select: { version: true, content: true, files: true },
  });
  if (!latest || latest.version !== record.baseVersion) {
    throw new WorkbenchPublishError(`正式版本已变化：候选基于 v${record.baseVersion}`, 409);
  }

  const files = parseFiles(record.candidateFilesJson);
  const skillContent = files['SKILL.md'];
  if (!skillContent) throw new WorkbenchPublishError('优化候选缺少 SKILL.md', 422);
  const contentHash = computeSkillSnapshotHash(files);
  if (!record.candidateContentHash || contentHash !== record.candidateContentHash) {
    throw new WorkbenchPublishError('优化候选内容与质量评测快照不一致', 409);
  }
  if (computeSkillSnapshotHash(
    resolveSkillVersionFiles(skill.id, latest.version, latest.files, latest.content),
  ) === contentHash) {
    throw new WorkbenchPublishError('候选与最新正式版本内容相同', 409);
  }
  if (!record.staticEvaluationId) throw new WorkbenchPublishError('候选缺少静态质量评估', 409);
  const quality = await prismaRaw.skillSnapshotEvaluation.findFirst({
    where: {
      id: record.staticEvaluationId,
      sessionId: record.sessionId,
      user: input.user,
      skillName: input.skillName,
      contentHash,
      status: { in: ['ok', 'partial'] },
    },
  });
  if (!quality) throw new WorkbenchPublishError('候选静态质量评估无效或未通过', 409);
  const issues = JSON.parse(quality.issuesJson || '[]') as Array<{
    severity?: string;
    evidence?: string;
    reasoning?: string;
  }>;
  if (issues.some(isBlockingStaticQualityIssue)) {
    throw new WorkbenchPublishError('候选仍有高风险质量问题，已阻止发布', 422);
  }

  const version = record.baseVersion + 1;
  const storageBase = getSkillVersionStorageDir(skill.id, version);
  if (fs.existsSync(storageBase) && fs.readdirSync(storageBase).length > 0) {
    throw new WorkbenchPublishError(`版本 v${version} 的资产目录已存在，已阻止覆盖`, 409);
  }
  fs.mkdirSync(storageBase, { recursive: true });
  const savedFiles: string[] = [];
  for (const [rawPath, content] of Object.entries(files)) {
    const relativePath = safeRelativePath(rawPath);
    const fullPath = path.join(storageBase, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    savedFiles.push(relativePath);
  }

  const published = await prismaRaw.$transaction(async (tx) => {
    const claimed = await tx.skillOptimizationRecord.updateMany({
      where: { id: record.id, status: { in: publishableStatuses }, publishedVersion: null },
      data: { status: 'published', publishedVersion: version, publishedAt: new Date(), completedAt: new Date() },
    });
    if (claimed.count === 0) throw new WorkbenchPublishError('候选已被其他发布操作处理', 409);
    const created = await tx.skillVersion.create({
      data: {
        skillId: skill.id,
        version,
        content: skillContent,
        assetPath: getSkillVersionAssetPath(skill.id, version),
        files: JSON.stringify(savedFiles),
        changeLog: `Published optimized candidate ${record.id}`,
      },
    });
    await tx.skill.update({ where: { id: skill.id }, data: { activeVersion: version } });
    const processSession = await tx.skillWorkbenchSession.findUnique({
      where: { id: record.sessionId },
      select: { optSessionId: true },
    });
    const previousOptimization = processSession?.optSessionId
      ? await tx.skillOptSession.findUnique({
        where: { id: processSession.optSessionId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      })
      : null;
    const nextOptimization = previousOptimization
      ? await tx.skillOptSession.create({
        data: {
          user: previousOptimization.user,
          skillName: previousOptimization.skillName,
          baseVersion: version,
          title: previousOptimization.title,
          files: JSON.stringify(files),
          agentName: previousOptimization.agentName,
          agentTraceSkill: previousOptimization.agentTraceSkill,
          messages: {
            create: previousOptimization.messages.map((message) => ({
              role: message.role,
              content: message.content,
              blocks: message.blocks,
              createdAt: message.createdAt,
            })),
          },
        },
        select: { id: true },
      })
      : null;
    await tx.skillWorkbenchSession.update({
      where: { id: record.sessionId },
      data: {
        source: 'management',
        stage: 'ready',
        activeView: 'optimization',
        workVersion: version,
        filesJson: JSON.stringify(files),
        optSessionId: nextOptimization?.id || processSession?.optSessionId || null,
      },
    });
    return created;
  });

  void parseSkillFlow(skillContent, skill.id, version, input.user).catch((error) => {
    console.warn('[skill-workbench candidate publish] flow parse failed:', error);
  });
  return { skill, version: published, sessionId: record.sessionId };
}

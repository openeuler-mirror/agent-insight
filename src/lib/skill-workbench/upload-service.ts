import { prismaRaw } from '@/lib/storage/prisma';
import { getSkillWorkbenchSession } from './session-service';

const MAX_UPLOAD_FILES = 100;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export class SkillSnapshotUploadError extends Error {}

export function normalizeUploadPath(rawPath: string): string {
  const normalized = rawPath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  const segments = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new SkillSnapshotUploadError(`不安全的文件路径：${rawPath}`);
  }
  return segments.join('/');
}

function frontmatterValue(content: string, key: string): string | null {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1];
  if (!frontmatter) return null;
  const value = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  return value ? value.replace(/^(['"])(.*)\1$/, '$2').trim() : null;
}

export async function parseUploadedSkillSnapshot(files: File[], rawPaths: string[]) {
  if (files.length === 0) throw new SkillSnapshotUploadError('请选择包含 SKILL.md 的目录或文件');
  if (files.length > MAX_UPLOAD_FILES) throw new SkillSnapshotUploadError(`文件数量不能超过 ${MAX_UPLOAD_FILES} 个`);
  if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_BYTES) {
    throw new SkillSnapshotUploadError('上传内容不能超过 5 MB');
  }

  const paths = files.map((file, index) => normalizeUploadPath(rawPaths[index] || file.name));
  const skillMdPaths = paths.filter((filePath) => filePath === 'SKILL.md' || filePath.endsWith('/SKILL.md'));
  if (skillMdPaths.length !== 1) throw new SkillSnapshotUploadError('上传内容必须且只能包含一个 SKILL.md');

  const skillMdPath = skillMdPaths[0];
  const root = skillMdPath === 'SKILL.md' ? '' : skillMdPath.slice(0, -'/SKILL.md'.length);
  const snapshot: Record<string, string> = {};

  for (let index = 0; index < files.length; index += 1) {
    const filePath = paths[index];
    if (root && filePath !== root && !filePath.startsWith(`${root}/`)) {
      throw new SkillSnapshotUploadError(`文件 ${filePath} 不在 Skill 根目录 ${root} 内`);
    }
    const relativePath = root ? filePath.slice(root.length + 1) : filePath;
    const buffer = Buffer.from(await files[index].arrayBuffer());
    if (buffer.includes(0)) throw new SkillSnapshotUploadError(`暂不支持二进制文件：${relativePath}`);
    const content = buffer.toString('utf8');
    if (content.includes('\uFFFD')) throw new SkillSnapshotUploadError(`文件不是有效的 UTF-8 文本：${relativePath}`);
    snapshot[relativePath] = content;
  }

  const skillContent = snapshot['SKILL.md'];
  const fallbackName = root.split('/').at(-1) || 'uploaded-skill';
  const skillName = (frontmatterValue(skillContent, 'name') || fallbackName).trim().slice(0, 120);
  const description = (frontmatterValue(skillContent, 'description') || 'Imported via upload').slice(0, 500);
  if (!skillName) throw new SkillSnapshotUploadError('SKILL.md 缺少有效的 name');

  return { skillName, description, files: snapshot };
}

export async function bindUploadedSkillSnapshot(input: {
  user: string;
  sessionId: string;
  skillName: string;
  files: Record<string, string>;
}) {
  const existing = await prismaRaw.skill.findFirst({
    where: { name: input.skillName, user: input.user },
    select: {
      versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true } },
    },
  });
  const candidateVersion = (existing?.versions[0]?.version ?? -1) + 1;
  const updated = await prismaRaw.skillWorkbenchSession.updateMany({
    where: { id: input.sessionId, user: input.user },
    data: {
      skillName: input.skillName,
      workVersion: candidateVersion,
      source: 'uploaded',
      stage: 'ready',
      activeView: 'detail',
      filesJson: JSON.stringify(input.files),
    },
  });
  if (updated.count === 0) return null;
  return {
    session: await getSkillWorkbenchSession(input.user, input.sessionId),
    candidateVersion,
    targetExists: Boolean(existing),
  };
}

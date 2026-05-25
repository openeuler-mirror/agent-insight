import { db } from '@/lib/storage/prisma';

export interface ResolvedSkill {
  name: string;
  version: number | null;
  semanticVersion: string | null;
  content: string;
  source: 'user' | 'global';
  /** DB SkillVersion.assetPath，相对于项目根目录的路径，如 data/storage/skills/<id>/v<N> */
  assetPath?: string | null;
}

/**
 * 解析一个 skill 名 → 具体版本的内容，按以下优先级：
 *   1. 用户私有 skill（user 维度）
 *   2. 全局 skill（user=null）
 *
 * 版本选择规则：
 *   - 若 caller 指定 version，精确取该版本
 *   - 否则取 skill.activeVersion 对应的 version
 *   - 否则取最新一条（versions 已按 version desc 排序）
 *
 * 找不到 skill 或 skill 没任何 version 时返回 null（caller 决定怎么处理）。
 */
export async function resolveSkill(
  skillName: string,
  user: string,
  desiredVersion?: number,
): Promise<ResolvedSkill | null> {
  if (!skillName) return null;

  const candidates: Array<{ source: 'user' | 'global'; record: any }> = [];
  const userRecord = await db.findSkill(skillName, user);
  if (userRecord) candidates.push({ source: 'user', record: userRecord });

  // 全局 skill：仅当用户私有未命中时再查，避免冗余 IO
  if (!userRecord) {
    const globalRecord = await db.findSkill(skillName, null);
    if (globalRecord) candidates.push({ source: 'global', record: globalRecord });
  }

  if (candidates.length === 0) return null;
  const { source, record } = candidates[0];
  const versions: any[] = Array.isArray(record.versions) ? record.versions : [];
  if (versions.length === 0) return null;

  let version: any = null;
  if (typeof desiredVersion === 'number') {
    version = versions.find(v => v.version === desiredVersion) || null;
  }
  if (!version && record.activeVersion != null) {
    version = versions.find(v => v.version === record.activeVersion) || null;
  }
  if (!version) version = versions[0]; // 已按 desc 排序，取最新

  if (!version || !version.content) return null;

  return {
    name: record.name,
    version: typeof version.version === 'number' ? version.version : null,
    semanticVersion: version.semanticVersion ?? null,
    content: String(version.content),
    source,
    assetPath: version.assetPath ?? null,
  };
}

/**
 * 把 skill content 包装成 system prompt，附加来源信息便于调试。
 */
export function skillToSystemPrompt(skill: ResolvedSkill): string {
  const header = `# Skill: ${skill.name}` +
    (skill.semanticVersion
      ? ` @ ${skill.semanticVersion}`
      : skill.version != null
      ? ` @ v${skill.version}`
      : '');
  return `${header}\n\n${skill.content}`;
}

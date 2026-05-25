import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedSkill } from './skill-resolver';

/**
 * skill-workspace-deployer.ts
 *
 * 把一个 DB-resolved skill 部署到 opencode workspace 的 .opencode/skills/ 目录，
 * 使 opencode agent 可以通过原生 load_skill 工具加载它（而非把 skill 内容塞进 system prompt）。
 *
 * 部署结构：
 *   <workspaceDir>/.opencode/skills/<skillName>/SKILL.md   ← 来自 DB content（精确版本）
 *   <workspaceDir>/.opencode/skills/<skillName>/references/ ← 从 assetPath 复制（如有）
 *   <workspaceDir>/.opencode/skills/<skillName>/scripts/    ← 从 assetPath 复制（如有）
 *
 * 幂等：目标 SKILL.md 存在且内容相同时跳过，不重复写盘。
 * 权限：.opencode/skills/ 目录在 workspaceDir 内，已被 buildPermissionsForWorkspace 的
 *       external_directory 白名单覆盖，agent 可读取，无需额外配置。
 */

/** 递归复制目录或文件（src 不存在时静默跳过）。 */
function copyRecursiveSync(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

export interface DeployResult {
  /** 实际部署到的目录：<workspaceDir>/.opencode/skills/<skillName> */
  targetDir: string;
  /** true = 首次写入或内容变更后重写；false = 内容相同，已跳过 */
  deployed: boolean;
}

/**
 * 把 resolvedSkill 的 SKILL.md 及附属资源部署到：
 *   <workspaceDir>/.opencode/skills/<skillName>/
 *
 * 应在 runner.ts 中于 ensureSessionWorkspace() 之后、client.chat() 之前调用。
 *
 * @param skill       resolveSkill() 返回的 ResolvedSkill 对象
 * @param workspaceDir ensureSessionWorkspace() 返回的 session workspace 目录绝对路径
 */
export function deploySkillToWorkspace(
  skill: ResolvedSkill,
  workspaceDir: string,
): DeployResult {
  const targetDir = path.join(workspaceDir, '.opencode', 'skills', skill.name);
  const skillMdPath = path.join(targetDir, 'SKILL.md');

  // 幂等检查：SKILL.md 已存在且内容相同则跳过
  if (fs.existsSync(skillMdPath)) {
    try {
      const existing = fs.readFileSync(skillMdPath, 'utf-8');
      if (existing === skill.content) {
        return { targetDir, deployed: false };
      }
    } catch {
      // 读取失败，继续走重写路径
    }
  }

  // 1. 写 SKILL.md（来自 DB content 字段，版本精确）
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(skillMdPath, skill.content, 'utf-8');

  // 2. 复制 assetPath 下的附属资源（references/, scripts/ 等子目录）
  //    SKILL.md 已由上面用 DB content 写过，assetPath 里的同名文件不覆盖，保证版本精确性。
  if (skill.assetPath) {
    const assetRoot = path.isAbsolute(skill.assetPath)
      ? skill.assetPath
      : path.join(process.cwd(), skill.assetPath);

    if (fs.existsSync(assetRoot)) {
      for (const entry of fs.readdirSync(assetRoot)) {
        if (entry === 'SKILL.md') continue; // 已用 DB content 写过，不覆盖
        copyRecursiveSync(path.join(assetRoot, entry), path.join(targetDir, entry));
      }
    }
  }

  return { targetDir, deployed: true };
}

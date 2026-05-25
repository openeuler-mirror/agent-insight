import fs from 'node:fs';
import path from 'node:path';

/**
 * 从文件系统加载 skill（直接读 skills/<name>/SKILL.md 当 system prompt）。
 *
 * 为什么不入库：
 *   - 文件改了下一次调用就生效，不需要 DB 同步 / 重新部署
 *   - 项目里 skills/ 目录是 single source of truth，dogfooding 自己管理的资产
 *   - 比 DB 中的"用户私有/全局" skill 更稳，专门给系统内部 agent（skill-generator / 评估器）用
 *
 * 使用方式：
 *   const sys = await loadFileBasedSkillPrompt('skill-generator');
 *   runGeneralAgent({ system: sys, ... });
 *
 * 缓存策略：按 mtime 缓存解析后的字符串，文件没动就不重读。SKILL.md 改了立即生效。
 */

interface CachedSkill {
  mtimeMs: number;
  content: string;
}

const cache = new Map<string, CachedSkill>();

function getSkillsRoot(): string {
  return process.env.SYSTEM_SKILLS_ROOT || path.join(process.cwd(), 'skills');
}

/**
 * 拿到一个文件系统 skill 的完整 SKILL.md 内容（含 YAML frontmatter）。
 * 不存在时抛错——caller 必须自己判断要不要 fallback。
 */
export function loadFileBasedSkillPrompt(skillName: string): string {
  const skillsRoot = getSkillsRoot();
  const skillDir = `${skillsRoot.replace(/[/\\]$/, '')}${path.sep}${skillName}`;
  const skillFile = `${skillDir}${path.sep}SKILL.md`;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(skillFile);
  } catch {
    throw new Error(`file-based skill not found: ${skillFile}`);
  }

  const cached = cache.get(skillName);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.content;
  }

  const content = fs.readFileSync(skillFile, 'utf-8');
  cache.set(skillName, { mtimeMs: stat.mtimeMs, content });
  return content;
}

/**
 * 检查文件系统 skill 是否存在；让 caller 在 file-based 与 DB-based / 硬编码兜底之间做选择。
 */
export function fileBasedSkillExists(skillName: string): boolean {
  try {
    const skillsRoot = getSkillsRoot();
    const skillFile = `${skillsRoot.replace(/[/\\]$/, '')}${path.sep}${skillName}${path.sep}SKILL.md`;
    return fs.statSync(skillFile).isFile();
  } catch {
    return false;
  }
}

/**
 * 调试/管理用：清空缓存，强制下次调用重读盘。
 */
export function invalidateFileBasedSkillCache(skillName?: string): void {
  if (skillName) cache.delete(skillName);
  else cache.clear();
}

/**
 * 把 skills/<name>/ 下的辅助资源（references / scripts / templates）软链接到 workspace 的
 * `.<name>/` 子目录。SKILL.md 本身已经作为 system prompt 注入，无需再放进去。
 *
 * 为什么用 symlink 而不是 copy：
 *   - SKILL.md 改了 references 通常也跟着改，symlink 让 workspace 自动看到最新版
 *   - 零 IO 开销，session 创建快
 *   - 风险：agent 写 .skill-generator/foo.md 会改源文件——靠 system prompt 明确"只读"约束
 *     + 不在 permission 白名单里来兜底（permission 默认只允许 workspace 根目录）
 *
 * 重复挂载安全：已存在符号链接时直接 noop。
 *
 * 调用方在 system prompt 里加一句"参考资源在 .<name>/ 下"，让 agent 知道去哪找。
 */
export function mountFileBasedSkillResources(
  skillName: string,
  workspaceDir: string,
): { mounted: string[]; mountPoint: string | null } {
  const skillsRoot = getSkillsRoot();
  
  // 绕过 Turbopack 静态分析
  const fExists = fs.existsSync;
  const fLstat = fs.lstatSync;

  const skillDir = `${skillsRoot.replace(/[/\\]$/, '')}${path.sep}${skillName}`;
  if (!fExists(skillDir)) return { mounted: [], mountPoint: null };

  const mountPoint = `${workspaceDir.replace(/[/\\]$/, '')}${path.sep}.${skillName}`;
  try {
    fs.mkdirSync(mountPoint, { recursive: true });
  } catch {
    return { mounted: [], mountPoint: null };
  }

  // 链接 SKILL.md（便于 agent reread）+ 所有子目录
  const candidates = ['SKILL.md', 'references', 'scripts', 'templates'];
  const mounted: string[] = [];
  
  for (const name of candidates) {
    const src = `${skillDir.replace(/[/\\]$/, '')}${path.sep}${name}`;
    if (!fExists(src)) continue;
    const dst = `${mountPoint.replace(/[/\\]$/, '')}${path.sep}${name}`;
    try {
      // 已存在则跳过（symlink 是稳定的）
      if (fExists(dst) || fLstat(dst).isSymbolicLink?.()) continue;
    } catch {
      /* lstat fails if not exists — fall through to create */
    }
    try {
      fs.symlinkSync(src, dst);
      mounted.push(name);
    } catch {
      /* symlink create may fail across filesystem boundaries; ignore */
    }
  }
  return { mounted, mountPoint };
}

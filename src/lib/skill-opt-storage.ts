import fs from 'node:fs';
import path from 'node:path';

/**
 * skill-opt 的 workspace 预填与存储目录解析（纯 fs，无 DB / 无 opencode 依赖）。
 *
 * 从 skill-opt-bridge.ts 拆出，原因有二：
 *  1. 这些是纯文件系统逻辑，独立成模块后可直接被 node:test 单测（bridge 主体会
 *     传递性 import opencode SDK，在 tsx 下无法解析，连带拖垮任何 import 它的测试）。
 *  2. 把"存储目录怎么定位、basline 怎么落进 workspace"的机制与 bridge 的编排解耦。
 *
 * 权威目录解析（按 skill 真实 id / SkillVersion.assetPath，需要 DB）留在 bridge 里，
 * 通过 ensureSkillFilesInWorkspace 的 storageDirOverride 形参传进来。
 */

export interface PrefillResult {
  copied: number;
  source: 'storage' | 'baseline_files' | 'none';
  skipped: 'workspace_not_empty' | null;
  storageDir?: string;
}

/**
 * 如果 workspace 还是空的，按优先级填充：
 *   1. storageDirOverride（按 skill.id/assetPath 解析出的权威目录，与测量路径一致）
 *   2. data/storage/skills/<id|name>/v<N>/  （legacy name-scan 兜底，有同名碰撞风险）
 *   3. caller 传进来的 baselineFiles  （dev fallback，前端 mock 数据场景）
 *   4. 都没有 → source=none，agent 在空目录里跑（read SKILL.md 会失败，但不至于挂）
 *
 * 已经有 SKILL.md 时跳过——说明是同 thread 的 follow-up 请求，复用现有文件。
 */
export function ensureSkillFilesInWorkspace(args: {
  skillName: string;
  baseVersion: number;
  workspaceDir: string;
  baselineFiles?: Record<string, string>;
  /**
   * 权威存储目录绝对路径（caller 已按 skill 真实 id / SkillVersion.assetPath 解析好）。
   * 存在即优先用它，避免 resolveSkillStorageDirSync 的 frontmatter-name 扫描在多个
   * 同名 storage 目录间误选。传 null / 路径不在盘上时回退到 name-scan。
   */
  storageDirOverride?: string | null;
}): PrefillResult {
  const { skillName, baseVersion, workspaceDir, baselineFiles, storageDirOverride } = args;

  const skillMdPath = path.join(workspaceDir, 'SKILL.md');
  if (fs.existsSync(skillMdPath)) {
    return { copied: 0, source: 'none', skipped: 'workspace_not_empty' };
  }

  // 权威目录优先；解析不到才退回 legacy name-scan（同名碰撞风险见 resolveSkillStorageDirSync）
  const storageDir =
    storageDirOverride && fs.existsSync(storageDirOverride)
      ? storageDirOverride
      : resolveSkillStorageDirSync(skillName, baseVersion);
  if (storageDir && fs.existsSync(storageDir)) {
    const copied = copyDirRecursive(storageDir, workspaceDir);
    return { copied, source: 'storage', skipped: null, storageDir };
  }

  // 生产 storage 没有 → 试 baselineFiles
  if (baselineFiles && Object.keys(baselineFiles).length > 0) {
    const copied = writeBaselineFiles(workspaceDir, baselineFiles);
    return { copied, source: 'baseline_files', skipped: null };
  }

  return { copied: 0, source: 'none', skipped: null };
}

/**
 * 把 caller 提供的 { 相对路径 → 文件内容 } 直接写到 workspace。
 * 用 path.normalize + 起点检查防止 baselineFiles 里夹绝对路径或 ../ 越权（即使前端不会，
 * 服务端代码也得自卫——bridge 是受网络可达的入口）。
 */
export function writeBaselineFiles(workspaceDir: string, files: Record<string, string>): number {
  let count = 0;
  for (const [rawPath, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    const rel = rawPath.startsWith('/workspace/')
      ? rawPath.slice('/workspace/'.length)
      : rawPath;
    if (rel.startsWith('/') || rel.startsWith('..') || rel.includes('\0')) {
      console.warn('[skill-opt-storage] baseline file rejected:', rel);
      continue;
    }
    const abs = path.resolve(workspaceDir, rel);
    if (!abs.startsWith(workspaceDir + path.sep) && abs !== workspaceDir) {
      console.warn('[skill-opt-storage] baseline file outside workspace:', rel);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
      count++;
    } catch (err) {
      console.warn('[skill-opt-storage] write baseline file failed:', rel, (err as Error)?.message);
    }
  }
  return count;
}

/**
 * Legacy 兜底（同步，无 DB）。仅在权威解析（resolveAuthoritativeStorageDir，见 bridge）
 * 拿不到 storageDirOverride 时使用。
 *
 * ⚠️ 同名碰撞风险：模式 2 按 frontmatter `name:` 扫目录，多个同名 skill 的 storage
 * 目录（orphan / 旧 seed 残留）会按 readdir 顺序返回首个命中——可能是错误且不完整的那个。
 * 权威解析请走 resolveAuthoritativeStorageDir（按真实 id / assetPath）。本函数只用于
 * DB 无记录、但盘上按 name 落了文件的 dev/mock 场景。
 *
 *  路径模式 1：data/storage/skills/<skillName>/v<N>/  （legacy 命名）
 *  路径模式 2：data/storage/skills/<id>/v<N>/         （by-id 命名，按 frontmatter name 扫描匹配）
 */
export function resolveSkillStorageDirSync(skillName: string, version: number): string | null {
  const root = path.join(process.cwd(), 'data', 'storage', 'skills');
  if (!fs.existsSync(root)) return null;

  // 模式 1：直接按 skillName 命名（少数老 skill）
  const byName = path.join(root, skillName, `v${version}`);
  if (fs.existsSync(byName)) return byName;

  // 模式 2：按 id 命名——扫一遍目录，找含 SKILL.md 且 frontmatter name 匹配的
  // 通常 skill 不会很多（< 几十个），扫一遍可接受
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry, `v${version}`);
    const md = path.join(candidate, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    try {
      const head = fs.readFileSync(md, 'utf-8').slice(0, 600);
      const m = head.match(/^name:\s*(.+)$/m);
      if (m && m[1].trim() === skillName) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 递归拷目录。返回拷贝的文件数。跳过隐藏文件和超大文件（与 scanWorkspaceFiles 对齐）。
 */
export function copyDirRecursive(src: string, dst: string): number {
  let count = 0;
  const FILE_SIZE_CAP = 1024 * 1024; // 1MB
  const IGNORE = new Set(['.git', '.opencode', '.DS_Store', 'node_modules']);

  const walk = (relDir: string) => {
    const absSrc = path.join(src, relDir);
    let items: string[];
    try { items = fs.readdirSync(absSrc); } catch { return; }
    for (const item of items) {
      if (IGNORE.has(item) || item.startsWith('.')) continue;
      const relPath = relDir ? path.join(relDir, item) : item;
      const absSrcPath = path.join(src, relPath);
      const absDstPath = path.join(dst, relPath);
      let stat: fs.Stats;
      try { stat = fs.statSync(absSrcPath); } catch { continue; }
      if (stat.isDirectory()) {
        try { fs.mkdirSync(absDstPath, { recursive: true }); } catch { /* exists */ }
        walk(relPath);
      } else {
        if (stat.size > FILE_SIZE_CAP) continue;
        try {
          fs.mkdirSync(path.dirname(absDstPath), { recursive: true });
          fs.copyFileSync(absSrcPath, absDstPath);
          count++;
        } catch (err) {
          console.warn('[skill-opt-storage] copy failed:', absSrcPath, (err as Error)?.message);
        }
      }
    }
  };
  walk('');
  return count;
}

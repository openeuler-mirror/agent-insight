/**
 * 把磁盘上 Skill 资产打包成纯文本，供 L1 regex 和 L2 LLM 评估器消费。
 * 数据源：SkillVersion.assetPath / SkillVersion.files。
 *
 * 2026-06 重整：
 *   - 同时产出"完整文本"（给 L1 regex，永不截断）和"分批 chunks"（给 L2 LLM，单 chunk 不超
 *     MAX_LLM_CHUNK_CHARS，按文件边界切分）。
 *   - 旧字段 references / scripts 保留向后兼容（截断版），但新代码应改用 bundleTextFull / bundleChunks。
 */

import fs from 'fs';
import path from 'path';

export interface AssetBundle {
  /** @deprecated 仅向后兼容；用 bundleTextFull 或 bundleChunks 替代 */
  references: string;
  /** @deprecated 同上 */
  scripts: string;
  totalChars: number;
  fileCount: number;
  /** L1 用：完整不截断的文本拼接（按 `--- 文件: <subdir>/<rel> ---` 分隔每个文件）。 */
  bundleTextFull: string;
  /**
   * L2 用：按文件边界切分的 chunks，每个 ≤ MAX_LLM_CHUNK_CHARS。
   * - 内容 ≤ 单 chunk 上限时，长度为 1
   * - 单文件本身超上限时，会按字符硬切（罕见，仅作 fallback）
   * - 内容为空时返回空数组
   */
  bundleChunks: string[];
}

const MAX_LLM_CHUNK_CHARS = 80_000;
/** 旧字段 references/scripts 沿用的截断总上限。 */
const LEGACY_TRUNCATE_TOTAL_CHARS = 80_000;

interface CollectedFile {
  /** 相对 assetPath 的路径，含子目录前缀，如 "references/foo.md" / "scripts/bar.py" */
  relPath: string;
  content: string;
  /** "references" | "scripts" */
  subdir: string;
}

function readDirRecursive(rootAbs: string, subdir: string): CollectedFile[] {
  const dir = path.join(rootAbs, subdir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const out: CollectedFile[] = [];
  const walk = (p: string, rel: string) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const childAbs = path.join(p, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      try {
        const text = fs.readFileSync(childAbs, 'utf8');
        out.push({
          relPath: path.join(subdir, childRel),
          content: text,
          subdir,
        });
      } catch {
        // ignore unreadable / binary files
      }
    }
  };
  walk(dir, '');
  return out;
}

function fileToBlock(f: CollectedFile): string {
  return `--- 文件: ${f.relPath} ---\n${f.content}\n\n`;
}

/**
 * 按文件边界把 files 切分成 chunks，每个 chunk 文本 ≤ maxChars。
 * 单文件本身超 maxChars 时按字符硬切，并保留文件头到每个切片（罕见）。
 */
function chunkByFiles(files: CollectedFile[], maxChars: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const f of files) {
    const block = fileToBlock(f);
    if (block.length > maxChars) {
      // 当前已积累的先 flush
      if (cur) { chunks.push(cur); cur = ''; }
      // 大文件硬切，每个切片保留文件头标识
      const headerLine = `--- 文件: ${f.relPath} ---\n`;
      let offset = 0;
      let partIdx = 1;
      while (offset < f.content.length) {
        const remainingForBody = Math.max(maxChars - headerLine.length - 64, 1024);
        const slice = f.content.slice(offset, offset + remainingForBody);
        chunks.push(`${headerLine}[第 ${partIdx} 片，offset ${offset}]\n${slice}\n\n`);
        offset += remainingForBody;
        partIdx++;
      }
      continue;
    }
    if (cur && cur.length + block.length > maxChars) {
      chunks.push(cur);
      cur = '';
    }
    cur += block;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** 旧字段 references / scripts 的截断逻辑（仅向后兼容，不再扩展功能）。 */
function buildLegacyTruncated(refs: CollectedFile[], scripts: CollectedFile[]): {
  references: string; scripts: string;
} {
  let references = refs.map(fileToBlock).join('');
  let scriptsText = scripts.map(fileToBlock).join('');
  if (references.length + scriptsText.length > LEGACY_TRUNCATE_TOTAL_CHARS) {
    const refBudget = Math.min(references.length, LEGACY_TRUNCATE_TOTAL_CHARS / 2);
    references = references.slice(0, refBudget) + '\n\n[... truncated ...]';
    const scriptBudget = LEGACY_TRUNCATE_TOTAL_CHARS - references.length;
    scriptsText = scriptsText.slice(0, scriptBudget) + '\n\n[... truncated ...]';
  }
  return { references, scripts: scriptsText };
}

export function loadAssetBundle(assetPath: string | null | undefined): AssetBundle {
  if (!assetPath) {
    return {
      references: '', scripts: '',
      totalChars: 0, fileCount: 0,
      bundleTextFull: '', bundleChunks: [],
    };
  }
  // path.resolve 等价于 path.join(process.cwd(), x)，但避开 Turbopack
  // 对 `path.join(process.cwd(), <dynamic>)` 的 broad-pattern 警告。
  const rootAbs = path.resolve(assetPath);
  const refs = readDirRecursive(rootAbs, 'references');
  const scripts = readDirRecursive(rootAbs, 'scripts');
  const all = [...refs, ...scripts];

  const bundleTextFull = all.map(fileToBlock).join('');
  const bundleChunks = all.length > 0 ? chunkByFiles(all, MAX_LLM_CHUNK_CHARS) : [];
  const legacy = buildLegacyTruncated(refs, scripts);

  return {
    references: legacy.references,
    scripts: legacy.scripts,
    totalChars: bundleTextFull.length,
    fileCount: all.length,
    bundleTextFull,
    bundleChunks,
  };
}

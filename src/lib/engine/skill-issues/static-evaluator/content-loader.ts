/**
 * 把磁盘上 Skill 资产打包成纯文本，供 L2 LLM 评估器消费。
 * 数据源：SkillVersion.assetPath / SkillVersion.files。
 */

import fs from 'fs';
import path from 'path';

export interface AssetBundle {
  references: string;
  scripts: string;
  totalChars: number;
  fileCount: number;
}

const MAX_BUNDLE_CHARS = 80_000;

function readDirRecursive(rootAbs: string, subdir: string): { content: string; fileCount: number } {
  const dir = path.join(rootAbs, subdir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { content: '', fileCount: 0 };
  }

  const lines: string[] = [];
  let count = 0;
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
        lines.push(`--- 文件: ${path.join(subdir, childRel)} ---`);
        lines.push(text);
        lines.push('');
        count++;
      } catch {
        // ignore unreadable / binary files
      }
    }
  };
  walk(dir, '');
  return { content: lines.join('\n'), fileCount: count };
}

export function loadAssetBundle(assetPath: string | null | undefined): AssetBundle {
  if (!assetPath) {
    return { references: '', scripts: '', totalChars: 0, fileCount: 0 };
  }
  const rootAbs = path.isAbsolute(assetPath) ? assetPath : path.join(process.cwd(), assetPath);
  const refs = readDirRecursive(rootAbs, 'references');
  const scripts = readDirRecursive(rootAbs, 'scripts');

  let references = refs.content;
  let scriptsText = scripts.content;
  // 软上限：避免把巨大代码库塞给 LLM
  if (references.length + scriptsText.length > MAX_BUNDLE_CHARS) {
    const refBudget = Math.min(references.length, MAX_BUNDLE_CHARS / 2);
    references = references.slice(0, refBudget) + '\n\n[... truncated ...]';
    const scriptBudget = MAX_BUNDLE_CHARS - references.length;
    scriptsText = scriptsText.slice(0, scriptBudget) + '\n\n[... truncated ...]';
  }

  return {
    references,
    scripts: scriptsText,
    totalChars: references.length + scriptsText.length,
    fileCount: refs.fileCount + scripts.fileCount,
  };
}

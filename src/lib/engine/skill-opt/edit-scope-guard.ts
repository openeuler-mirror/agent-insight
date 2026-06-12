/**
 * 优化器编辑范围硬约束（结构性，不靠 prompt）。
 *
 * 背景：实测 deepseek-v4-pro 会无视"别删脚本/最小编辑"的 prompt 指令，直接把核心脚本
 * （如 analyze_logs.py）整删重构，损失远大于收益。LLM 对否定式约束本就不可靠。
 * 借鉴 trace2skill 的"有界编辑"，在 agent 跑完后用代码强制约束：
 *   - 禁删基线文件：被删就用基线快照还原到 workspace；
 *   - 改动行数预算：超 maxChangedLines 标 overBudget（不自动回滚——交 held-out gate / 用户裁决）。
 *
 * 设计：docs/plans/2026-06-10-skill-issue-merge-conflict-plan-design.md（优化回路改进）
 * 独立模块（不依赖 opencode SDK），便于单测。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 与 scanWorkspaceFiles 对齐的最小形态：content 为按行拆分的数组（或字符串兜底）。 */
export interface VfsFile {
  content: string[] | string;
}

const VFS_PREFIX = '/workspace/';
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.opencode', '__pycache__']);

function vfsLines(fd: VfsFile | undefined): string[] {
  if (!fd) return [];
  return Array.isArray(fd.content) ? fd.content : String(fd.content).split('\n');
}

/** 当前 workspace 全量文件 → { rel: lines[] }（最小本地扫描，不引 opencode）。 */
function scanCurrent(workspaceDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (dir: string) => {
    let items: string[];
    try { items = fs.readdirSync(dir); } catch { return; }
    for (const item of items) {
      if (item.startsWith('.') || IGNORE_DIRS.has(item)) continue;
      const full = path.join(dir, item);
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) { walk(full); continue; }
      let content: string;
      try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
      const rel = path.relative(workspaceDir, full).replace(/\\/g, '/');
      out.set(rel, content.split('\n'));
    }
  };
  walk(workspaceDir);
  return out;
}

/** 粗略改动行数 = 行多重集对称差（不做 LCS，够用于预算告警）。 */
export function lineDiffCount(a: string[], b: string[]): number {
  const bag = new Map<string, number>();
  for (const l of a) bag.set(l, (bag.get(l) ?? 0) + 1);
  let changed = 0;
  for (const l of b) {
    const c = bag.get(l) ?? 0;
    if (c > 0) bag.set(l, c - 1); else changed++;
  }
  for (const c of bag.values()) changed += c;
  return changed;
}

export function enforceEditScope(
  workspaceDir: string,
  baselineVfs: Record<string, VfsFile>,
  opts: { maxChangedLines: number },
): { restored: string[]; changedLines: number; overBudget: boolean } {
  const restored: string[] = [];
  const toRel = (k: string) => (k.startsWith(VFS_PREFIX) ? k.slice(VFS_PREFIX.length) : k.replace(/^\//, ''));

  // 1) 禁删：基线有、workspace 没了 → 还原
  for (const [key, fd] of Object.entries(baselineVfs)) {
    const rel = toRel(key);
    if (!rel || rel.includes('..')) continue;
    const full = path.join(workspaceDir, rel);
    if (!fs.existsSync(full)) {
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, vfsLines(fd).join('\n'), 'utf-8');
        restored.push(rel);
      } catch { /* 还原失败忽略，不阻塞收尾 */ }
    }
  }

  // 2) 改动行数（还原后的当前状态 vs 基线）
  const current = scanCurrent(workspaceDir);
  const baseByRel = new Map<string, string[]>();
  for (const [key, fd] of Object.entries(baselineVfs)) baseByRel.set(toRel(key), vfsLines(fd));
  let changedLines = 0;
  for (const rel of new Set([...baseByRel.keys(), ...current.keys()])) {
    changedLines += lineDiffCount(baseByRel.get(rel) ?? [], current.get(rel) ?? []);
  }

  return { restored, changedLines, overBudget: opts.maxChangedLines > 0 && changedLines > opts.maxChangedLines };
}

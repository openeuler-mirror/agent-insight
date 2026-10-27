/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 服务端加载 skill 某版本的全量文件快照 { relPath: content }。
 *
 * 存储模型（与 /api/skills/[id]/versions/[version]/files/[...path] 路由一致）：
 *   - SKILL.md 正文存 SkillVersion.content
 *   - SkillVersion.files 是相对路径 JSON 数组
 *   - 其余文件落盘在 data/storage/skills/<id>/v<N>/（assetPath 可覆盖）
 *
 * 归并算子用它做 prompt 上下文 + 锚点防幻觉校验。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSkillVersionStorageDir, resolveRuntimeAssetPath } from '@/lib/env';

const MAX_FILE_BYTES = 256 * 1024; // 单文件读入上限；超限文件跳过（锚点不可能锚在巨文件上）

export interface SkillVersionRowLite {
  content: string | null;
  files: string | null;
  assetPath: string | null;
}

export function resolveVersionStorageRoot(skillId: string, version: number, assetPath: string | null): string {
  if (assetPath) {
    return resolveRuntimeAssetPath(assetPath);
  }
  return getSkillVersionStorageDir(skillId, version);
}

export function loadSkillVersionSnapshot(args: {
  skillId: string;
  version: number;
  row: SkillVersionRowLite;
}): Record<string, string> {
  const { skillId, version, row } = args;
  const out: Record<string, string> = { 'SKILL.md': row.content || '' };

  let paths: string[] = [];
  try {
    const parsed = row.files ? JSON.parse(row.files) : null;
    if (Array.isArray(parsed)) paths = parsed.filter((p): p is string => typeof p === 'string');
  } catch { /* files 字段缺失/坏 JSON → 只有 SKILL.md */ }

  const storageRoot = resolveVersionStorageRoot(skillId, version, row.assetPath);
  for (const rel of paths) {
    if (rel.toUpperCase() === 'SKILL.MD') continue;
    if (rel.includes('..') || rel.startsWith('/')) continue;
    const full = path.resolve(storageRoot, rel);
    if (!full.startsWith(path.resolve(storageRoot) + path.sep)) continue;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      out[rel] = fs.readFileSync(full, 'utf-8');
    } catch { /* 文件缺失就跳过——锚点校验自然会拦掉指向它的锚 */ }
  }
  return out;
}

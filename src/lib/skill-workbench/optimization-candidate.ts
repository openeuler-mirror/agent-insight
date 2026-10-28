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

import { fileContentToString, type PlaygroundFiles } from '@/lib/skill-generator/skill-files';

const WORKSPACE_PREFIX = '/workspace/';
const IGNORED_SEGMENTS = new Set(['.git', '.opencode', 'node_modules']);

function normalizePath(filePath: string) {
  return filePath.replaceAll('\\', '/');
}

function skillMdPaths(files: PlaygroundFiles) {
  return Object.keys(files)
    .map(normalizePath)
    .filter((filePath) => (
      filePath === `${WORKSPACE_PREFIX}SKILL.md`
      || (filePath.startsWith(WORKSPACE_PREFIX) && filePath.endsWith('/SKILL.md'))
      || filePath === 'SKILL.md'
      || filePath.endsWith('/SKILL.md')
    ));
}

export function findCanonicalSkillMdPath(files: PlaygroundFiles): string | null {
  const candidates = skillMdPaths(files).sort((left, right) => {
    const leftDepth = left.split('/').filter(Boolean).length;
    const rightDepth = right.split('/').filter(Boolean).length;
    return leftDepth - rightDepth || left.localeCompare(right);
  });
  return candidates[0] || null;
}

export function normalizeOptimizationCandidate(
  files: PlaygroundFiles,
  preferredSkillMdPath?: string | null,
): Record<string, string> {
  const canonicalPath = preferredSkillMdPath && files[preferredSkillMdPath]
    ? normalizePath(preferredSkillMdPath)
    : findCanonicalSkillMdPath(files);
  if (!canonicalPath) return {};

  const root = canonicalPath.slice(0, -'SKILL.md'.length);
  const nestedRoots = skillMdPaths(files)
    .filter((filePath) => filePath !== canonicalPath && filePath.startsWith(root))
    .map((filePath) => filePath.slice(root.length, -'SKILL.md'.length))
    .filter(Boolean);
  const temporaryTopLevel = new Set(nestedRoots
    .map((nestedRoot) => nestedRoot.split('/')[0])
    .filter((segment) => /(?:^|[-_.])(optimized|draft|temporary|tmp)(?:[-_.]|$)/i.test(segment)));

  const candidate: Record<string, string> = {};
  for (const [rawPath, file] of Object.entries(files)) {
    const filePath = normalizePath(rawPath);
    if (!filePath.startsWith(root)) continue;
    const relativePath = filePath.slice(root.length);
    if (!relativePath) continue;
    const segments = relativePath.split('/').filter(Boolean);
    if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) continue;
    if (nestedRoots.some((nestedRoot) => relativePath.startsWith(nestedRoot))) continue;
    if (segments.length > 1 && temporaryTopLevel.has(segments[0])) continue;
    candidate[relativePath] = fileContentToString(file);
  }
  return candidate;
}

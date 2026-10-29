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

import fs from 'node:fs';
import path from 'node:path';
import { prismaRaw } from '@/lib/storage/prisma';

export const OPTIMIZATION_OUTPUT_PLUGIN = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const OptimizationOutput = async ({ directory }) => ({
  'tool.execute.after': async (input, output) => {
    if (input.tool !== 'bash' || typeof output.output !== 'string' || output.output.length <= 8192) return;
    const root = path.join(directory, '.opencode', 'optimization-output');
    try {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const file = path.join(root, randomUUID() + '.txt');
      const full = output.output;
      await fs.writeFile(file, full, { mode: 0o600 });
      output.output = full.slice(0, 4096) + '\n[输出已截断；共 ' + full.length + ' 字符，完整输出：' + file +
        '。仅在需要时分段读取。]\n' + full.slice(-2048);
    } catch { /* Preserve evidence if the full output cannot be saved. */ }
  },
});
`;

export function installOptimizationOutputLimit(workspace: string) {
  const directory = path.join(workspace, '.opencode', 'plugins');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'optimization-output.js'), OPTIMIZATION_OUTPUT_PLUGIN);
}

export async function optimizationContinuity(user: string, threadId: string) {
  const messages = await prismaRaw.skillOptMessage.findMany({ where: { sessionId: threadId, session: { user }, role: 'user' },
    orderBy: { createdAt: 'desc' }, select: { content: true } });
  const previous = messages.slice(1).reverse().map((item) => item.content);
  if (!previous.length) return '';
  return '\n# 既往用户约束参考\n本轮只执行当前请求。以下是既往请求，保留仍适用的约束，冲突时以最新请求为准；不要重新执行旧任务。当前磁盘文件是上一轮候选，先读取相关文件。\n'
    + previous.join('\n---\n');
}

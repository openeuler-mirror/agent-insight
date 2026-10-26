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

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const FILES = [
  { name: 'package.json', contentType: 'application/json; charset=utf-8' },
  { name: 'index.js', contentType: 'text/javascript; charset=utf-8' },
  { name: 'cordis.patch.yml', contentType: 'application/yaml; charset=utf-8' },
] as const;

export type DeepSeekHarnessPluginFile = {
  name: string;
  contentType: string;
  content: Buffer;
  sha256: string;
};

type CachedFiles = {
  root: string;
  sourceDigest: string;
  files: DeepSeekHarnessPluginFile[];
};

let cachedFiles: CachedFiles | undefined;

export function deepSeekHarnessPluginFiles(root = process.cwd()): CachedFiles {
  const sourceRoot = path.join(
    root,
    'scripts',
    'agent-trace-collectors',
    'deepseek-harness',
  );
  const files = FILES.map(({ name, contentType }) => {
    const sourcePath = path.join(sourceRoot, name);
    const metadata = lstatSync(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Invalid DeepSeek Harness plugin source: ${name}`);
    }
    const content = readFileSync(sourcePath);
    return {
      name,
      contentType,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  });
  const sourceHash = createHash('sha256');
  for (const file of files) {
    sourceHash.update(file.name);
    sourceHash.update('\0');
    sourceHash.update(file.content);
    sourceHash.update('\0');
  }
  const sourceDigest = sourceHash.digest('hex');
  if (cachedFiles?.root === root && cachedFiles.sourceDigest === sourceDigest) {
    return cachedFiles;
  }
  cachedFiles = { root, sourceDigest, files };
  return cachedFiles;
}

export function deepSeekHarnessPluginFile(
  name: string,
  root = process.cwd(),
): DeepSeekHarnessPluginFile | undefined {
  return deepSeekHarnessPluginFiles(root).files.find((file) => file.name === name);
}

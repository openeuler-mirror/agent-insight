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

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const productionExtensions = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);
const unsafeChildProcessImport = /(?:from\s+|import\s*\(|require\s*\()\s*['"]node:child_process['"]/;

function listProductionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const sourcePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listProductionSources(sourcePath);
    return productionExtensions.has(path.extname(entry.name)) ? [sourcePath] : [];
  });
}

test('production source avoids Windows-unsafe Turbopack child_process chunk names', () => {
  const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
  const violations = listProductionSources(sourceRoot)
    .filter((sourcePath) => unsafeChildProcessImport.test(readFileSync(sourcePath, 'utf8')))
    .map((sourcePath) => path.relative(sourceRoot, sourcePath));

  assert.deepEqual(violations, []);
});

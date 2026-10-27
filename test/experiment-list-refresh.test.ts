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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('实验列表在存在非终态实验时静默轮询最新状态', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src/app/(main)/experiments/page.tsx'),
    'utf8',
  );

  assert.match(source, /const LIST_REFRESH_MS = 5_000/);
  assert.match(source, /rows\.some\(\(row\) => row\.status === 'running' \|\| row\.status === 'draft'\)/);
  assert.match(source, /window\.setTimeout\(async \(\) => \{[\s\S]*?await load\(true\)[\s\S]*?LIST_REFRESH_MS/);
  assert.match(source, /const sequence = \+\+loadSequence\.current/);
  assert.match(source, /if \(!silent\) setLoading\(true\)/);
});

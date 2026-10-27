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
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('experiment wizard refreshes executable agents while design step is visible', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/components/eval/ExperimentWizard.tsx'),
    'utf8',
  );
  assert.match(source, /const refreshAgents = useCallback/);
  assert.match(source, /step !== 1/);
  assert.match(source, /window\.setInterval\([\s\S]*?10_000/);
  assert.match(source, /window\.addEventListener\('focus', handleFocus\)/);
  assert.match(source, /window\.removeEventListener\('focus', handleFocus\)/);
  assert.match(source, /当前 Agent 已不在最新候选中，请重新选择/);
});

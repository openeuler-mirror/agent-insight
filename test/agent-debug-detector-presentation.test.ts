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

test('does not expose detector provenance as a user-visible finding tag', () => {
  const card = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'observe', 'AgentDebugCard.tsx'),
    'utf8',
  );
  assert.doesNotMatch(card, /专项发现|Specialized finding/);
  assert.match(card, /AgentDebugSupplementalEvidenceBlock/);
  assert.match(card, /relatedFinding=\{findings\.find/);
});

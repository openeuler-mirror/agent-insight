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
import test from 'node:test';

import { redactSensitive, truncateContent } from '../scripts/qwencode-collector/privacy.mjs';

test('QwenCode collector redacts sensitive tool inputs recursively', () => {
  const result = redactSensitive({
    apiKey: 'sk-this-must-not-be-exported',
    nested: { authorization: 'Bearer top-secret-token' },
    text: 'token sk-another-secret',
  });
  assert.deepEqual(result, {
    apiKey: '[REDACTED]',
    nested: { authorization: '[REDACTED]' },
    text: 'token [REDACTED]',
  });
});

test('QwenCode collector truncates prompt and result content at 2000 characters', () => {
  const result = truncateContent('a'.repeat(2_500));
  const expected = `${'a'.repeat(2_000)}…[truncated]`;
  assert.equal(result.length, expected.length);
  assert.equal(result, expected);
});

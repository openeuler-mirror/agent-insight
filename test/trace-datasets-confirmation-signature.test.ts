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

import test from 'node:test';
import assert from 'node:assert/strict';
import { signature } from '../src/lib/trace-datasets/sampling';
import { baseHashes, signatureFromBase } from './helpers/trace-datasets/confirmation-signature';

test('confirmation signature caching exactly matches production across Unicode, short inputs and seeds', () => {
  const texts = ['', 'a', 'abcd', 'abcde', 'a'.repeat(100), 'x\r\ny\rz', '你好👨‍👩‍👧‍👦，cafe\u0301。', '𠮷😃\u0000\u2028\u2029', 'Term 1. '.repeat(600)];
  for (const seed of [0, 42, 200, 219, 0xffffffff]) for (const text of texts) assert.deepEqual(signatureFromBase(baseHashes(text), seed), signature(text, seed));
});

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
import { generatedSessionSyncPolicy } from '@/lib/skill-workbench/generated-session-sync';

const next = { id: 'session', source: 'generated', skillName: 'skill', workVersion: 0 };
const draft = { kind: 'draft', sessionId: 'session', skillName: 'skill', version: 0 };

test('first generated asset follows into detail, duplicate sync preserves evaluation/experiment tab', () => {
  assert.deepEqual(generatedSessionSyncPolicy(null, next), { follow: true, preserveView: false });
  assert.deepEqual(generatedSessionSyncPolicy(draft, next), { follow: true, preserveView: true });
});

test('old generator completion cannot replace a published or separately selected asset', () => {
  assert.equal(generatedSessionSyncPolicy({ ...draft, kind: 'formal', sessionId: null }, next).follow, false);
  assert.equal(generatedSessionSyncPolicy({ ...draft, sessionId: 'other' }, next).follow, false);
  assert.equal(generatedSessionSyncPolicy(draft, { ...next, source: 'management' }).follow, false);
});

test('a genuinely new generated identity opens detail instead of preserving an old asset view', () => {
  assert.deepEqual(generatedSessionSyncPolicy(draft, { ...next, skillName: 'new' }), { follow: true, preserveView: false });
});

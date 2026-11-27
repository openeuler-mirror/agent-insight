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

import {
  FRAMEWORK_OPTIONS,
  parseFrameworks,
  resolveInstallProfile,
} from '@/lib/ingest/setup/install-profile';

function plan(frameworks: string) {
  return resolveInstallProfile(parseFrameworks(frameworks));
}

test('direct Pi and Codex selections do not gain Goal Plus dependencies', () => {
  assert.deepEqual(plan('pi-agent').effectiveFrameworks.map(item => item.value), ['pi-agent']);
  assert.deepEqual(plan('codex').effectiveFrameworks.map(item => item.value), ['codex']);
  assert.deepEqual(plan('pi-agent,codex').effectiveFrameworks.map(item => item.value), ['pi-agent', 'codex']);
});

test('legacy Goal Plus selection maps to the Pi collector without a separate install target', () => {
  const profile = plan('goal-plus');
  assert.deepEqual(profile.effectiveFrameworks.map(item => item.value), ['pi-agent']);
  assert.deepEqual(profile.goalPlusHosts, []);
  assert.deepEqual(profile.autoAddedFrameworks.map(item => item.value), ['pi-agent']);
});

test('legacy Goal Plus input adds Pi only once and does not alter an explicit Codex selection', () => {
  const deduplicated = plan('pi-agent,goal-plus,codex');
  assert.deepEqual(deduplicated.effectiveFrameworks.map(item => item.value), ['pi-agent', 'codex']);
  assert.deepEqual(deduplicated.autoAddedFrameworks, []);
});

test('Goal Plus is not presented as a user-selectable framework', () => {
  assert.equal(FRAMEWORK_OPTIONS.some(item => item.value === 'goal-plus'), false);
});

test('Unknown frameworks are rejected without changing direct Codex selection', () => {
  const profile = plan('codex,unknown');
  assert.deepEqual(profile.effectiveFrameworks.map(item => item.value), ['codex']);
  assert.deepEqual(profile.goalPlusHosts, []);
});

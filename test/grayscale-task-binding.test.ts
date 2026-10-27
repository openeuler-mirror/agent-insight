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
  getGrayscaleTaskBoundSide,
  hydrateGrayscaleTaskBinding,
  isGrayscaleTaskBindingValid,
  normalizeGrayscaleTaskBinding,
} from '../src/lib/grayscale/task-binding';

const task = { skillId: 'skill-1', skillVersionId: 'version-current' };

test('legacy A/B tasks keep B-side binding by default', () => {
  const config = hydrateGrayscaleTaskBinding({
    skillId: 'skill-1',
    versionAId: 'version-old',
    versionBId: 'version-current',
  }, task);

  assert.equal(getGrayscaleTaskBoundSide(config), 'b');
  assert.equal(isGrayscaleTaskBindingValid(config, task), true);
});

test('Skill workbench A/B tasks may bind the current version on side A', () => {
  const config = hydrateGrayscaleTaskBinding({
    skillId: 'skill-1',
    boundSide: 'a',
    versionAId: 'version-current',
    versionBId: 'version-old',
  }, task);

  assert.equal(getGrayscaleTaskBoundSide(config), 'a');
  assert.equal(isGrayscaleTaskBindingValid(config, task), true);
  assert.equal(config.versionBId, 'version-old');
});

test('hydration preserves an invalid explicit binding so validation can reject it', () => {
  const config = hydrateGrayscaleTaskBinding({
    skillId: 'skill-1',
    boundSide: 'a',
    versionAId: 'version-other',
    versionBId: 'version-old',
  }, task);

  assert.equal(config.versionAId, 'version-other');
  assert.equal(isGrayscaleTaskBindingValid(config, task), false);
});

test('normalization repairs only the configured bound side', () => {
  const config = normalizeGrayscaleTaskBinding({
    skillId: 'wrong-skill',
    boundSide: 'a',
    versionAId: 'wrong-version',
    versionBId: 'version-old',
  }, task);

  assert.equal(config.skillId, 'skill-1');
  assert.equal(config.versionAId, 'version-current');
  assert.equal(config.versionBId, 'version-old');
});

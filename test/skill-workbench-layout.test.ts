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
  clampCopilotWidth,
  COPILOT_MIN_WIDTH,
  WORKBENCH_DIVIDER_WIDTH,
  WORKSPACE_MIN_WIDTH,
} from '@/components/skill-workbench/workbench-layout';

test('workbench divider keeps both panes usable while allowing bidirectional resizing', () => {
  const availableWidth = 1600;
  const maxWidth = availableWidth - WORKSPACE_MIN_WIDTH - WORKBENCH_DIVIDER_WIDTH;

  assert.equal(clampCopilotWidth(100, availableWidth), COPILOT_MIN_WIDTH);
  assert.equal(clampCopilotWidth(520, availableWidth), 520);
  assert.equal(clampCopilotWidth(1400, availableWidth), maxWidth);
});

test('workbench divider falls back to the minimum copilot width on narrow screens', () => {
  assert.equal(clampCopilotWidth(520, 900), COPILOT_MIN_WIDTH);
});

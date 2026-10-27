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

import { defaultExperimentName, defaultSkillExperimentName, displayedExperimentName } from '@/lib/engine/experiment/experiment-name';

test('实验默认名称使用当前本地日期和时间，不包含配置复用后缀', () => {
  assert.equal(
    defaultExperimentName(new Date(2026, 8, 24, 9, 5)),
    'Agent 评测 2026-09-24 09:05',
  );
});

test('三种 Skill 实验默认名称与普通实验使用相同时间格式', () => {
  const now = new Date(2026, 8, 26, 13, 36);
  assert.equal(defaultSkillExperimentName('messages', 'trigger', 1, now), 'messages · 触发分析 · v1 · 2026-09-26 13:36');
  assert.equal(defaultSkillExperimentName('messages', 'use-case', 1, now), 'messages · 用例分析 · v1 · 2026-09-26 13:36');
  assert.equal(defaultSkillExperimentName('messages', 'skill-ab', 1, now), 'messages · A/B 测试 · v1 · 2026-09-26 13:36');
});

test('历史复用标题按实验创建时间展示，普通和自定义名称保持原样', () => {
  const createdAt = new Date(2026, 8, 24, 10, 12);
  assert.equal(
    displayedExperimentName('Agent 评测 2026-09-21 18:35 · 同配置 · 同配置 · 复用评测配置', createdAt),
    'Agent 评测 2026-09-24 10:12',
  );
  assert.equal(displayedExperimentName('我的回归实验', createdAt), '我的回归实验');
  assert.equal(displayedExperimentName('我的回归实验 · 同配置', createdAt), '我的回归实验 · 同配置');
});

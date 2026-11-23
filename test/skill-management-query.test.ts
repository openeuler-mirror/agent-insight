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
  SKILL_MANAGEMENT_MAX_PAGE_SIZE,
  SKILL_MANAGEMENT_PAGE_SIZE,
  parseSkillManagementQuery,
} from '../src/lib/skill-workbench/skill-management';

test('管理中心默认按 9 项分页并忽略未知来源', () => {
  const query = parseSkillManagementQuery(new URLSearchParams('source=legacy'));
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, SKILL_MANAGEMENT_PAGE_SIZE);
  assert.equal(query.source, 'all');
});

test('管理中心分页参数有正数校验和上限', () => {
  const query = parseSkillManagementQuery(new URLSearchParams('page=-3&pageSize=999'));
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, SKILL_MANAGEMENT_MAX_PAGE_SIZE);
});

test('管理中心查询会规范化空白并限制输入长度', () => {
  const query = parseSkillManagementQuery(new URLSearchParams({
    search: `  ${'a'.repeat(120)}  `,
    category: '  诊断  ',
    source: 'uploaded',
  }));
  assert.equal(query.search.length, 100);
  assert.equal(query.category, '诊断');
  assert.equal(query.source, 'uploaded');
});

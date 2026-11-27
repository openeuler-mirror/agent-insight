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

/** 评测数据集批量导入 Tool/Skill 目录字段的契约测试。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBatchJson } from '@/lib/dataset-batch-import';

test('导入 Tool/Skill 目录，并以顶层显式目录覆盖 values 中的旧值', () => {
  const result = parseBatchJson(JSON.stringify([
    {
      input: '分析日志',
      available_tools: [{ name: 'grep', description: '搜索文本' }],
      available_skills: [{ name: 'log-analysis', description: '分析日志模式' }],
    },
    {
      input: '无需工具',
      values: { scenario: 'boundary', available_tools: [{ name: 'stale' }] },
      available_tools: [],
    },
  ]), 'ideal_output');

  assert.deepEqual(result.cases.map((item) => item.values), [
    {
      available_tools: [{ name: 'grep', description: '搜索文本' }],
      available_skills: [{ name: 'log-analysis', description: '分析日志模式' }],
    },
    { scenario: 'boundary', available_tools: [] },
  ]);
});

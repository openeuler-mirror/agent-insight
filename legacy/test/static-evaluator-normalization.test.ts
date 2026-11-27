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
  llmDimensionsToIssues,
  normalizeLlmDimensions,
} from '../src/lib/engine/skill-issues/static-evaluator/llm-evaluator';

test('LLM 静态评估忽略非法空分数，并为重复维度保留证据更完整的结果', () => {
  const dimensions = normalizeLlmDimensions([
    {
      dimension: '安全风险性',
      score: 4,
      justification: '只发现一个需要人工确认的风险。',
      issues: [{ summary: '高风险操作缺少确认', severity: 'low', evidence: '执行修复' }],
    },
    {
      dimension: '安全风险性',
      score: 0,
      justification: '',
      issues: [],
    },
  ], '安全风险性');

  assert.equal(dimensions.length, 1);
  assert.equal(dimensions[0].score, 4);
  assert.equal(dimensions[0].issues.length, 1);
});

test('没有证据或原因支撑的 high 问题降为 medium', () => {
  const issues = llmDimensionsToIssues([{
    dimension: '安全风险性',
    score: 2,
    justification: '',
    issues: [{ summary: '模型声称存在风险', severity: 'high' }],
  }], 'security');

  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'medium');
});

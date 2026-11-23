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
  isAgentTrajectoryPresetId,
  runAgentTrajectoryPreset,
} from '@/lib/engine/experiment/agent-trajectory-preset-evaluators';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';

test.afterEach(() => setJudgeLlmCallerForTest(null));

test('步骤效率预置评估器独立认领新 ID，并输出五个维度', async () => {
  assert.equal(isAgentTrajectoryPresetId('preset-agent-step-efficiency'), true);
  assert.equal(isAgentTrajectoryPresetId('preset-agent-process-quality'), true);
  assert.equal(isAgentTrajectoryPresetId('preset-agent-trace-quality'), false);

  setJudgeLlmCallerForTest(async (_user, request) => {
    const prompt = JSON.parse(request.user) as { rubric: { kind: string } };
    assert.equal(prompt.rubric.kind, 'step-efficiency');
    return JSON.stringify({
      summary: '执行路径直接且没有无效重试。',
      dimensions: [
        'step_necessity',
        'path_detour',
        'cost_efficiency',
        'step_density',
        'retry_efficiency',
      ].map(dimension => ({
        dimension,
        verdict: 'met',
        reason: '满足要求。',
        suggestion: '',
      })),
      issues: [],
    });
  });

  const result = await runAgentTrajectoryPreset(
    'preset-agent-step-efficiency',
    'test-user',
    {
      caseInput: '直接回答问题。',
      actualOutput: '答案。',
      referenceOutput: null,
      traceSummaryText: null,
      interactions: [
        { role: 'user', content: '直接回答问题。' },
        { role: 'assistant', content: '答案。' },
      ],
      taskId: null,
      executionId: null,
    },
  );

  assert.equal(result.score, 100);
  assert.equal(result.points?.length, 5);
  assert.ok(result.evidence && 'json' in result.evidence);
  const evidence = result.evidence.json;
  assert.ok(evidence && typeof evidence === 'object' && 'rubricVersion' in evidence);
  assert.equal(evidence.rubricVersion, 'agent-step-efficiency/1.0.0');
});

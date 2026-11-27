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
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DEFAULT_SELECTED_PRESET_IDS, presetEvaluators } from '../src/lib/evaluators/preset-evaluators';

const PROCESS_QUALITY_ID = 'preset-agent-process-quality';

test('旧轨迹质量卡保持 opencode 契约，新过程质量卡使用独立 canonical 六维契约', () => {
  const legacyQuality = presetEvaluators.find(card => card.id === 'preset-agent-trace-quality');
  const processQuality = presetEvaluators.find(card => card.id === PROCESS_QUALITY_ID);

  assert.equal(legacyQuality?.name, 'Agent 轨迹质量');
  assert.deepEqual(legacyQuality?.mappedMetrics, ['轨迹准确性', '推理连续性', '异常处理']);
  assert.match(legacyQuality?.runMode ?? '', /opencode/i);
  assert.match(legacyQuality?.runtimeNote ?? '', /opencode/i);

  assert.equal(processQuality?.name, 'Agent 执行过程质量');
  assert.equal(processQuality?.scoreRange, '0-100');
  assert.deepEqual(processQuality?.mappedMetrics, ['目标对齐', '规划完整性', '推理连贯性', '异常处理', '路径稳健性', '信息利用']);
  assert.match(processQuality?.runMode ?? '', /Canonical Trajectory Judge/);
  assert.doesNotMatch(processQuality?.runtimeNote ?? '', /opencode/i);
  assert.equal(DEFAULT_SELECTED_PRESET_IDS.includes(PROCESS_QUALITY_ID), false);
});

test('执行过程质量卡在三个 Skill 入口遵循 ready 通用规则，仍不进入旧轨迹 API 白名单', () => {
  const skillPages = [
    'src/app/(main)/skill-eval/page.tsx',
    'src/app/(main)/skill-eval/_batch/page.tsx',
    'src/components/eval/GrayscaleEvaluation.tsx',
  ];
  for (const path of skillPages) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /\.filter\(e => e\.status === 'ready'\)/, path);
    assert.doesNotMatch(source, /e\.id !== 'preset-agent-process-quality'/, path);
  }

  const legacyRoute = readFileSync('src/app/api/eval/trajectory/run/route.ts', 'utf8');
  assert.doesNotMatch(legacyRoute, /preset-agent-process-quality/);
});

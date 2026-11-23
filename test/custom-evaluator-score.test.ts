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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomEvaluatorScore } from '../src/lib/evaluators/custom-evaluator-score';

describe('自建评估器 0-100 分数解析', () => {
  it('解析标准 JSON 与文本分数', () => {
    assert.equal(parseCustomEvaluatorScore('{"score":85,"reason":"符合大部分要求"}'), 85);
    assert.equal(parseCustomEvaluatorScore('score: 72/100'), 72);
    assert.equal(parseCustomEvaluatorScore('score: 1/100'), 1);
    assert.equal(parseCustomEvaluatorScore('因此，应该给出[96]是合理的评分'), 96);
  });

  it('完整兼容历史 0-1 量纲，1 映射为 100 分', () => {
    assert.equal(parseCustomEvaluatorScore('{"score":0.85}'), 85);
    assert.equal(parseCustomEvaluatorScore('{"score":1}'), 100);
    assert.equal(parseCustomEvaluatorScore('{"score":0}'), 0);
  });

  it('越界值收敛到 0-100，无法识别时返回 null', () => {
    assert.equal(parseCustomEvaluatorScore('{"score":120}'), 100);
    assert.equal(parseCustomEvaluatorScore('{"score":-5}'), 0);
    assert.equal(parseCustomEvaluatorScore('共发现 2 个问题，但没有给出分数'), null);
  });
});

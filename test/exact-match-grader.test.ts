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
import { describe, it } from 'node:test';
import { gradeExactMatch } from '@/lib/engine/evaluation/exact-match-grader';

describe('ExactMatchGrader', () => {
  it('严格模式完全匹配', () => {
    assert.equal(gradeExactMatch('B', 'B', { caseSensitive: true }).score, 1);
  });

  it('严格模式区分大小写', () => {
    assert.equal(gradeExactMatch('b', 'B', { caseSensitive: true }).score, 0);
  });

  it('支持忽略大小写的两种配置写法', () => {
    assert.equal(gradeExactMatch('b', 'B', { caseSensitive: false }).score, 1);
    assert.equal(gradeExactMatch('b', 'B', { caseInsensitive: true }).score, 1);
  });

  it('支持忽略 Unicode 标点', () => {
    assert.equal(gradeExactMatch('42。', '42', { punctuationInsensitive: true }).score, 1);
  });

  it('支持空白归一化', () => {
    const result = gradeExactMatch('  hello\t world\n', 'hello world', { whitespaceNormalization: true });
    assert.equal(result.score, 1);
    assert.equal(result.reason.normalizedOutput, 'hello world');
  });

  it('多候选任一命中即满分', () => {
    const result = gradeExactMatch('OK', ['OK', 'Okay', 'O.K.'], { caseInsensitive: true });
    assert.equal(result.score, 1);
    assert.deepEqual(result.reason.matchedCandidateIndices, [0]);
  });

  it('空输出不匹配非空答案', () => {
    assert.equal(gradeExactMatch('', 'A').score, 0);
  });

  it('非空输出不匹配空答案', () => {
    assert.equal(gradeExactMatch('A', '').score, 0);
  });

  it('忽略标点后匹配数字格式', () => {
    assert.equal(gradeExactMatch('1,000', '1000', { punctuationInsensitive: true }).score, 1);
  });

  it('NFKC 全半角归一化后匹配', () => {
    assert.equal(gradeExactMatch('Ａ', 'A', { caseSensitive: false, widthNormalization: true }).score, 1);
  });

  it('可选的 fraction 模式按候选命中比例计分', () => {
    assert.equal(gradeExactMatch('OK', ['OK', 'Okay'], { multiCandidateScoring: 'fraction' }).score, 0.5);
  });
});

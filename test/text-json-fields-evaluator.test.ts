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
import {
  evaluateJsonFields,
  validateExpectedRules,
} from '@/lib/engine/experiment/text-json-fields-evaluator';
import { runTextPreset } from '@/lib/engine/experiment/text-preset-evaluators';
import type { FaithfulPresetContext } from '@/lib/engine/experiment/faithful-preset-evaluators';

const USER = 'text-json-fields-test';

function encodeEnvelope(rules: unknown): string {
  const envelope = { rubricVersion: 'result-workshop-v1', metric: 'json-fields', rules };
  return `AI-EVAL-REF-V1:${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')}`;
}

function encodeReference(expected: Record<string, unknown>): string {
  return encodeEnvelope({ expected });
}

function context(actualOutput: string, referenceOutput: string | null): FaithfulPresetContext {
  return {
    caseInput: '',
    actualOutput,
    referenceOutput,
    traceSummaryText: null,
    interactions: [],
    taskId: null,
    executionId: null,
  };
}

describe('结构化信息抽取准确率评估器（实际分发入口）', () => {
  it('全部字段匹配得满分，评分点按字段名排序', async () => {
    const output = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('{"city":"广州","qty":2,"paid":true,"note":null}', encodeReference({ city: '广州', qty: 2, paid: true, note: null })),
    );
    assert.equal(output.score, 100);
    assert.equal(output.verdict, 'pass');
    assert.deepEqual(output.points?.map((p) => p.label), ['city', 'note', 'paid', 'qty']);
    assert.deepEqual(output.points?.map((p) => p.score), [100, 100, 100, 100]);
  });

  it('一项错误得 75 分，错误字段评分为 0 并保留类型差异', async () => {
    const output = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('{"city":"深圳","qty":2,"paid":true,"note":null}', encodeReference({ city: '广州', qty: 2, paid: true, note: null })),
    );
    assert.equal(output.score, 75);
    assert.equal(output.verdict, 'warn');
    const points = new Map((output.points ?? []).map((p) => [p.label, p.score]));
    assert.equal(points.get('city'), 0);
    assert.equal(points.get('qty'), 100);
    const evidence = output.evidence as { json?: Record<string, unknown> };
    const json = evidence.json as { correctCount?: number; totalFields?: number; fieldResults?: Array<Record<string, unknown>> };
    assert.equal(json.correctCount, 3);
    assert.equal(json.totalFields, 4);
    const city = json.fieldResults?.find((r) => r.field === 'city');
    assert.deepEqual(city, { field: 'city', matched: false, actualPresent: true, expected: '广州', actual: '深圳' });
  });

  it('标准值为 null 时区分明确输出 null 与缺失字段', async () => {
    const explicit = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('{"note":null}', encodeReference({ note: null })),
    );
    assert.equal(explicit.score, 100);
    const explicitResult = (explicit.evidence as { json?: { fieldResults?: Array<Record<string, unknown>> } })
      .json?.fieldResults?.[0];
    assert.deepEqual(explicitResult, { field: 'note', matched: true, actualPresent: true, expected: null, actual: null });

    const absent = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('{}', encodeReference({ note: null })),
    );
    assert.equal(absent.score, 0);
    assert.equal(absent.verdict, 'fail');
    const absentResult = (absent.evidence as { json?: { fieldResults?: Array<Record<string, unknown>> } })
      .json?.fieldResults?.[0];
    assert.deepEqual(absentResult, { field: 'note', matched: false, actualPresent: false, expected: null, actual: null });
  });

  it('数字 1 与 1.0 等价，1 与 "1"、true 与 1 不等价', async () => {
    const numeric = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('{"v":1.0}', encodeReference({ v: 1 })),
    );
    assert.equal(numeric.score, 100);

    const stringNumber = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('{"v":"1"}', encodeReference({ v: 1 })),
    );
    assert.equal(stringNumber.score, 0);

    const boolNumber = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('{"v":true}', encodeReference({ v: 1 })),
    );
    assert.equal(boolNumber.score, 0);
  });

  it('字符串严格比较大小写与空白', async () => {
    const caseMismatch = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('{"label":"agent"}', encodeReference({ label: 'Agent' })),
    );
    assert.equal(caseMismatch.score, 0);

    const spaceMismatch = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('{"city":" 广州 "}', encodeReference({ city: '广州' })),
    );
    assert.equal(spaceMismatch.score, 0);
  });

  it('额外字段忽略，不计入分数与评分点', async () => {
    const output = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('{"city":"广州","extra":"说明"}', encodeReference({ city: '广州' })),
    );
    assert.equal(output.score, 100);
    assert.equal(output.points?.length, 1);
    const evidence = output.evidence as { json?: { totalFields?: number } };
    assert.equal(evidence.json?.totalFields, 1);
  });

  it('非法 JSON 与顶层数组按非法实际输出记 0 分', async () => {
    const invalidJson = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('{bad', encodeReference({ city: '广州' })),
    );
    assert.equal(invalidJson.score, 0);
    assert.equal(invalidJson.verdict, 'fail');
    assert.deepEqual(invalidJson.points, []);
    const invalidEvidence = invalidJson.evidence as { json?: Record<string, unknown> };
    assert.equal(invalidEvidence.json?.reasonCode, 'invalid_actual_output');
    assert.equal(invalidEvidence.json?.metric, 'json-fields');
    assert.equal(invalidEvidence.json?.rubricVersion, 'result-workshop-v1');

    const array = await runTextPreset(
      'preset-text-json-fields',
      USER,
      context('[]', encodeReference({ city: '广州' })),
    );
    assert.equal(array.score, 0);
    assert.equal(array.verdict, 'fail');
  });

  it('缺失参考返回 missing_reference，非法参考返回 invalid_reference', async () => {
    const missing = await runTextPreset('preset-text-json-fields', USER, context('{"city":"广州"}', null));
    assert.equal(missing.score, undefined);
    assert.equal(missing.verdict, undefined);
    assert.equal((missing.evidence as { json?: { reasonCode?: string } }).json?.reasonCode, 'missing_reference');

    const blank = await runTextPreset('preset-text-json-fields', USER, context('{"city":"广州"}', '   '));
    assert.equal((blank.evidence as { json?: { reasonCode?: string } }).json?.reasonCode, 'missing_reference');

    const badBase64 = await runTextPreset('preset-text-json-fields', USER, context('{"city":"广州"}', 'AI-EVAL-REF-V1:not_base64!'));
    assert.equal((badBase64.evidence as { json?: { reasonCode?: string } }).json?.reasonCode, 'invalid_reference');
  });
});

describe('参考规则校验（独立纯函数）', () => {
  it('拒绝空 expected、未知键、嵌套值和越界字段名', () => {
    assert.equal(validateExpectedRules({ expected: {} }), null);
    assert.equal(validateExpectedRules({ expected: { city: '广州' }, extra: 1 }), null);
    assert.equal(validateExpectedRules({ expected: { city: { nested: 1 } } }), null);
    assert.equal(validateExpectedRules({ expected: { city: [1, 2] } }), null);
    assert.equal(validateExpectedRules({ expected: { [('a'.repeat(121))]: 'x' } }), null);
    assert.equal(validateExpectedRules({ expected: { '': 'x' } }), null);
    assert.equal(validateExpectedRules({ expected: { city: Number.NaN } }), null);
    assert.deepEqual(validateExpectedRules({ expected: { city: '广州', paid: true, note: null, qty: 2 } }), { city: '广州', paid: true, note: null, qty: 2 });
  });

  it('拒绝超过 32 个字段的 expected', () => {
    const expected: Record<string, number> = {};
    for (let i = 1; i <= 33; i += 1) expected[`f${i}`] = i;
    assert.equal(validateExpectedRules({ expected }), null);
  });
});

describe('结构化信息抽取纯计算（错误与边界样例）', () => {
  it('缺失字段计 0 分并计入分母', () => {
    const output = evaluateJsonFields({ city: '广州', qty: 2, paid: true, note: null }, '{"city":"广州","qty":2,"paid":true}');
    assert.equal(output.score, 75);
    const evidence = output.evidence as { json?: { fieldResults?: Array<Record<string, unknown>> } };
    const note = evidence.json?.fieldResults?.find((r) => r.field === 'note');
    assert.deepEqual(note, { field: 'note', matched: false, actualPresent: false, expected: null, actual: null });
  });
});

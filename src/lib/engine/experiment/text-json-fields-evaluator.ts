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

import {
  EvaluatorOutputSchema,
  type EvalPoint,
  type EvaluatorOutput,
} from '@/lib/evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import { decodeWorkshopReference } from './reference-envelope';

export const TEXT_JSON_FIELDS_PRESET_ID = 'preset-text-json-fields';
const METRIC = 'json-fields';
const RUBRIC_VERSION = 'result-workshop-v1';

type ScalarValue = string | number | boolean | null;
type ExpectedFields = Record<string, ScalarValue>;

export interface FieldResult {
  field: string;
  matched: boolean;
  actualPresent: boolean;
  expected: ScalarValue;
  actual: unknown;
}

const MAX_FIELDS = 32;
const MAX_FIELD_NAME_LENGTH = 120;

function isScalar(value: unknown): value is ScalarValue {
  if (value === null) return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return false;
}

/**
 * 校验本题 rules 语义：固定为 { expected: { 字段名: 标量值 } }。
 * rules 对象拒绝未知键；expected 拒绝非对象、空、超量、字段名越界和嵌套值。
 * 返回 null 表示非法参考。
 */
export function validateExpectedRules(rules: Record<string, unknown>): ExpectedFields | null {
  const ruleKeys = Object.keys(rules);
  if (ruleKeys.length !== 1 || ruleKeys[0] !== 'expected') return null;
  const expected = rules.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return null;
  const entries = Object.entries(expected as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MAX_FIELDS) return null;
  const result: ExpectedFields = {};
  for (const [field, value] of entries) {
    if (field.length < 1 || field.length > MAX_FIELD_NAME_LENGTH) return null;
    if (!isScalar(value)) return null;
    result[field] = value;
  }
  return result;
}

function parseActualObject(actualOutput: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(actualOutput);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function buildSummary(correctCount: number, totalFields: number, score: number, wrongFields: string[]): string {
  let summary = `抽取字段正确 ${correctCount}/${totalFields}，得分 ${Math.round(score * 1e6) / 1e6}。`;
  if (wrongFields.length > 0) {
    summary += `错误或缺失字段：${wrongFields.join('、')}。`;
  }
  if (summary.length > 200) summary = `${summary.slice(0, 199)}…`;
  return summary;
}

/**
 * 纯计算：给定已校验的 expected 与实际输出字符串，产出 EvaluatorOutput。
 * 实际输出非法时返回 score=0 的 fail 结果；expected 必须已通过 validateExpectedRules。
 */
export function evaluateJsonFields(expected: ExpectedFields, actualOutput: string): EvaluatorOutput {
  const actual = parseActualObject(actualOutput);
  if (actual === null) {
    return EvaluatorOutputSchema.parse({
      verdict: 'fail',
      summary: 'Agent 输出无法解析为 JSON 对象，结构化信息抽取记 0 分。',
      score: 0,
      points: [],
      evidence: {
        json: {
          metric: METRIC,
          rubricVersion: RUBRIC_VERSION,
          reasonCode: 'invalid_actual_output',
        },
      },
    });
  }

  const fields = Object.keys(expected).sort();
  const fieldResults: FieldResult[] = fields.map((field) => {
    const expectedValue = expected[field];
    const actualPresent = Object.prototype.hasOwnProperty.call(actual, field);
    const actualValue = actualPresent ? actual[field] : null;
    const matched = actualPresent && expectedValue === actualValue;
    return { field, matched, actualPresent, expected: expectedValue, actual: actualValue };
  });

  const totalFields = fieldResults.length;
  const correctCount = fieldResults.filter((r) => r.matched).length;
  const score = totalFields === 0 ? 0 : (100 * correctCount) / totalFields;
  const verdict = score >= 80 ? 'pass' : score >= 60 ? 'warn' : 'fail';
  const wrongFields = fieldResults.filter((r) => !r.matched).map((r) => r.field);

  const points: EvalPoint[] = fieldResults.map((r) => ({
    label: r.field,
    score: r.matched ? 100 : 0,
    status: r.matched ? 'covered' : 'missing',
    evidence: { json: r },
  }));

  return EvaluatorOutputSchema.parse({
    verdict,
    summary: buildSummary(correctCount, totalFields, score, wrongFields),
    score,
    points,
    evidence: {
      json: {
        metric: METRIC,
        rubricVersion: RUBRIC_VERSION,
        correctCount,
        totalFields,
        fieldResults,
      },
    },
  });
}

export function runTextJsonFieldsPreset(ctx: FaithfulPresetContext): EvaluatorOutput {
  const decoded = decodeWorkshopReference(ctx.referenceOutput, METRIC);
  if (!decoded.ok) {
    const summary = decoded.reasonCode === 'missing_reference'
      ? '未标注参考答案，无法运行结构化信息抽取准确率评估——不记分。'
      : '参考答案格式非法，无法运行结构化信息抽取准确率评估——不记分。';
    return EvaluatorOutputSchema.parse({
      summary,
      evidence: { json: { reasonCode: decoded.reasonCode } },
    });
  }

  const expected = validateExpectedRules(decoded.rules);
  if (expected === null) {
    return EvaluatorOutputSchema.parse({
      summary: '参考答案规则非法，无法运行结构化信息抽取准确率评估——不记分。',
      evidence: { json: { reasonCode: 'invalid_reference' } },
    });
  }

  return evaluateJsonFields(expected, ctx.actualOutput);
}

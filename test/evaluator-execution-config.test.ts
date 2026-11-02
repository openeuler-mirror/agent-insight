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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  resolveEvaluatorExecutionConfig, serializeExperimentEvaluatorConfigs, parseStoredEvaluatorExecutionConfig,
} from '@/lib/evaluators/evaluator-execution-config';
import { parseStoredEvaluatorRunConfigs, EXACT_MATCH_EVALUATOR_ID } from '@/lib/evaluators/evaluator-run-config';
import {
  buildExecutionConfig, effectiveAttemptDraft, executionDraft, restoreEvaluatorDraft, filterEvaluatorCards,
} from '@/lib/evaluators/evaluator-execution-draft';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { EvaluatorExecutionSettings } from '@/components/eval/EvaluatorExecutionSettings';
import { getEvaluatorExecutionCapabilities } from '@/lib/evaluators/evaluator-execution-config.server';

const capabilities = {
  'custom-a': { attemptTimeoutSeconds: 180, maxRetries: 2 },
  'preset-result-answer': { attemptTimeoutSeconds: 300, maxRetries: 2 },
};
const ids = Object.keys(capabilities);

test('custom evaluators with Skills support the OpenCode execution policy', () => {
  const promptOnly = { id: 'custom-prompt', evaluatorType: 'LLM', llmConfig: { systemPrompt: '评估 {{output}}' } } as EvaluatorCard;
  const withSkills = { ...promptOnly, id: 'custom-skills', llmConfig: { ...promptOnly.llmConfig, skills: [{}] } } as EvaluatorCard;
  const supported = getEvaluatorExecutionCapabilities([promptOnly, withSkills]);
  assert.ok(supported[promptOnly.id]);
  assert.equal(supported[withSkills.id].attemptTimeoutSeconds, 180);
  assert.equal(supported[withSkills.id].maxRetries, 2);
  assert.match(supported[withSkills.id].scopeNote!, /OpenCode/);
});

test('execution policy resolves system / uniform / override and snapshots alongside text rules', () => {
  const snapshot = resolveEvaluatorExecutionConfig({ mode: 'uniform', uniform: { attemptTimeoutSeconds: 600, maxRetries: 0 },
    overrides: { 'custom-a': { attemptTimeoutSeconds: 900, maxRetries: 1 } } }, ids, capabilities);
  assert.deepEqual(snapshot.resolved['custom-a'], { attemptTimeoutSeconds: 900, maxRetries: 1, source: 'override' });
  assert.deepEqual(snapshot.resolved['preset-result-answer'], { attemptTimeoutSeconds: 600, maxRetries: 0, source: 'uniform' });
  const stored = serializeExperimentEvaluatorConfigs({ [EXACT_MATCH_EVALUATOR_ID]: { caseSensitive: false } }, [...ids, EXACT_MATCH_EVALUATOR_ID], snapshot);
  assert.deepEqual(parseStoredEvaluatorExecutionConfig(stored), snapshot);
  assert.equal(parseStoredEvaluatorRunConfigs(stored, [...ids, EXACT_MATCH_EVALUATOR_ID])[EXACT_MATCH_EVALUATOR_ID]?.caseSensitive, false);
  const system = resolveEvaluatorExecutionConfig({ mode: 'system', overrides: {} }, ids, capabilities);
  assert.equal(system.resolved['custom-a'].attemptTimeoutSeconds, 180);
  assert.equal(system.resolved['preset-result-answer'].attemptTimeoutSeconds, 300);
  assert.equal(parseStoredEvaluatorExecutionConfig('{}'), undefined);
  assert.equal(parseStoredEvaluatorExecutionConfig(serializeExperimentEvaluatorConfigs({}, ids)), undefined);
});

test('execution policy rejects invalid fields, unavailable overrides and malformed snapshots', () => {
  const uniform = { attemptTimeoutSeconds: 600, maxRetries: 2 };
  for (const bad of [
    { mode: 'bad' }, { mode: 'system', uniform }, { mode: 'uniform' },
    { mode: 'uniform', uniform: { ...uniform, maxRetries: 4 } },
    { mode: 'uniform', uniform: { ...uniform, attemptTimeoutSeconds: '' } },
    { mode: 'uniform', uniform: { ...uniform, attemptTimeoutSeconds: 29 } },
    { mode: 'uniform', uniform: { ...uniform, attemptTimeoutSeconds: 3601 } },
    { mode: 'uniform', uniform: { ...uniform, maxRetries: -1 } },
    { mode: 'uniform', uniform: { ...uniform, maxRetries: 0.5 } },
    { mode: 'system', overrides: { 'custom-other': uniform } },
    { mode: 'system', overrides: { [EXACT_MATCH_EVALUATOR_ID]: uniform } },
    { mode: 'system', resolved: {} },
  ]) assert.throws(() => resolveEvaluatorExecutionConfig(bad, ids, capabilities));
  const snapshot = resolveEvaluatorExecutionConfig({ mode: 'uniform', uniform, overrides: {} }, ids, capabilities);
  snapshot.resolved['custom-a'].attemptTimeoutSeconds = 900;
  assert.throws(() => parseStoredEvaluatorExecutionConfig(serializeExperimentEvaluatorConfigs({}, ids, snapshot)), /不一致/);
});

test('row editing works in system mode; restore is repeatable and restores both fields', () => {
  let draft = executionDraft();
  assert.deepEqual(effectiveAttemptDraft(draft, 'custom-a', capabilities['custom-a']), { attemptTimeoutSeconds: '180', maxRetries: '2' });
  draft.overrides['custom-a'] = { attemptTimeoutSeconds: '900', maxRetries: '0' };
  draft.mode = 'uniform';
  assert.equal(buildExecutionConfig(draft, new Set(ids), capabilities)?.overrides['custom-a'].maxRetries, 0);
  draft = restoreEvaluatorDraft(draft, 'custom-a');
  draft = restoreEvaluatorDraft(draft, 'custom-a');
  assert.equal(effectiveAttemptDraft(draft, 'custom-a', capabilities['custom-a']).attemptTimeoutSeconds, '600');
  draft.mode = 'system';
  assert.equal(effectiveAttemptDraft(draft, 'custom-a', capabilities['custom-a']).attemptTimeoutSeconds, '180');
  draft.overrides['custom-a'] = { attemptTimeoutSeconds: '180', maxRetries: '2' };
  assert.ok(buildExecutionConfig(draft, new Set(ids), capabilities)?.overrides['custom-a']);
  draft.overrides['custom-a'].maxRetries = '';
  assert.throws(() => buildExecutionConfig(draft, new Set(ids), capabilities), /重试/);
  assert.deepEqual(buildExecutionConfig(draft, new Set(['preset-result-answer']), capabilities)?.overrides, {});
});

test('catalog filtering keeps selection separate and uses source metadata', () => {
  const cards = [
    { id: 'custom-a', name: 'TEAM Judge', description: 'quality', source: 'custom' },
    { id: 'preset-result-answer', name: '答案质量', description: '完整性', source: 'preset' },
    { id: 'benchmark:swe-bench', name: 'SWE-bench', description: '', source: 'preset' },
  ] as EvaluatorCard[];
  const selected = new Set(ids);
  assert.deepEqual(filterEvaluatorCards(cards, ' team ', 'custom').map(c => c.id), ['custom-a']);
  assert.equal(filterEvaluatorCards(cards, '', 'preset').length, 1);
  assert.equal(filterEvaluatorCards(cards, '', 'benchmark').length, 1);
  assert.equal(filterEvaluatorCards(cards, 'unknown', 'all').length, 0);
  assert.deepEqual([...selected], ids);
});

test('system-mode settings render numeric editable defaults and always-enabled restore buttons', () => {
  const cards = ids.map((id) => ({ id, name: id })) as EvaluatorCard[];
  const html = renderToStaticMarkup(createElement(EvaluatorExecutionSettings, {
    cards, capabilities, value: executionDraft(), onChange() {},
  }));
  assert.match(html, /评估器单独配置（可选）/);
  assert.match(html, /value="180"/);
  assert.match(html, /value="300"/);
  assert.equal((html.match(/恢复系统默认/g) ?? []).length, 2);
  assert.doesNotMatch(html, /\sdisabled(?:=|\s|>)|确认修改|配置方式/);
});

 test('all 31 preset LLM evaluators are configurable; code and benchmark notices remain visible', async () => {
  const { presetEvaluators } = await import('@/lib/evaluators/preset-evaluators');
  const capabilities = getEvaluatorExecutionCapabilities([]);
  assert.equal(presetEvaluators.filter(c => c.evaluatorType === 'LLM').length, 31);
  assert.equal(Object.keys(capabilities).length, 31);
  for (const card of presetEvaluators) assert.equal(Boolean(capabilities[card.id]), card.evaluatorType === 'LLM', card.id);
  const cards = [...presetEvaluators, { id: 'benchmark:swe-bench', name: 'SWE-bench', evaluatorType: 'Code' } as EvaluatorCard];
  const html = renderToStaticMarkup(createElement(EvaluatorExecutionSettings, { cards, capabilities, value: executionDraft(), onChange() {} }));
  assert.match(html, /代码评估器，不调用模型，不支持超时和重试配置/);
  assert.match(html, /SWE-bench：独立评测服务，不支持在实验中配置超时和重试/);
  assert.doesNotMatch(html, /SWE-bench：代码评估器/);
  assert.match(html, /仅配置评分阶段，Skill 分析和附加建议沿用系统策略/);
  assert.equal((html.match(/恢复系统默认/g) ?? []).length, 31);
});

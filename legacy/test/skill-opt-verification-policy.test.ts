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
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { behavioralCriteria, isTriggerCase, selectBehavioralCases, validJudgment, verificationHash } from '@/lib/engine/skill-opt/verification-policy';
import { inputEnvironmentKey, VerificationCache } from '@/lib/engine/skill-opt/verification-cache';
import { verificationDisplay } from '@/lib/skill-workbench/verification-display';
import { createBlockMirror } from '@/lib/chat/block-mirror';
import type { AgentDatasetRecord, DatasetCase } from '@/server/agent_datasets_storage';

const sample = (id = 'case'): DatasetCase => ({ id, input: `Compute ${id}`, expectedOutput: '42', tags: [], evaluationFocus: '', trajectory: '' });
const dataset = (cases: DatasetCase[]): AgentDatasetRecord => ({ id: 'dataset', user: 'owner', name: 'test', description: '', targetAgent: '', targetSkill: 'test', tags: [], fields: [], cases, datasetKind: 'ideal_output', createdAt: '', updatedAt: '' });

test('exclude trigger dataset, typed labels and legacy trigger answers; keep real standards', () => {
  const variants = [
    { ...sample(), values: { should_trigger: false } },
    { ...sample(), tags: ['should-trigger'] },
    { ...sample(), expectedOutput: 'Skill should not trigger' },
  ];
  for (const item of variants) { assert.equal(isTriggerCase(item), true); assert.equal(behavioralCriteria(item), null); }
  assert.equal(selectBehavioralCases([{ ...dataset([sample()]), tags: ['trigger'] }]).length, 0);
  assert.equal(selectBehavioralCases([{ ...dataset([sample()]), fields: [{ id: 't', key: 'should_trigger', label: 'trigger', type: 'boolean' }] }]).length, 0);
  assert.deepEqual(behavioralCriteria(sample())?.root_causes, [{ content: '42', weight: 1 }]);
  assert.equal(behavioralCriteria({ ...sample(), expectedOutput: '' }), null);
});

test('prioritize linked cases, deduplicate identical inputs and enforce the hard maximum', () => {
  const items = [sample('one'), sample('two'), sample('three')];
  assert.deepEqual(selectBehavioralCases([dataset([...items, { ...items[0], id: 'duplicate' }])], ['three'], 2).map((item) => item.id), ['three', 'one']);
  assert.deepEqual(selectBehavioralCases([dataset([...items, { ...items[0], id: 'duplicate' }])], ['one'], 1).map((item) => item.id), ['one']);
  assert.equal(selectBehavioralCases([dataset(items)], ['one', 'two', 'three'], 1).length, 1);
  assert.equal(selectBehavioralCases([dataset(items)], [], 0).length, 0);
});

test('a real zero is valid; infrastructure, parse failures and nonfinite scores are not', () => {
  assert.equal(validJudgment({ score: 0, reason: 'Requirement missing' }), true);
  for (const reason of ['Judgment API failed: timeout', '未找到评分结果', '请配置 LLM']) assert.equal(validJudgment({ score: 0, reason }), false);
  for (const score of [NaN, Infinity, -1, 2]) assert.equal(validJudgment({ score }), false);
});

test('cache survives a new instance, isolates keys, excludes failed and expired results', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-cache-'));
  const key = verificationHash({ user: 'one', files: { a: 'original' }, model: 'm1', input: 'one' });
  const cache = new VerificationCache(directory);
  await cache.write(key, { output: 'answer', score: 0, judgeKey: 'criteria1', createdAt: Date.now() });
  assert.equal((await new VerificationCache(directory).read(key))?.score, 0);
  assert.equal(await cache.read(verificationHash({ user: 'two' })), null);
  const failed = verificationHash('failed');
  await cache.write(failed, { output: 'answer', score: 0, reason: 'Judgment API failed', createdAt: Date.now() });
  assert.equal(await cache.read(failed), null);
  const expired = verificationHash('expired');
  await cache.write(expired, { output: 'old answer', createdAt: Date.now() - 8 * 86400_000 });
  assert.equal(await cache.read(expired), null);
  assert.equal(await cache.read('../other'), null);
  assert.equal(verificationHash({ a: 1, b: 2 }), verificationHash({ b: 2, a: 1 }));
});

test('input file changes invalidate reuse; missing paths, directories and remote inputs cannot be reused', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-input-'));
  const file = path.join(directory, 'input.txt');
  await fs.writeFile(file, 'one');
  const before = await inputEnvironmentKey(`Read ${file}`);
  assert.ok(before);
  await fs.writeFile(file, 'two');
  assert.notEqual(await inputEnvironmentKey(`Read ${file}`), before);
  for (const input of [`Read ${directory}`, 'Read src/main.py', 'Visit https://example.test', 'Read /no/such/file']) assert.equal(await inputEnvironmentKey(input), null);
});

test('live and persisted verification distinguish completed, skipped and partial measurement', () => {
  const payloads = [
    { behavioral: { measured: 1, reused: 1, baseMean: 60, candMean: 90 } },
    { behavioral: { measured: 0, skipped: '没有有效用例' } },
    { behavioral: { measured: 1, incomplete: '仅完成 1/2' } },
  ];
  const mirror = createBlockMirror({ enqueue: () => {} } as unknown as ReadableStreamDefaultController, new TextEncoder());
  for (const payload of payloads) {
    mirror.send('verify_ok', payload);
    const block = mirror.getBlocks()[0];
    assert.equal(block.status, verificationDisplay(payload).status);
    assert.equal(block.text, verificationDisplay(payload).text);
  }
  assert.equal(verificationDisplay(payloads[0]).status, 'ok');
  assert.equal(verificationDisplay(payloads[1]).status, 'warning');
  assert.equal(verificationDisplay(payloads[2]).status, 'warning');
});

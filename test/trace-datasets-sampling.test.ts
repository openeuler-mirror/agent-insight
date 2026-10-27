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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { signature, sample as sampleWithPolicy, hash, normalizeText, lexicalFeatures, lengthBucket, COVERAGE_POLICY as POLICY, LEGACY_POLICY, type Candidate } from '../src/lib/trace-datasets/sampling';
import { normalizeTraceCases, validateConfig, receiptExpiry } from '../src/lib/trace-datasets/contracts';
import { normalizeSource } from '../src/server/trace-datasets/normalizer';
import { parseTraceBatch } from '../src/lib/trace-datasets/import';
const sample: typeof sampleWithPolicy = (candidates, limit, policy = POLICY, experiment) => sampleWithPolicy(candidates, limit, policy, experiment);
const vectors = JSON.parse(fs.readFileSync('test/fixtures/trace-datasets/signature-v4-vectors.json', 'utf8'));
test('128-dimensional signatures match independently frozen vectors', () => { for (const v of vectors.vectors) assert.deepEqual([...signature(v.text)], v.signature); });
function candidate(input: string, answer: string, cells: string[] = [], task = 'coding'): Candidate {
  return { key: hash([input, answer]), inputKey: hash([input]), signature: signature(input), lexical: lexicalFeatures(input), task, paths: [{ key: hash([input, answer, cells]), cells, knownDimensions: cells.length ? 1 : 0 }] };
}
test('lexical features count repeated tokens for length but only once for coverage', () => {
  assert.deepEqual(lexicalFeatures(' É e\u0301\r\n中 文 hello HELLO !'), { terms: ['é', '中', '文', 'hello'], tokenCount: 6 });
  assert.deepEqual(lexicalFeatures('!?'), { terms: [], tokenCount: 0 });
  assert.deepEqual([0, 32, 33, 128, 129, 512, 513].map(lengthBucket), [0, 0, 1, 1, 2, 2, 3]);
});
test('v5 prioritizes new coverage over distance and discounts already covered terms', () => {
  const pool = [candidate('alpha beta gamma delta epsilon zeta', 'first', [], 'unknown'), candidate('alpha beta gamma delta epsilon', 'repeated', [], 'unknown'), candidate('eta theta iota kappa', 'new', [], 'unknown')];
  const chosen = sample(pool, 2).selected.map(s => s.key);
  assert.deepEqual(chosen, [pool[0].key, pool[2].key]);
  assert.deepEqual(sample(pool, 2), sample([...pool].reverse(), 2));
});
test('v5 keeps proportional length quotas by input group, including answer variants', () => {
  const pool = [8, 48, 160, 600].flatMap((length, bucket) => Array.from({ length: 10 }, (_, n) => candidate(Array.from({ length }, (_, i) => `b${bucket}n${n}t${i}`).join(' '), 'a', [], 'unknown')));
  const variants = Array.from({ length: 50 }, (_, i) => ({ ...pool[0], key: hash(['variant', i]) }));
  for (const candidates of [pool, [...pool, ...variants]]) {
    const result = sample(candidates, 20);
    const counts = [0, 0, 0, 0];
    for (const s of result.selected) counts[lengthBucket(candidates.find(c => c.key === s.key)!.lexical!.tokenCount)]++;
    assert.deepEqual(counts, [5, 5, 5, 5]);
    assert.equal(new Set(result.selected.map(s => candidates.find(c => c.key === s.key)!.inputKey)).size, 20);
    assert.deepEqual(result, sample([...candidates].reverse(), 20));
  }
});
test('v5 reserves enough bucket tokens to finish the quota instead of selecting only longest inputs', () => {
  const pool = [33, 40, 48, 56, 64, 72, 80, 88, 100, 128].map((n, id) => candidate(Array.from({ length: n }, (_, i) => `case${id}word${i}`).join(' '), 'a', [], 'unknown'));
  const result = sample(pool, 5);
  const cost = result.selected.reduce((n, s) => n + pool.find(c => c.key === s.key)!.lexical!.tokenCount, 0);
  assert.equal(result.selected.length, 5);
  assert.ok(cost <= Math.ceil(pool.reduce((n, c) => n + c.lexical!.tokenCount, 0) / 2));
  assert.deepEqual(result, sample([...pool].reverse(), 5));
});
test('task and behavior selections count toward quotas and do not reduce requested count', () => {
  const pool = Array.from({ length: 30 }, (_, i) => candidate(`short task ${i}`, 'a', [], 'unknown'));
  for (let i = 0; i < 4; i++) pool.push(candidate(Array.from({ length: 600 }, (_, j) => `topic${i}word${j}`).join(' '), 'a', [`tool${i}`], `task${i}`));
  const result = sample(pool, 10);
  assert.equal(result.selected.length, 10);
  assert.equal(result.selected.filter(s => s.reason === 'task_floor').length, 4);
  assert.equal(result.selected.filter(s => pool.find(c => c.key === s.key)!.lexical!.tokenCount > 512).length, 4);
  assert.equal(result.counts.coveredCells, 4);
  assert.deepEqual(result, sample([...pool].reverse(), 10));
});
test('v5 behavior budget selects real novel paths before text allocation', () => {
  const pool = Array.from({ length: 30 }, (_, i) => candidate(`task ${i}`, 'a', i < 4 ? [`tool${i}`] : [], 'unknown'));
  const result = sample(pool, 10);
  assert.equal(result.counts.behaviorReserve, 2);
  assert.equal(result.counts.behaviorReserveUsed, 2);
  assert.ok(result.selected.slice(0, 2).every(s => s.reason === 'behavior'));
  assert.equal(result.selected.length, 10);
  assert.deepEqual(result, sample([...pool].reverse(), 10));
});
test('frozen v4 jobs retain exact selections and do not require new lexical features', () => {
  const pool: Candidate[] = Array.from({ length: 12 }, (_, i) => ({ key: hash(['q', i]), inputKey: hash(['input', i]), task: i % 3 ? 'coding' : 'information_lookup', signature: signature(`question ${i} ${'words '.repeat(i)}`), paths: [{ key: `p${i}`, cells: i % 2 ? [`tool${i % 4}`] : [], knownDimensions: i % 2 }] }));
  const result = sample(pool, 5, LEGACY_POLICY);
  assert.deepEqual(sampleWithPolicy(pool, 5), result, 'default remains v4 until the quality gate passes');
  assert.deepEqual(result.selected.map(s => [s.path.key, s.reason]), [['p0', 'task_floor'], ['p10', 'task_floor'], ['p1', 'text_main'], ['p2', 'text_main'], ['p11', 'behavior']]);
  assert.throws(() => sample(pool, 5), /SOURCE_CORRUPT/);
  assert.throws(() => sample(pool, 5, { ...POLICY, version: 'unknown' }), /INVALID_CONFIG/);
});
test('variants retain exactly min(N,K), order independence, task coverage despite unknown behavior', () => {
  const pool = [candidate('write code', 'one'), ...Array.from({ length: 100 }, (_, i) => candidate('write code', `${i}`)), candidate('find facts', 'facts', [], 'information_lookup'), candidate('draft letter', 'letter', [], 'content_generation')];
  for (const k of [1, 3, 20, 100, 500]) {
    const result = sample(pool, k);
    assert.equal(result.selected.length, Math.min(k, pool.length));
    assert.equal(new Set(result.selected.map(s => s.key)).size, result.selected.length);
    assert.deepEqual(result, sample([...pool].reverse(), k));
    if (k >= 3) assert.equal(new Set(result.selected.map(s => pool.find(c => c.key === s.key)!.task)).size, 3);
  }
  assert.throws(() => sample([], 1), /NO_VALID_SAMPLES/);
});
test('multi-path representatives are real and missing behavior cannot suppress novel cells', () => {
  const a = candidate('same task', 'A', ['search']);
  a.paths.push({ key: 'recovered', cells: ['search', 'recovery'], knownDimensions: 2 });
  const pool = [a, candidate('same task', 'B', ['write']), candidate('same task', 'C'), candidate('other task', 'D', ['search']), candidate('third task', 'E')];
  for (const rho of [0, .1, .2, .3]) {
    const result = sample(pool, 4, { version: POLICY.version, seed: 42, rho });
    for (const s of result.selected) assert.ok(pool.find(c => c.key === s.key)!.paths.includes(s.path));
    assert.deepEqual(result, sample([...pool].reverse(), 4, { version: POLICY.version, seed: 42, rho }));
  }
  const all = sample(pool, 5);
  assert.equal(all.selected.find(s => s.key === a.key)!.path.key, 'recovered');
});
test('NFC/LF preserves meaningful whitespace and fixed schema bypasses derived caches', () => {
  const input = ' e\u0301\r\n ', output = ' answer\r\n ';
  const [c] = normalizeTraceCases([{ id: '1', values: { input, reference_output: output }, rootCauseMeta: { status: 'ready' } }]);
  assert.equal(c.input, normalizeText(input)); assert.equal(c.expectedOutput, normalizeText(output));
  assert.deepEqual(Object.keys(c.values), ['input', 'reference_output']); assert.ok(!('rootCauseMeta' in c));
  assert.throws(() => normalizeTraceCases([{ id: '1', values: { input: '', reference_output: 'a' } }]), /非空/);
});
test('normalizer excludes unfinished, multi-turn, truncated and mismatched answers', () => {
  const base = { query: ' task ', finalResult: ' answer ', completed: true, failed: false, platform: 'codex', isSubagent: false, events: [{ role: 'user', content: ' task ' }, { role: 'assistant', content: ' answer ' }] };
  assert.equal(normalizeSource(base).unit?.input, ' task ');
  assert.ok(normalizeSource({ ...base, completed: false }).reason);
  assert.ok(normalizeSource({ ...base, events: [...base.events, { role: 'user', content: 'and then?' }] }).reason);
  assert.ok(normalizeSource({ ...base, finalResult: 'other answer' }).reason);
  assert.ok(normalizeSource({ ...base, events: base.events.map(e => ({ ...e, truncated: true })) }).reason);
});
test('request time boundaries and receipt retention cover future UUID window', () => {
  const now = 1791676800000, stamp = (now + 300000).toString(16).padStart(12, '0');
  const id = `${stamp.slice(0,8)}-${stamp.slice(8)}-7000-8000-000000000001`;
  assert.equal(receiptExpiry(id, now).getTime(), now + 87000000);
  const config = { name: ' test ', platform: 'codex', agentKey: 'agent', requestId: id, limit: 20, from: new Date(now - 86400000).toISOString(), to: new Date(now).toISOString() };
  assert.equal(validateConfig(config, now).name, 'test');
  assert.throws(() => validateConfig({ ...config, limit: 0 }, now));
});
test('Trace JSON/CSV imports preserve spaces, quoted newlines and reject extra or empty fields', () => {
  const expected = { input: ' e\u0301\n ', reference_output: ' answer, "quoted"\n ' };
  const json = parseTraceBatch(JSON.stringify([expected]));
  assert.equal(json.cases[0].input, ' é\n ');
  const csv = parseTraceBatch('input,reference_output\r\n" e\u0301\r\n "," answer, ""quoted""\r\n "\r\n');
  assert.deepEqual(csv.cases[0].values, json.cases[0].values);
  for (const text of ['input,reference_output\nx,', '[{"input":"x","reference_output":"y","score":5}]', 'input,reference_output\n"unclosed,y']) {
    const result = parseTraceBatch(text); assert.equal(result.cases.length, 0); assert.ok(result.message);
  }
});

test('stored multi-turn messages retain history-dependent wording without original requests', async () => {
  const { normalizeSourceUnits } = await import('../src/server/trace-datasets/trace-analysis');
  const { traceTurn } = await import('./helpers/trace-dataset-source');
  const turns = [traceTurn('a', '计算 2 + 3', '5'), traceTurn('b', '再乘以 2', '10', 'history'), traceTurn('c', '把它改成蓝色', '已修改')];
  const source = { query: '计算 2 + 3', finalResult: '已修改', completed: true, failed: false, isSubagent: false, platform: 'workbuddy', events: turns.flatMap(t => t.events) };
  const before = JSON.stringify(source);
  const result = normalizeSourceUnits(source);
  assert.deepEqual(result.units.map(u => [u.input, u.reference_output]), [['计算 2 + 3', '5'], ['再乘以 2', '10'], ['把它改成蓝色', '已修改']]);
  assert.deepEqual(result.exclusions, []);
  assert.equal(JSON.stringify(source), before);
  assert.equal(normalizeSourceUnits({ ...source, completed: false }).units.length, 0);
  assert.equal(normalizeSourceUnits({ ...source, isSubagent: true }).units.length, 0);
  const ignoredMetadata = source.events.map(e => ({ ...e, requestMessages: [{ role: 'assistant', content: 'history' }], traceDatasetBoundary: { context: 'unknown' } }));
  assert.deepEqual(normalizeSourceUnits({ ...source, events: ignoredMetadata }), result);
});

test('sequential messages without IDs pair generically, including independent greetings', async () => {
  const { normalizeSourceUnits } = await import('../src/server/trace-datasets/trace-analysis');
  const events = [{ role: 'user', content: 'HI' }, { role: 'assistant', content: '你好' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: '我在' }];
  for (const platform of ['workbuddy', 'codex', 'opencode']) {
    const result = normalizeSourceUnits({ query: 'HI', finalResult: '我在', completed: true, failed: false, isSubagent: false, platform, events });
    assert.deepEqual(result.units.map(u => u.input), ['HI', 'hi']);
    assert.deepEqual(result.exclusions, []);
  }
});

test('structural extraction rejects incomplete and conflicting turns while retaining valid neighbors', async () => {
  const { normalizeSourceUnits } = await import('../src/server/trace-datasets/trace-analysis');
  const { traceTurn } = await import('./helpers/trace-dataset-source');
  const variants: [string, (events: ReturnType<typeof traceTurn>['events']) => void, string][] = [
    ['missing answer', events => { events.pop(); }, 'ANSWER_UNATTRIBUTED'],
    ['failed answer', events => { events[1].failed = true; }, 'EXECUTION_NOT_SUCCESSFUL'],
    ['truncated', events => { events[1].truncated = true; }, 'TRUNCATED'],
    ['length stop', events => { events[1].finishReason = 'length'; }, 'TRUNCATED'],
    ['tool-use stop', events => { events[1].finishReason = 'tool_calls'; }, 'ANSWER_UNATTRIBUTED'],
    ['analysis only', events => { events[1].channel = 'analysis'; }, 'ANSWER_UNATTRIBUTED'],
    ['tool after answer', events => { events.push({ role: 'tool', content: 'result' }); }, 'ANSWER_UNATTRIBUTED'],
    ['non-text input', events => { events[0].nonText = true; }, 'INPUT_CONTENT_UNSUPPORTED'],
    ['trace mismatch', events => { events[0].traceId = 'another-trace'; }, 'INPUT_UNATTRIBUTED'],
    ['mixed assistant traces', events => { events.push({ ...events[1], traceId: 'another-trace' }); }, 'INPUT_UNATTRIBUTED'],
    ['subagent response', events => { events[1].subagent = true; }, 'INPUT_UNATTRIBUTED'],
    ['overlapping response', events => { events[1].completedAt = '2026-09-06T02:00:00Z'; }, 'ANSWER_UNATTRIBUTED'],
  ];
  for (const [name, mutate, code] of variants) {
    const first = traceTurn('a', 'prompt', 'answer'), next = traceTurn('b', 'another task', 'another answer'); mutate(first.events);
    const result = normalizeSourceUnits({ query: 'prompt', finalResult: 'another answer', completed: true, failed: false, isSubagent: false, platform: 'workbuddy', events: [...first.events, ...next.events] });
    assert.equal(result.units.length, 1, name); assert.equal(result.exclusions[0].code, code, name);
  }
});

test('whole-session finalResult only checks the last turn; intermediate tools are not answers', async () => {
  const { normalizeSourceUnits } = await import('../src/server/trace-datasets/trace-analysis');
  const source = { query: '今天几号', finalResult: '晴', completed: true, failed: false, isSubagent: false, platform: 'workbuddy', events: [
    { role: 'user', content: '今天几号' }, { role: 'assistant', content: '9 月 30 日' },
    { role: 'user', content: '天气呢' }, { role: 'assistant', content: '查询', toolNames: ['search'] }, { role: 'tool', content: '晴' }, { role: 'assistant', content: '晴' },
  ] };
  const result = normalizeSourceUnits(source);
  assert.deepEqual(result.units.map(u => u.reference_output), ['9 月 30 日', '晴']);
  assert.ok(result.units[1].cells.some(c => c.includes('search')));
  const mismatch = normalizeSourceUnits({ ...source, finalResult: 'other' });
  assert.equal(mismatch.units.length, 1); assert.equal(mismatch.exclusions[0].code, 'ANSWER_UNATTRIBUTED');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { BUDGETED_POLICY, budgetedSample, budgetedSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted';
import { COVERAGE_POLICY, LEGACY_POLICY, POLICY, hash, lexicalFeatures, sample, type Candidate } from '../src/lib/trace-datasets/sampling';

function candidate(key: string, terms: string[], cost = terms.length, task = 'unknown', inputKey = key, cells: string[] = []): Candidate {
  return { key, inputKey, task, lexical: { terms, tokenCount: cost }, signature: new Uint32Array(128).fill(key.charCodeAt(0)), paths: [{ key: 'path-' + key, cells, knownDimensions: cells.length }] };
}
function recompute(pool: Candidate[], result: ReturnType<typeof budgetedSample>) {
  const selected = result.selected.map(s => pool.find(c => c.key === s.key)!);
  assert.equal(new Set(selected.map(c => c.key)).size, selected.length);
  assert.equal(result.optimization.tokens, selected.reduce((n, c) => n + c.lexical!.tokenCount, 0));
  assert.equal(result.optimization.vocabulary, new Set(selected.flatMap(c => c.lexical!.terms)).size);
  for (const s of result.selected) assert.ok(pool.find(c => c.key === s.key)!.paths.some(p => JSON.stringify(p) === JSON.stringify(s.path)));
  if (result.optimization.feasible) {
    assert.ok(result.optimization.tokens <= result.optimization.tokenBudget);
    assert.ok(result.optimization.lengthTV <= result.optimization.lengthLimit + 1e-9);
    assert.ok(result.optimization.taskTV <= result.optimization.taskLimit + 1e-9);
  }
}

test('v6 replaces a greedy combination with more vocabulary at lower cost', () => {
  const pool = [candidate('A', ['a', 'b', 'c', 'd']), candidate('B', ['a', 'b', 'e']), candidate('C', ['c', 'd', 'f'])];
  const before = budgetedSample(pool, 2, BUDGETED_POLICY, { swaps: false, restarts: false });
  const after = budgetedSample(pool, 2, BUDGETED_POLICY, { restarts: false });
  assert.equal(before.optimization.vocabulary, 5); assert.equal(after.optimization.vocabulary, 6);
  assert.equal(after.optimization.tokens, 6); assert.ok(after.optimization.oneSwaps > 0);
  assert.deepEqual(new Set(after.selected.map(s => s.key)), new Set(['B', 'C'])); recompute(pool, after);
});

test('v6 keeps deterministic results, exact count and honest global costs across order and seeds', () => {
  const pool = Array.from({ length: 50 }, (_, i) => candidate(String(i), Array.from({ length: 4 + i % 9 }, (_, j) => 't' + (i * 3 + j)), 8 + i % 50, ['coding', 'lookup', 'unknown'][i % 3]));
  for (const seed of [42, 200, 201]) for (const k of [1, 2, 8, 20, 100]) {
    const p = { ...BUDGETED_POLICY, seed }, result = budgetedSample(pool, k, p);
    assert.deepEqual(result, budgetedSample([...pool].reverse(), k, p));
    assert.equal(result.selected.length, Math.min(k, pool.length)); recompute(pool, result);
  }
});

test('two-for-two escapes a one-swap plateau while respecting the same budget', () => {
  const rows: [number[], number][] = [
    [[0, 2, 4], 4], [[4, 5, 9, 11, 16, 19], 7], [[0, 3, 10, 11, 16], 8],
    [[0, 4, 7, 9, 14, 16, 19], 7], [[2, 3, 4, 6, 15, 18, 19], 7], [[0, 1, 13, 15], 5],
    [[0, 2, 4, 5, 6, 7, 9, 19], 10], [[8, 16, 19], 6], [[2, 4, 7, 8, 13, 14, 17], 9],
    [[2, 3, 9], 5], [[1, 3, 7, 9, 11, 12, 15, 19], 11], [[0, 7, 8, 10, 13, 16], 7],
  ];
  const pool = rows.map(([terms, cost], i) => ({ ...candidate(String(i), terms.map(n => 't' + n), cost), signature: new Uint32Array(128) }));
  const one = budgetedSample(pool, 4, BUDGETED_POLICY, { restarts: false, pairSwaps: false });
  const pair = budgetedSample(pool, 4, BUDGETED_POLICY, { restarts: false });
  assert.equal(one.optimization.vocabulary, 17); assert.equal(pair.optimization.vocabulary, 18);
  assert.ok(pair.optimization.pairSwaps > 0); assert.ok(pair.optimization.tokens <= one.optimization.tokens);
  recompute(pool, pair);
});

test('answer variants cannot inflate the input-group budget and repeated inputs still consume tokens', () => {
  const pool = [candidate('a', ['a'], 10), candidate('b', ['b'], 30), ...Array.from({ length: 6 }, (_, i) => candidate('v' + i, ['b'], 30, 'unknown', 'b'))];
  for (const k of [2, 5, 20]) {
    const result = budgetedSample(pool, k);
    assert.equal(result.optimization.baseTokens, Math.min(k, pool.length) * 20); recompute(pool, result);
    assert.equal(result.selected.length, Math.min(k, pool.length));
  }
});

test('task floors and real behavior paths survive swaps without inventing paths', () => {
  const pool = Array.from({ length: 30 }, (_, i) => candidate('c' + i, ['shared', 'word' + i], 4, i % 2 ? 'coding' : 'lookup', 'input' + i, i % 5 === 0 ? ['tool:' + i, 'retry'] : []));
  const old = sample(pool, 12, COVERAGE_POLICY), result = budgetedSample(pool, 12);
  const protectedCells = new Set(old.selected.filter(s => ['task_floor', 'behavior'].includes(s.reason)).flatMap(s => s.path.cells));
  const actual = new Set(result.selected.flatMap(s => s.path.cells));
  for (const cell of protectedCells) assert.ok(actual.has(cell));
  assert.deepEqual(new Set(result.selected.map(s => pool.find(c => c.key === s.key)!.task)), new Set(['coding', 'lookup'])); recompute(pool, result);
});

test('infeasible mandatory long input falls back explicitly without losing output count', () => {
  const pool = [candidate('rare', ['rare'], 10000, 'rare-task'), ...Array.from({ length: 30 }, (_, i) => candidate('short' + i, ['word' + i], 1))];
  const result = budgetedSample(pool, 2);
  assert.equal(result.optimization.feasible, false); assert.equal(result.optimization.effectivePolicy, LEGACY_POLICY.version);
  assert.equal(result.optimization.fallbackReason, 'NO_FEASIBLE_CONSTRUCTION');
  assert.deepEqual(result.selected, sample(pool, 2, LEGACY_POLICY).selected); assert.equal(result.selected.length, 2); recompute(pool, result);
});

test('v6 accepts Unicode and zero lexical-token inputs without excluding valid punctuation', () => {
  const pool = ['！？', '中文 text text', 'é e\u0301', '🦊'].map((s, i) => ({ ...candidate(String(i), []), lexical: lexicalFeatures(s) }));
  const result = budgetedSample(pool, 4); assert.equal(result.selected.length, 4); recompute(pool, result);
});

test('invalid configs and conflicting temporary features fail before selection', () => {
  const a = candidate('a', ['a']);
  for (const ratio of [NaN, Infinity, .99, 1.21]) assert.throws(() => budgetedSample([a], 1, BUDGETED_POLICY, { budgetRatio: ratio }), /INVALID_CONFIG/);
  assert.throws(() => budgetedSample([a], 0), /INVALID_CONFIG/);
  assert.throws(() => budgetedSample([a], 1, { ...BUDGETED_POLICY, version: 'unknown' }), /INVALID_CONFIG/);
  assert.throws(() => budgetedSample([a, a], 2), /SOURCE_CORRUPT/);
  assert.throws(() => budgetedSample([a, candidate('b', ['b'], 1, 'unknown', 'a')], 2), /SOURCE_CORRUPT/);
  assert.throws(() => budgetedSample([{ ...a, lexical: undefined }], 1), /SOURCE_CORRUPT/);
  assert.throws(() => budgetedSample([], 1), /NO_VALID_SAMPLES/);
});

test('v6 yields during large feature processing and remains an explicit candidate', () => {
  const pool = [candidate('a', Array.from({ length: 6000 }, (_, i) => hash(i))), candidate('b', ['b'])];
  const steps = budgetedSampleSteps(pool, 1); assert.equal(steps.next().done, false); steps.return(undefined as never);
  assert.equal(POLICY.version, 'trace-coverage-v4'); assert.deepEqual(sample(pool, 1), sample(pool, 1, LEGACY_POLICY));
});

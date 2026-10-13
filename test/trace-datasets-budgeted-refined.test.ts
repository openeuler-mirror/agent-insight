import test from 'node:test';
import assert from 'node:assert/strict';
import { REFINED_POLICY, refinedSample, refinedSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-refined';
import { COVERAGE_POLICY, LEGACY_POLICY, POLICY, hash, lexicalFeatures, sample, type Candidate } from '../src/lib/trace-datasets/sampling';

function candidate(key: string, terms: string[], cost = terms.length, task = 'unknown', inputKey = key, cells: string[] = []): Candidate {
  return { key, inputKey, task, lexical: { terms, tokenCount: cost }, signature: new Uint32Array(128).fill(key.charCodeAt(0)), paths: [{ key: 'path-' + key, cells, knownDimensions: cells.length }] };
}
function recompute(pool: Candidate[], result: ReturnType<typeof refinedSample>) {
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

test('v6.1 replaces a greedy combination with more vocabulary at lower cost', () => {
  const pool = [candidate('A', ['a', 'b', 'c', 'd']), candidate('B', ['a', 'b', 'e']), candidate('C', ['c', 'd', 'f'])];
  const before = refinedSample(pool, 2, REFINED_POLICY, { swaps: false, restarts: false });
  const after = refinedSample(pool, 2, REFINED_POLICY, { restarts: false });
  assert.equal(before.optimization.vocabulary, 5); assert.equal(after.optimization.vocabulary, 6);
  assert.equal(after.optimization.tokens, 6); assert.ok(after.optimization.oneSwaps > 0);
  assert.deepEqual(new Set(after.selected.map(s => s.key)), new Set(['B', 'C'])); recompute(pool, after);
});

test('v6.1 keeps deterministic results, exact count and honest global costs across order and seeds', () => {
  const pool = Array.from({ length: 50 }, (_, i) => candidate(String(i), Array.from({ length: 4 + i % 9 }, (_, j) => 't' + (i * 3 + j)), 8 + i % 50, ['coding', 'lookup', 'unknown'][i % 3]));
  for (const seed of [42, 200, 201]) for (const k of [1, 2, 8, 20, 100]) {
    const p = { ...REFINED_POLICY, seed }, result = refinedSample(pool, k, p);
    assert.deepEqual(result, refinedSample([...pool].reverse(), k, p));
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
  const one = refinedSample(pool, 4, REFINED_POLICY, { restarts: false, pairSwaps: false });
  const pair = refinedSample(pool, 4, REFINED_POLICY, { restarts: false });
  assert.equal(one.optimization.vocabulary, 17); assert.equal(pair.optimization.vocabulary, 18);
  assert.ok(pair.optimization.pairSwaps > 0); assert.ok(pair.optimization.tokens <= one.optimization.tokens);
  recompute(pool, pair);
});

test('answer variants cannot inflate the input-group budget and repeated inputs still consume tokens', () => {
  const pool = [candidate('a', ['a'], 10), candidate('b', ['b'], 30), ...Array.from({ length: 6 }, (_, i) => candidate('v' + i, ['b'], 30, 'unknown', 'b'))];
  for (const k of [2, 5, 20]) {
    const result = refinedSample(pool, k);
    assert.equal(result.optimization.baseTokens, Math.min(k, pool.length) * 20); recompute(pool, result);
    assert.equal(result.selected.length, Math.min(k, pool.length));
  }
});

test('task floors and real behavior paths survive swaps without inventing paths', () => {
  const pool = Array.from({ length: 30 }, (_, i) => candidate('c' + i, ['shared', 'word' + i], 4, i % 2 ? 'coding' : 'lookup', 'input' + i, i % 5 === 0 ? ['tool:' + i, 'retry'] : []));
  const old = sample(pool, 12, COVERAGE_POLICY), result = refinedSample(pool, 12);
  const protectedCells = new Set(old.selected.filter(s => ['task_floor', 'behavior'].includes(s.reason)).flatMap(s => s.path.cells));
  const actual = new Set(result.selected.flatMap(s => s.path.cells));
  for (const cell of protectedCells) assert.ok(actual.has(cell));
  assert.deepEqual(new Set(result.selected.map(s => pool.find(c => c.key === s.key)!.task)), new Set(['coding', 'lookup'])); recompute(pool, result);
});

test('infeasible mandatory long input falls back explicitly without losing output count', () => {
  const pool = [candidate('rare', ['rare'], 10000, 'rare-task'), ...Array.from({ length: 30 }, (_, i) => candidate('short' + i, ['word' + i], 1))];
  const result = refinedSample(pool, 2);
  assert.equal(result.optimization.feasible, false); assert.equal(result.optimization.effectivePolicy, LEGACY_POLICY.version);
  assert.equal(result.optimization.fallbackReason, 'NO_FEASIBLE_CONSTRUCTION');
  assert.deepEqual(result.selected, sample(pool, 2, LEGACY_POLICY).selected); assert.equal(result.selected.length, 2); recompute(pool, result);
});

test('v6.1 accepts Unicode and zero lexical-token inputs without excluding valid punctuation', () => {
  const pool = ['！？', '中文 text text', 'é e\u0301', '🦊'].map((s, i) => ({ ...candidate(String(i), []), lexical: lexicalFeatures(s) }));
  const result = refinedSample(pool, 4); assert.equal(result.selected.length, 4); recompute(pool, result);
});

test('invalid configs and conflicting temporary features fail before selection', () => {
  const a = candidate('a', ['a']);
  for (const ratio of [NaN, Infinity, .99, 1.21]) assert.throws(() => refinedSample([a], 1, REFINED_POLICY, { budgetRatio: ratio }), /INVALID_CONFIG/);
  assert.throws(() => refinedSample([a], 0), /INVALID_CONFIG/);
  assert.throws(() => refinedSample([a], 1, { ...REFINED_POLICY, version: 'unknown' }), /INVALID_CONFIG/);
  assert.throws(() => refinedSample([a, a], 2), /SOURCE_CORRUPT/);
  assert.throws(() => refinedSample([a, candidate('b', ['b'], 1, 'unknown', 'a')], 2), /SOURCE_CORRUPT/);
  assert.throws(() => refinedSample([{ ...a, lexical: undefined }], 1), /SOURCE_CORRUPT/);
  assert.throws(() => refinedSample([], 1), /NO_VALID_SAMPLES/);
});

test('v6.1 yields during large feature processing and remains an explicit candidate', () => {
  const pool = [candidate('a', Array.from({ length: 6000 }, (_, i) => hash(i))), candidate('b', ['b'])];
  const steps = refinedSampleSteps(pool, 1); assert.equal(steps.next().done, false); steps.return(undefined as never);
  assert.equal(POLICY.version, 'trace-coverage-v4'); assert.deepEqual(sample(pool, 1), sample(pool, 1, LEGACY_POLICY));
});

test('optimized calculations replay v6 IDs when new search stages are disabled', async () => {
  const { budgetedSample } = await import('../src/lib/trace-datasets/sampling/budgeted');
  for (const seed of [42, 100, 101]) {
    const pool = Array.from({ length: 80 }, (_, i) => candidate('p' + i, Array.from({ length: 4 + i % 8 }, (_, j) => 't' + (i * 5 + j)), [20, 80, 140, 700][i % 4], ['coding', 'lookup', 'unknown'][i % 3]));
    for (const k of [5, 20, 60]) {
      const before = budgetedSample(pool, k, { ...REFINED_POLICY, version: 'trace-coverage-v6', seed });
      const after = refinedSample(pool, k, { ...REFINED_POLICY, seed }, { repair: false, efficiencySwaps: false });
      assert.deepEqual(after.selected.map(s => s.key), before.selected.map(s => s.key));
      assert.equal(after.optimization.vocabulary, before.optimization.vocabulary); recompute(pool, after);
    }
  }
});

test('constraint repair recovers a feasible sample rather than reporting the heuristic failure as infeasibility', () => {
  let state = 910;
  const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  let pool: Candidate[] = [];
  for (let trial = 0; trial <= 17; trial++) pool = Array.from({ length: 30 }, (_, i) => {
    const task = ['coding', 'lookup', 'unknown'][Math.floor(rand() * 3)], cost = [10, 30, 60, 200, 600][Math.floor(rand() * 5)];
    const terms = [...new Set(Array.from({ length: 2 + Math.floor(rand() * 8) }, () => 't' + Math.floor(rand() * 60)))];
    return { ...candidate(String(i), terms, cost, task), signature: new Uint32Array(128) };
  });
  const before = refinedSample(pool, 5, REFINED_POLICY, { repair: false, efficiencySwaps: false });
  const after = refinedSample(pool, 5);
  assert.equal(before.optimization.feasible, false); assert.equal(after.optimization.feasible, true);
  assert.ok(after.optimization.repairSwaps > 0); assert.equal(after.selected.length, 5); recompute(pool, after);
});

test('new efficiency search only accepts exact positive coverage changes under the same constraints', () => {
  const pool = Array.from({ length: 90 }, (_, i) => candidate(String(i), Array.from({ length: 5 + i % 15 }, (_, j) => 'word' + (i * 2 + j)), 20 + i % 65, i % 3 ? 'unknown' : 'coding'));
  for (const k of [10, 20, 50]) {
    const before = refinedSample(pool, k, REFINED_POLICY, { efficiencySwaps: false });
    const after = refinedSample(pool, k);
    assert.ok(after.optimization.vocabulary >= before.optimization.vocabulary); recompute(pool, after);
  }
  const malformed = [candidate('a', ['a', 'a', 'b'], 4), candidate('b', ['a', 'a', 'a'], 4, 'unknown', 'a')];
  assert.throws(() => refinedSample(malformed, 2), /SOURCE_CORRUPT/);
});

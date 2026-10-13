import test from 'node:test';
import assert from 'node:assert/strict';
import { NEIGHBORHOOD_POLICY, neighborhoodSample, neighborhoodSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-neighborhood';
import { COVERAGE_POLICY, LEGACY_POLICY, POLICY, hash, lexicalFeatures, sample, type Candidate } from '../src/lib/trace-datasets/sampling';

function candidate(key: string, terms: string[], cost = terms.length, task = 'unknown', inputKey = key, cells: string[] = []): Candidate {
  return { key, inputKey, task, lexical: { terms, tokenCount: cost }, signature: new Uint32Array(128).fill(key.charCodeAt(0)), paths: [{ key: 'path-' + key, cells, knownDimensions: cells.length }] };
}
function recompute(pool: Candidate[], result: ReturnType<typeof neighborhoodSample>) {
  const selected = result.selected.map(s => pool.find(c => c.key === s.key)!);
  assert.equal(new Set(selected.map(c => c.key)).size, selected.length);
  assert.equal(result.optimization.tokens, selected.reduce((n, c) => n + c.lexical!.tokenCount, 0));
  assert.equal(result.optimization.vocabulary, new Set(selected.flatMap(c => c.lexical!.terms)).size);
  assert.equal(result.counts.coveredCells, new Set(result.selected.flatMap(s => s.path.cells)).size);
  for (const s of result.selected) assert.ok(pool.find(c => c.key === s.key)!.paths.some(p => JSON.stringify(p) === JSON.stringify(s.path)));
  if (result.optimization.feasible) {
    assert.ok(result.optimization.tokens <= result.optimization.tokenBudget);
    assert.ok(result.optimization.lengthTV <= result.optimization.lengthLimit + 1e-9);
    assert.ok(result.optimization.taskTV <= result.optimization.taskLimit + 1e-9);
  }
}

test('v6.3 replaces a greedy combination with more vocabulary at lower cost', () => {
  const pool = [candidate('A', ['a', 'b', 'c', 'd']), candidate('B', ['a', 'b', 'e']), candidate('C', ['c', 'd', 'f'])];
  const before = neighborhoodSample(pool, 2, NEIGHBORHOOD_POLICY, { swaps: false, restarts: false });
  const after = neighborhoodSample(pool, 2, NEIGHBORHOOD_POLICY, { restarts: false });
  assert.equal(before.optimization.vocabulary, 5); assert.equal(after.optimization.vocabulary, 6);
  assert.equal(after.optimization.tokens, 6); assert.ok(after.optimization.oneSwaps > 0);
  assert.deepEqual(new Set(after.selected.map(s => s.key)), new Set(['B', 'C'])); recompute(pool, after);
});

test('v6.3 keeps deterministic results, exact count and honest global costs across order and seeds', () => {
  const pool = Array.from({ length: 50 }, (_, i) => candidate(String(i), Array.from({ length: 4 + i % 9 }, (_, j) => 't' + (i * 3 + j)), 8 + i % 50, ['coding', 'lookup', 'unknown'][i % 3]));
  for (const seed of [42, 200, 201]) for (const k of [1, 2, 8, 20, 100]) {
    const p = { ...NEIGHBORHOOD_POLICY, seed }, result = neighborhoodSample(pool, k, p);
    assert.deepEqual(result, neighborhoodSample([...pool].reverse(), k, p));
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
  const one = neighborhoodSample(pool, 4, NEIGHBORHOOD_POLICY, { restarts: false, pairSwaps: false, budgetBridge: false, neighborhood: false });
  const pair = neighborhoodSample(pool, 4, NEIGHBORHOOD_POLICY, { restarts: false });
  assert.equal(one.optimization.vocabulary, 17); assert.equal(pair.optimization.vocabulary, 18);
  assert.ok(pair.optimization.pairSwaps > 0); assert.ok(pair.optimization.tokens <= one.optimization.tokens);
  recompute(pool, pair);
});

test('answer variants cannot inflate the input-group budget and repeated inputs still consume tokens', () => {
  const pool = [candidate('a', ['a'], 10), candidate('b', ['b'], 30), ...Array.from({ length: 6 }, (_, i) => candidate('v' + i, ['b'], 30, 'unknown', 'b'))];
  for (const k of [2, 5, 20]) {
    const result = neighborhoodSample(pool, k);
    assert.equal(result.optimization.baseTokens, Math.min(k, pool.length) * 20); recompute(pool, result);
    assert.equal(result.selected.length, Math.min(k, pool.length));
  }
});

test('task floors and real behavior paths survive swaps without inventing paths', () => {
  const pool = Array.from({ length: 30 }, (_, i) => candidate('c' + i, ['shared', 'word' + i], 4, i % 2 ? 'coding' : 'lookup', 'input' + i, i % 5 === 0 ? ['tool:' + i, 'retry'] : []));
  const old = sample(pool, 12, COVERAGE_POLICY), result = neighborhoodSample(pool, 12);
  const protectedCells = new Set(old.selected.filter(s => ['task_floor', 'behavior'].includes(s.reason)).flatMap(s => s.path.cells));
  const actual = new Set(result.selected.flatMap(s => s.path.cells));
  for (const cell of protectedCells) assert.ok(actual.has(cell));
  assert.deepEqual(new Set(result.selected.map(s => pool.find(c => c.key === s.key)!.task)), new Set(['coding', 'lookup'])); recompute(pool, result);
});

test('infeasible mandatory long input falls back explicitly without losing output count', () => {
  const pool = [candidate('rare', ['rare'], 10000, 'rare-task'), ...Array.from({ length: 30 }, (_, i) => candidate('short' + i, ['word' + i], 1))];
  const result = neighborhoodSample(pool, 2);
  assert.equal(result.optimization.feasible, false); assert.equal(result.optimization.effectivePolicy, LEGACY_POLICY.version);
  assert.equal(result.optimization.fallbackReason, 'NO_FEASIBLE_CONSTRUCTION');
  assert.deepEqual(result.selected, sample(pool, 2, LEGACY_POLICY).selected); assert.equal(result.selected.length, 2); recompute(pool, result);
});

test('v6.3 accepts Unicode and zero lexical-token inputs without excluding valid punctuation', () => {
  const pool = ['！？', '中文 text text', 'é e\u0301', '🦊'].map((s, i) => ({ ...candidate(String(i), []), lexical: lexicalFeatures(s) }));
  const result = neighborhoodSample(pool, 4); assert.equal(result.selected.length, 4); recompute(pool, result);
});

test('invalid configs and conflicting temporary features fail before selection', () => {
  const a = candidate('a', ['a']);
  for (const ratio of [NaN, Infinity, .99, 1.21]) assert.throws(() => neighborhoodSample([a], 1, NEIGHBORHOOD_POLICY, { budgetRatio: ratio }), /INVALID_CONFIG/);
  assert.throws(() => neighborhoodSample([a], 0), /INVALID_CONFIG/);
  assert.throws(() => neighborhoodSample([a], 1, { ...NEIGHBORHOOD_POLICY, version: 'unknown' }), /INVALID_CONFIG/);
  assert.throws(() => neighborhoodSample([a, a], 2), /SOURCE_CORRUPT/);
  assert.throws(() => neighborhoodSample([a, candidate('b', ['b'], 1, 'unknown', 'a')], 2), /SOURCE_CORRUPT/);
  assert.throws(() => neighborhoodSample([{ ...a, lexical: undefined }], 1), /SOURCE_CORRUPT/);
  assert.throws(() => neighborhoodSample([], 1), /NO_VALID_SAMPLES/);
});

test('v6.3 yields during large feature processing and remains an explicit candidate', () => {
  const pool = [candidate('a', Array.from({ length: 6000 }, (_, i) => hash(i))), candidate('b', ['b'])];
  const steps = neighborhoodSampleSteps(pool, 1); assert.equal(steps.next().done, false); steps.return(undefined as never);
  assert.equal(POLICY.version, 'trace-coverage-v4'); assert.deepEqual(sample(pool, 1), sample(pool, 1, LEGACY_POLICY));
});

test('disabled additions replay v6 IDs when new search stages are disabled', async () => {
  const { budgetedSample } = await import('../src/lib/trace-datasets/sampling/budgeted');
  for (const seed of [42, 100, 101]) {
    const pool = Array.from({ length: 80 }, (_, i) => candidate('p' + i, Array.from({ length: 4 + i % 8 }, (_, j) => 't' + (i * 5 + j)), [20, 80, 140, 700][i % 4], ['coding', 'lookup', 'unknown'][i % 3]));
    for (const k of [5, 20, 60]) {
      const before = budgetedSample(pool, k, { ...NEIGHBORHOOD_POLICY, version: 'trace-coverage-v6', seed });
      const after = neighborhoodSample(pool, k, { ...NEIGHBORHOOD_POLICY, seed }, { repair: false, efficiencySwaps: false, upperBound: false, budgetBridge: false, pricedStarts: false, neighborhood: false });
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
  const before = neighborhoodSample(pool, 5, NEIGHBORHOOD_POLICY, { repair: false, efficiencySwaps: false, upperBound: false, budgetBridge: false, pricedStarts: false, neighborhood: false });
  const after = neighborhoodSample(pool, 5);
  assert.equal(before.optimization.feasible, false); assert.equal(after.optimization.feasible, true);
  assert.ok(after.optimization.repairSwaps > 0); assert.equal(after.selected.length, 5); recompute(pool, after);
});

test('new efficiency search only accepts exact positive coverage changes under the same constraints', () => {
  const pool = Array.from({ length: 90 }, (_, i) => candidate(String(i), Array.from({ length: 5 + i % 15 }, (_, j) => 'word' + (i * 2 + j)), 20 + i % 65, i % 3 ? 'unknown' : 'coding'));
  for (const k of [10, 20, 50]) {
    const before = neighborhoodSample(pool, k, NEIGHBORHOOD_POLICY, { efficiencySwaps: false });
    const after = neighborhoodSample(pool, k);
    assert.ok(after.optimization.vocabulary >= before.optimization.vocabulary); recompute(pool, after);
  }
  const malformed = [candidate('a', ['a', 'a', 'b'], 4), candidate('b', ['a', 'a', 'a'], 4, 'unknown', 'a')];
  assert.throws(() => neighborhoodSample(malformed, 2), /SOURCE_CORRUPT/);
});


test('coverage upper bound caps all subsets and terminates a saturated feasible search', () => {
  const pool = Array.from({ length: 18 }, (_, i) => candidate('bound' + i, ['shared', 'unique' + i], 2));
  for (const k of [1, 5, 12, 30]) {
    const r = neighborhoodSample(pool, k);
    assert.equal(r.optimization.coverageUpperBound, 1 + Math.min(k, pool.length));
    assert.equal(r.optimization.vocabulary, r.optimization.coverageUpperBound);
    assert.equal(r.optimization.evaluated, 1);
    assert.equal(r.optimization.bridgeAttempts, 0);
    recompute(pool, r);
  }
});

test('temporary budget-saving exchanges preserve or improve the original feasible coverage', async () => {
  const { refinedSample } = await import('../src/lib/trace-datasets/sampling/budgeted-refined');
  let rand = 917;
  const next = () => { rand = (Math.imul(rand, 1664525) + 1013904223) >>> 0; return rand / 4294967296; };
  for (let run = 0; run < 25; run++) {
    const pool = Array.from({ length: 36 }, (_, i) => candidate('p' + i, [...new Set(Array.from({ length: 3 + Math.floor(next() * 9) }, () => 't' + Math.floor(next() * 70)))], 14 + Math.floor(next() * 60)));
    const before = refinedSample(pool, 8), after = neighborhoodSample(pool, 8);
    if (before.optimization.feasible) {
      assert.ok(after.optimization.feasible);
      assert.ok(after.optimization.vocabulary >= before.optimization.vocabulary);
    }
    assert.deepEqual(after, neighborhoodSample([...pool].reverse(), 8));
    recompute(pool, after);
  }
});

test('coverage bound dominates exhaustive subsets even with repeated inputs', () => {
  const pool = Array.from({ length: 8 }, (_, i) => candidate('e' + i, ['shared', 'a' + i % 3, 'b' + i], 7));
  pool.push({ ...pool[0], key: 'answer-variant' });
  for (const k of [1, 3, 7]) {
    const result = neighborhoodSample(pool, k);
    for (let mask = 0; mask < 1 << pool.length; mask++) {
      const subset = pool.filter((_, i) => mask & (1 << i));
      if (subset.length > k) continue;
      assert.ok(new Set(subset.flatMap(p => p.lexical!.terms)).size <= result.optimization.coverageUpperBound);
    }
  }
});

test('rejected budget bridges restore real path coverage and counts', () => {
  let random = 105;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 4294967296; };
  let rejected = 0;
  for (let run = 0; run < 12; run++) {
    const pool = Array.from({ length: 32 }, (_, i) => {
      const c = candidate('path' + i, [...new Set(Array.from({ length: 3 + Math.floor(next() * 7) }, () => 't' + Math.floor(next() * 45)))], 12 + Math.floor(next() * 50));
      c.paths = [{ key: 'first' + i, cells: ['tool:' + i % 3], knownDimensions: 1 }, { key: 'second' + i, cells: ['tool:' + (i + 1) % 3, 'retry'], knownDimensions: 2 }];
      return c;
    });
    const result = neighborhoodSample(pool, 8);
    rejected += result.optimization.bridgeAttempts - result.optimization.bridgeAccepted;
    recompute(pool, result);
    assert.deepEqual(result, neighborhoodSample([...pool].reverse(), 8));
  }
  assert.ok(rejected > 0);
});


test('FAST preserves v6.2 IDs, real paths and metrics even when lexical term order changes', async () => {
  const { exchangeSample, EXCHANGE_POLICY } = await import('../src/lib/trace-datasets/sampling/budgeted-exchange');
  for (const seed of [42, 100, 201]) {
    const pool = Array.from({ length: 65 }, (_, i) => candidate('n' + i, Array.from({ length: 2 + i % 15 }, (_, j) => 't' + (i * 2 + j)), [20, 80, 140, 700][i % 4], ['coding', 'lookup', 'unknown'][i % 3], 'n' + i, i % 5 === 0 ? ['tool:' + i % 3] : []));
    for (const k of [2, 12, 35, 80]) {
      const before = exchangeSample(pool, k, { ...EXCHANGE_POLICY, seed });
      const after = neighborhoodSample(pool, k, { ...NEIGHBORHOOD_POLICY, seed }, { neighborhood: false });
      assert.deepEqual(after.selected, before.selected);
      assert.equal(after.optimization.vocabulary, before.optimization.vocabulary);
      assert.deepEqual(after, neighborhoodSample([...pool].reverse().map(c => ({ ...c, lexical: { ...c.lexical!, terms: [...c.lexical!.terms].reverse() } })), k, { ...NEIGHBORHOOD_POLICY, seed }, { neighborhood: false }));
      recompute(pool, after);
    }
  }
});

test('neighborhood candidates preserve the feasible incumbent and its task/path floors', () => {
  let random = 511;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 4294967296; };
  let accepted = 0, rejected = 0;
  for (let run = 0; run < 25; run++) {
    const pool = Array.from({ length: 45 }, (_, i) => candidate('n' + i, [...new Set(Array.from({ length: 3 + Math.floor(next() * 12) }, () => 't' + Math.floor(next() * 80)))], 20 + Math.floor(next() * 65), ['coding', 'lookup', 'unknown'][i % 3], 'n' + i, i % 7 === 0 ? ['tool:' + i % 3] : []));
    const before = neighborhoodSample(pool, 12, NEIGHBORHOOD_POLICY, { neighborhood: false });
    const result = neighborhoodSample(pool, 12);
    if (before.optimization.feasible) {
      assert.ok(result.optimization.feasible);
      assert.ok(result.optimization.vocabulary >= before.optimization.vocabulary);
    }
    const baseline = sample(pool, 12, COVERAGE_POLICY);
    const cells = new Set(result.selected.flatMap(s => s.path.cells));
    for (const c of baseline.selected.filter(s => ['task_floor', 'behavior'].includes(s.reason)).flatMap(s => s.path.cells)) assert.ok(cells.has(c));
    accepted += result.optimization.neighborhoodAccepted;
    rejected += result.optimization.neighborhoodAttempts - result.optimization.neighborhoodAccepted;
    assert.ok(result.optimization.neighborhoodAttempts <= 18);
    recompute(pool, result);
  }
  assert.ok(accepted > 0); assert.ok(rejected > 0);
});

test('a saturated baseline skips the search index while inconsistent repeated features are still rejected', () => {
  const pool = Array.from({ length: 30 }, (_, i) => candidate('s' + i, ['common', 'unique' + i], 2));
  const result = neighborhoodSample(pool, 10);
  assert.equal(result.optimization.searchIndexBuilt, false);
  assert.equal(result.optimization.neighborhoodAttempts, 0);
  assert.equal(result.optimization.vocabulary, 11);
  pool.push({ ...pool[0], key: 'bad', lexical: { terms: ['common', 'other'], tokenCount: 2 } });
  assert.throws(() => neighborhoodSample(pool, 10), /SOURCE_CORRUPT/);
});

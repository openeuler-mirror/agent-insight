import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETE_POLICY, completeSample, completeSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-complete';
import { NEIGHBORHOOD_POLICY, neighborhoodSample } from '../src/lib/trace-datasets/sampling/budgeted-neighborhood';
import { COVERAGE_POLICY, LEGACY_POLICY, POLICY, sample, type Candidate } from '../src/lib/trace-datasets/sampling';

const candidate = (key: string, terms: string[], cost = terms.length, task = 'unknown', inputKey = key): Candidate => ({ key, inputKey, task, lexical: { terms, tokenCount: cost }, signature: new Uint32Array(128), paths: [{ key: `path-${key}`, cells: [], knownDimensions: 0 }] });
function verify(pool: Candidate[], result: ReturnType<typeof completeSample>) {
  const chosen = result.selected.map(s => pool.find(c => c.key === s.key)!);
  assert.equal(new Set(chosen.map(c => c.key)).size, chosen.length);
  assert.equal(result.optimization.tokens, chosen.reduce((n, c) => n + c.lexical!.tokenCount, 0));
  assert.equal(result.optimization.vocabulary, new Set(chosen.flatMap(c => c.lexical!.terms)).size);
  assert.equal(result.counts.coveredCells, new Set(result.selected.flatMap(s => s.path.cells)).size);
  for (const s of result.selected) assert.ok(pool.find(c => c.key === s.key)!.paths.some(p => JSON.stringify(p) === JSON.stringify(s.path)));
  if (result.optimization.feasible) {
    assert.ok(result.optimization.tokens <= result.optimization.tokenBudget);
    assert.ok(result.optimization.lengthTV <= result.optimization.lengthLimit + 1e-9);
    assert.ok(result.optimization.taskTV <= result.optimization.taskLimit + 1e-9);
  }
}
let random = 19371;
const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 2 ** 32; };
const pool = (n: number) => Array.from({ length: n }, (_, i) => candidate(`p${i}`, [...new Set(Array.from({ length: 2 + Math.floor(next() * 9) }, () => `t${Math.floor(next() * 60)}`))], 12 + Math.floor(next() * 19)));

test('disabled complete exchange replays v6.3 IDs, paths and counts across seeds and input order', () => {
  const rows = pool(48);
  for (const seed of [42, 100, 103]) for (const k of [1, 8, 20, 50]) {
    const old = neighborhoodSample(rows, k, { ...NEIGHBORHOOD_POLICY, seed });
    const replay = completeSample(rows, k, { ...COMPLETE_POLICY, seed }, { completeExchange: false });
    assert.deepEqual(replay.selected, old.selected); assert.deepEqual(replay.counts, old.counts);
    const result = completeSample(rows, k, { ...COMPLETE_POLICY, seed });
    assert.deepEqual(result, completeSample([...rows].reverse(), k, { ...COMPLETE_POLICY, seed }));
    if (old.optimization.feasible) assert.ok(result.optimization.vocabulary >= old.optimization.vocabulary);
    assert.equal(result.selected.length, Math.min(k, rows.length)); verify(rows, result);
  }
});

test('all feasible one-input replacements are exhausted when the solver reports a local optimum', () => {
  let checked = 0, swaps = 0, plateau = 0;
  for (let run = 0; run < 32; run++) {
    const rows = pool(28), result = completeSample(rows, 8);
    verify(rows, result); swaps += result.optimization.completeSwaps; plateau += result.optimization.plateauSwaps;
    if (result.optimization.completeStopped !== 'one_swap_local_optimum') continue;
    checked++;
    const chosen = rows.filter(c => result.selected.some(s => s.key === c.key));
    for (const incoming of rows.filter(c => !chosen.includes(c))) for (const outgoing of chosen) {
      const trial = [...chosen.filter(c => c !== outgoing), incoming];
      const cost = trial.reduce((n, c) => n + c.lexical!.tokenCount, 0);
      if (cost > result.optimization.tokenBudget) continue;
      const coverage = new Set(trial.flatMap(c => c.lexical!.terms)).size;
      assert.ok(coverage < result.optimization.vocabulary || (coverage === result.optimization.vocabulary && cost >= result.optimization.tokens));
    }
  }
  assert.ok(checked > 0); assert.ok(swaps > 0); assert.ok(plateau > 0);
});

test('saturated coverage may still save cost, while equal-cost plateau moves are rejected', () => {
  const rows = [candidate('expensive', ['a', 'b'], 20), candidate('cheap', ['a', 'b'], 2), candidate('other', ['c'], 2)];
  const result = completeSample(rows, 2);
  assert.equal(result.optimization.vocabulary, 3); assert.equal(result.optimization.tokens, 4); verify(rows, result);
  const flat = Array.from({ length: 30 }, (_, i) => candidate(`s${i}`, ['shared'], 1));
  const equal = completeSample(flat, 5); assert.equal(equal.optimization.completeSwaps, 0);
  assert.equal(equal.optimization.searchIndexBuilt, false); verify(flat, equal);
});

test('original mandatory task coverage and real path floors survive complete replacements', () => {
  const rows = pool(48).map((c, i) => ({ ...c, task: i % 3 === 0 ? 'coding' : 'lookup', paths: [{ key: `first${i}`, cells: [`tool:${i % 4}`], knownDimensions: 1 }, { key: `second${i}`, cells: [`retry:${i % 2}`], knownDimensions: 1 }] }));
  const initial = sample(rows, 12, COVERAGE_POLICY), result = completeSample(rows, 12);
  const required = initial.selected.filter(s => s.reason === 'task_floor' || s.reason === 'behavior');
  const actual = new Set(result.selected.flatMap(s => s.path.cells));
  for (const cell of required.flatMap(s => s.path.cells)) assert.ok(actual.has(cell));
  for (const pick of required.filter(s => s.reason === 'task_floor')) {
    const task = rows.find(c => c.key === pick.key)!.task;
    assert.ok(result.selected.some(s => rows.find(c => c.key === s.key)!.task === task));
  }
  verify(rows, result);
});

test('input variants neither multiply the budget nor stop count completion', () => {
  const rows = [candidate('a', ['shared', 'a'], 4), candidate('b', ['shared', 'b'], 12), ...Array.from({ length: 5 }, (_, i) => candidate(`v${i}`, ['shared', 'b'], 12, 'unknown', 'b'))];
  for (const k of [2, 5, 20]) {
    const result = completeSample(rows, k);
    assert.equal(result.optimization.baseTokens, Math.min(k, rows.length) * 8);
    assert.equal(result.selected.length, Math.min(k, rows.length)); verify(rows, result);
  }
});

test('an impossible mandatory budget remains an explicit v4 fallback', () => {
  const rows = [candidate('rare', ['rare'], 10000, 'rare-task'), ...Array.from({ length: 30 }, (_, i) => candidate(`short${i}`, [`w${i}`], 1))];
  const result = completeSample(rows, 2);
  assert.equal(result.optimization.feasible, false); assert.equal(result.optimization.effectivePolicy, LEGACY_POLICY.version);
  assert.deepEqual(result.selected, sample(rows, 2, LEGACY_POLICY).selected); verify(rows, result);
});

test('temporary features are validated and v4 remains the default', () => {
  const row = candidate('a', ['a']);
  assert.throws(() => completeSample([row], 1, { ...COMPLETE_POLICY, version: 'unknown' }), /INVALID_CONFIG/);
  assert.throws(() => completeSample([row, row], 2), /SOURCE_CORRUPT/);
  assert.throws(() => completeSample([row, candidate('b', ['b'], 1, 'unknown', 'a')], 2), /SOURCE_CORRUPT/);
  assert.equal(POLICY.version, 'trace-coverage-v4');
});

test('complete sampling yields and can be cancelled without modifying the caller data', () => {
  const rows = pool(300), before = JSON.stringify(rows), steps = completeSampleSteps(rows, 20);
  assert.equal(steps.next().done, false); steps.return(undefined as never);
  assert.equal(JSON.stringify(rows), before);
});
